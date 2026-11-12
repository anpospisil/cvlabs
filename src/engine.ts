// CV Labs GTM prototype: replay inbound events -> people, service inquiries, tasks, SMS.
// All business rules live in POLICY so a live change is a one-line edit.

export const POLICY = {
  smsAfterOutcomes: ["voicemail_left"],
  stopKeywords: ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"],
  window: { start: "09:00", end: "18:00" }, // recipient local time
  unclearMatchToReview: true, // email and phone point to different people -> review, no owner
  reuseExistingOwnerForNewService: true, // different-service return: keep the person's rep if eligible + available
  coverWhenOwnerUnavailable: true, // false -> escalate to manager instead
  smsSender: "+12025550180", // Close number; RingCentral number has no confirmed SMS
  manager: "SALES_MANAGER",
  reviewQueue: "REVIEW_QUEUE",
};
export type Policy = typeof POLICY;

const STATUS_RANK: Record<string, number> = { created: 0, queued: 1, accepted: 2, sent: 3, delivered: 4, failed: 4 };
const TERMINAL = new Set(["delivered", "failed"]);

export type Rep = { id: string; name: string; available: boolean; assigned_today: number; eligible_service_units: string[] };
export type Person = { id: string; name: string; email: string | null; phone: string | null; timezone: string | null; sms_permission: string; legacy_lead_id?: string };
export type Entry = { at: string; event: string; text: string };
export type SmsDecision = { attempt: string; at: string; sent: boolean; reason: string };
export type Inquiry = {
  id: string; person_id: string | null; service: string; owner_id: string | null; covering_id: string | null;
  status: "open" | "needs_review" | "queued"; submissions: string[]; history: Entry[];
  calls: any[]; sms_decisions: SmsDecision[]; contact?: any;
};
export type Task = { id: string; kind: string; inquiry_id: string; assignee: string; issue: string; next_action: string; status: "open" | "done"; created_at: string; key?: string };
export type Message = { id: string; inquiry_id: string; to: string; from: string; call_attempt_id: string; body: string; state: string; error: string | null; history: any[] };

// ---------- normalization ----------
export const normEmail = (e?: string | null) => (e ?? "").trim().toLowerCase() || null;
export function normPhone(p?: string | null, country = "US"): string | null {
  if (!p) return null;
  let d = p.replace(/\D/g, "");
  if (d.length === 10 && (country === "US" || country === "CA")) d = "1" + d;
  return d.length === 11 && d.startsWith("1") ? "+" + d : null; // NANP only for this exercise
}
export function localHHMM(tz: string, iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

export class Engine {
  reps: Record<string, Rep> = {};
  persons: Record<string, Person> = {};
  inquiries: Record<string, Inquiry> = {};
  tasks: Task[] = [];
  messages: Record<string, Message> = {};
  suppressed: Record<string, string> = {}; // phone -> STOP occurred_at
  log: Entry[] = [];
  private seen = new Set<string>();
  private byLead: Record<string, string> = {}; // legacy lead id -> person id
  private bySubmission: Record<string, string> = {}; // submission id -> inquiry id
  private fixtureMsgIds: Record<string, string> = {}; // call attempt -> fixture message id
  private template: string;
  private seq = 0;

  private data: any;
  private policy: Policy;

  constructor(data: any, policy: Policy = POLICY) {
    this.data = data; this.policy = policy;
    for (const r of data.reps) this.reps[r.id] = { ...r };
    this.template = data.contact_policy.approved_sms_template;
    for (const e of data.events) if (e.type === "sms.status") this.fixtureMsgIds[e.related_call_attempt_id] = e.message_id;
    for (const l of data.existing_leads) {
      const pid = "P-" + l.id;
      this.persons[pid] = { id: pid, name: l.name, email: normEmail(l.email), phone: normPhone(l.phone), timezone: l.timezone, sms_permission: l.sms_permission, legacy_lead_id: l.id };
      this.byLead[l.id] = pid;
      this.newInquiry(pid, l.service, l.owner_id, "open", l.id);
    }
  }

  // upto: replay only the first N events (used by the UI step-through)
  run(upto = Infinity): this {
    for (const e of this.data.events.slice(0, upto)) {
      if (this.seen.has(e.event_id)) { this.note(e, `Ignored redelivery of ${e.event_id} (already processed)`); continue; }
      this.seen.add(e.event_id);
      const handler = ({ "form.submitted": this.onForm, "call.finished": this.onCall, "sms.status": this.onSmsStatus, "sms.received": this.onSmsReceived } as any)[e.type];
      if (handler) handler.call(this, e); else this.note(e, `Unknown event type ${e.type}`);
    }
    return this;
  }

  // ---------- helpers ----------
  private note(e: any, text: string, inq?: Inquiry) {
    const entry = { at: e.received_at, event: e.event_id, text };
    this.log.push(entry);
    inq?.history.push(entry);
  }
  private newInquiry(pid: string | null, service: string, owner: string | null, status: Inquiry["status"], id?: string): Inquiry {
    const q: Inquiry = { id: id ?? `Q${String(++this.seq).padStart(3, "0")}`, person_id: pid, service, owner_id: owner, covering_id: null, status, submissions: [], history: [], calls: [], sms_decisions: [] };
    this.inquiries[q.id] = q;
    return q;
  }
  private task(kind: string, inq: Inquiry, assignee: string, issue: string, next_action: string, at: string, key?: string): Task | null {
    if (key && this.tasks.some(t => t.key === key)) return null; // idempotent
    const t: Task = { id: `T${String(this.tasks.length + 1).padStart(3, "0")}`, kind, inquiry_id: inq.id, assignee, issue, next_action, status: "open", created_at: at, key };
    this.tasks.push(t);
    return t;
  }
  openTasks(inq: Inquiry, kind?: string) { return this.tasks.filter(t => t.inquiry_id === inq.id && t.status === "open" && (!kind || t.kind === kind)); }
  private pick(service: string): { id: string | null; why: string } {
    const c = Object.values(this.reps).filter(r => r.available && r.eligible_service_units.includes(service))
      .sort((a, b) => a.assigned_today - b.assigned_today || a.id.localeCompare(b.id));
    const list = c.map(r => `${r.id}=${r.assigned_today}`).join(", ");
    return c.length ? { id: c[0].id, why: `least assigned_today among eligible+available [${list}]` } : { id: null, why: `no eligible+available rep for ${service}` };
  }
  private assign(repId: string) { this.reps[repId].assigned_today += 1; }
  private inWindow(p: Person, iso: string): boolean | null {
    if (!p.timezone) return null;
    const t = localHHMM(p.timezone, iso);
    return t >= this.policy.window.start && t < this.policy.window.end;
  }
  private callTask(inq: Inquiry, rep: string, at: string, note: string) {
    const p = this.persons[inq.person_id!];
    const tz = p.timezone ? "" : " Timezone unknown: confirm local time before calling; no automated SMS until confirmed.";
    this.task("first_call", inq, rep, `New ${inq.service} inquiry from ${p.name}. ${note}`, `Call ${p.name} at ${p.phone}.${tz}`, at);
  }

  // ---------- A + B: match and route ----------
  private onForm(e: any) {
    const c = e.contact, sid = e.submission_id, svc = e.service, at = e.received_at;
    const email = normEmail(c.email), phone = normPhone(c.phone, c.phone_country);
    const all = Object.values(this.persons);
    const emailHit = email ? all.find(p => p.email === email) : undefined;
    const phoneHits = phone ? all.filter(p => p.phone === phone) : [];
    let person = emailHit, why = "", conflict = "";

    if (emailHit) {
      const others = phoneHits.filter(p => p.id !== emailHit.id);
      if (phone !== emailHit.phone && others.length) conflict = `email matches ${emailHit.name} (${emailHit.id}) but phone ${phone} belongs to ${others.map(p => `${p.name} (${p.id})`).join(", ")}`;
      else why = `email match -> ${emailHit.id}` + (phone === emailHit.phone ? " (phone also matches)" : `; submitted phone ${phone} differs, not saved until confirmed`);
    } else if (phoneHits.length) {
      conflict = `new email ${email} but phone ${phone} belongs to ${phoneHits.map(p => `${p.name} (${p.id})`).join(", ")}`;
    }

    if (conflict && this.policy.unclearMatchToReview) {
      const q = this.newInquiry(null, svc, null, "needs_review");
      q.contact = { ...c, email, phone, sms_permission: e.sms_permission ?? "unknown" };
      q.submissions.push(sid); this.bySubmission[sid] = q.id;
      this.note(e, `${sid} (${c.name}, ${svc}): UNCLEAR MATCH - ${conflict}. No owner assigned.`, q);
      this.task("match_review", q, this.policy.reviewQueue, `Unclear match for ${c.name}: ${conflict}.`,
        "Verify identity with the submitter without disclosing the other record; then link to the existing person or create a new one and route.", at, "match:" + sid);
      return;
    }

    if (!person) {
      const pid = `P${String(Object.keys(this.persons).length + 1).padStart(3, "0")}`;
      person = { id: pid, name: c.name, email, phone, timezone: c.timezone ?? null, sms_permission: e.sms_permission ?? "unknown" };
      this.persons[pid] = person;
      why = `no email/phone match -> new person ${pid}`;
    } else if (e.sms_permission) {
      person.sms_permission = e.sms_permission; // omission = no new information
    }

    const p = person;
    const existing = Object.values(this.inquiries).find(q => q.person_id === p.id && q.service === svc && q.status !== "needs_review");
    if (existing) {
      existing.submissions.push(sid); this.bySubmission[sid] = existing.id;
      this.note(e, `${sid}: ${why}; same-service return -> existing inquiry ${existing.id}`, existing);
      if (this.openTasks(existing, "first_call").length) { this.note(e, "First-call task already open; no duplicate task created", existing); return; }
      return this.routeReturning(existing, e);
    }

    const prior = Object.values(this.inquiries).filter(q => q.person_id === p.id);
    const q = this.newInquiry(p.id, svc, null, "open");
    q.submissions.push(sid); this.bySubmission[sid] = q.id;
    this.note(e, `${sid}: ${why}; ${prior.length ? `different service (existing: ${prior.map(x => `${x.service}/${x.owner_id}`).join(", ")} kept unchanged)` : "new inquiry"} -> ${q.id}`, q);
    this.routeNew(q, prior, e);
  }

  private routeNew(q: Inquiry, prior: Inquiry[], e: any) {
    let chosen: string | null = null, why = "";
    if (this.policy.reuseExistingOwnerForNewService) {
      for (const x of prior) {
        const r = x.owner_id ? this.reps[x.owner_id] : undefined;
        if (r && r.available && r.eligible_service_units.includes(q.service)) { chosen = r.id; why = `existing owner ${r.id} is eligible for ${q.service} and available -> reused for continuity`; break; }
      }
    }
    if (!chosen) {
      const pk = this.pick(q.service);
      chosen = pk.id;
      why = (prior.length ? `existing owner(s) ${prior.map(x => x.owner_id).join(", ")} not eligible/available for ${q.service}; ` : "") + pk.why;
    }
    if (!chosen) return this.escalate(q, e, why);
    q.owner_id = chosen; this.assign(chosen);
    this.note(e, `Owner ${chosen}: ${why}`, q);
    this.callTask(q, chosen, e.received_at, `Assigned to you (${why.split(" [")[0]}).`);
  }

  private routeReturning(q: Inquiry, e: any) {
    const owner = this.reps[q.owner_id!];
    if (owner.available) {
      this.note(e, `Existing owner ${owner.id} kept (available)`, q);
      return this.callTask(q, owner.id, e.received_at, `Returning ${q.service} lead; you are the existing owner.`);
    }
    if (!this.policy.coverWhenOwnerUnavailable) return this.escalate(q, e, `owner ${owner.id} unavailable`);
    const pk = this.pick(q.service);
    if (!pk.id) return this.escalate(q, e, `owner ${owner.id} unavailable and ${pk.why}`);
    q.covering_id = pk.id; this.assign(pk.id);
    this.note(e, `Owner ${owner.id} unavailable -> stays owner; ${pk.id} covers first call (${pk.why}); ${owner.id} notified`, q);
    this.callTask(q, pk.id, e.received_at, `COVERING for ${owner.id} (unavailable). ${owner.id} remains the relationship owner; log notes for handback.`);
    this.task("coverage_notice", q, owner.id, `${pk.id} is covering the first call on your returning ${q.service} lead while you are unavailable.`, "Review the call notes on return; ownership unchanged.", e.received_at);
  }

  private escalate(q: Inquiry, e: any, why: string) {
    q.status = "queued";
    this.note(e, `ESCALATED: ${why}. Queued for ${q.service}; not assigned to an ineligible rep.`, q);
    this.task("escalation", q, this.policy.manager, `No eligible available rep: ${why}.`, `Assign an eligible ${q.service} rep or approve coverage; inquiry is waiting in the ${q.service} queue.`, e.received_at, "esc:" + q.id);
  }

  // ---------- C: calls and SMS decision ----------
  private resolveRef(e: any): Inquiry | undefined {
    const ref = e.lead_reference ?? {};
    if (ref.submission_id) return this.inquiries[this.bySubmission[ref.submission_id]];
    if (ref.lead_id) {
      const pid = this.byLead[ref.lead_id];
      return Object.values(this.inquiries).find(q => q.person_id === pid && q.service === e.service) ?? this.inquiries[ref.lead_id];
    }
  }

  private onCall(e: any) {
    const q = this.resolveRef(e);
    if (!q || !q.person_id) { this.note(e, `Call ${e.attempt_id} could not be matched to an inquiry`); return; }
    const p = this.persons[q.person_id];
    const caller = q.covering_id ?? q.owner_id!; // GAP: events carry no rep id
    q.calls.push({ attempt: e.attempt_id, interaction: e.interaction_id, provider: e.provider, status: e.provider_status, outcome: e.business_outcome, at: e.occurred_at, by: caller });
    this.note(e, `Call ${e.attempt_id} (${e.provider}, interaction ${e.interaction_id}) by ${caller}: ${e.provider_status}${e.business_outcome ? " / " + e.business_outcome : ""}`, q);

    if (this.inWindow(p, e.occurred_at) === false)
      this.note(e, `WARNING: call placed at ${localHHMM(p.timezone!, e.occurred_at)} recipient local time, outside ${this.policy.window.start}-${this.policy.window.end}`, q);

    if (e.provider_status === "completed") {
      for (const t of this.openTasks(q, "first_call")) t.status = "done";
      const next = e.business_outcome === "voicemail_left" ? "Call again next business day inside the contact window." : "Log conversation notes and set the next step.";
      this.task("follow_up", q, caller, `Call ${e.attempt_id}: ${e.business_outcome}.`, next, e.received_at, "fu:" + e.interaction_id + ":" + e.attempt_id);
    } else {
      this.note(e, `Call not connected (${e.provider_status}); first-call task stays open - retry.`, q);
    }
    this.smsDecision(e, q, p, caller);
  }

  private smsDecision(e: any, q: Inquiry, p: Person, caller: string) {
    const attempt = e.attempt_id;
    if (q.sms_decisions.some(d => d.attempt === attempt)) return; // one decision per call attempt
    const outcome = e.business_outcome;
    let reason = "";
    if (!this.policy.smsAfterOutcomes.includes(outcome)) reason = `outcome '${outcome ?? e.provider_status}' is not an SMS trigger`;
    else if (p.phone && this.suppressed[p.phone]) reason = `STOP received from ${p.phone} at ${this.suppressed[p.phone]} - applies to all reps and services`;
    else if (p.sms_permission !== "granted") reason = `no recorded SMS permission (${p.sms_permission})`;
    else if (!p.timezone) reason = "timezone unknown - cannot verify contact window (area code not used)";
    else if (!this.inWindow(p, e.received_at)) reason = `outside contact window (${localHHMM(p.timezone, e.received_at)} local)`;

    const sent = !reason;
    q.sms_decisions.push({ attempt, at: e.received_at, sent, reason: reason || "eligible: voicemail_left, permission granted, no STOP, inside window" });
    if (!sent) { this.note(e, `SMS not sent for ${attempt}: ${reason}`, q); return; }

    const id = this.fixtureMsgIds[attempt] ?? "M-" + attempt;
    const body = this.template.replace("{{first_name}}", p.name.split(" ")[0]).replace("{{rep_name}}", this.reps[caller].name);
    this.messages[id] = { id, inquiry_id: q.id, to: p.phone!, from: this.policy.smsSender, call_attempt_id: attempt, body, state: "created", error: null, history: [{ status: "created", at: e.received_at }] };
    this.note(e, `SMS ${id} submitted to provider (state: created - not yet delivered)`, q);
    const shared = Object.values(this.persons).filter(x => x.phone === p.phone && x.id !== p.id);
    if (shared.length) this.note(e, `NOTE: phone ${p.phone} is shared with another record (${shared.map(x => x.id).join(", ")}); a STOP from it suppresses both`, q);
  }

  // ---------- D: delivery tracking ----------
  private onSmsStatus(e: any) {
    const m = this.messages[e.message_id];
    if (!m) { this.note(e, `Status '${e.status}' for unknown message ${e.message_id}; ignored`); return; }
    const q = this.inquiries[m.inquiry_id];
    m.history.push({ status: e.status, occurred_at: e.occurred_at, received_at: e.received_at, error: e.error_code ?? null });
    const cur = m.state, nw = e.status;
    if (TERMINAL.has(cur) || (STATUS_RANK[nw] ?? -1) <= (STATUS_RANK[cur] ?? -1)) {
      this.note(e, `SMS ${m.id}: late/duplicate '${nw}' (occurred ${e.occurred_at}) logged; state stays '${cur}'`, q); return;
    }
    m.state = nw;
    this.note(e, `SMS ${m.id}: ${cur} -> ${nw}${e.error_code ? ` (${e.error_code} ${e.error_category})` : ""}`, q);
    if (nw === "failed") {
      m.error = `${e.error_code} ${e.error_category}`;
      const p = this.persons[q.person_id!];
      this.task("sms_failed", q, q.covering_id ?? q.owner_id!, `Follow-up text ${m.id} to ${p.name} (${m.to}) failed: ${m.error}. The lead has NOT seen the text.`,
        "Call again or email. Do not resend the same text; ops to check sender registration/filtering for " + m.from + ".", e.received_at, "smsfail:" + m.id);
    }
  }

  private onSmsReceived(e: any) {
    const phone = normPhone(e.from_phone);
    const people = Object.values(this.persons).filter(p => p.phone === phone);
    const qs = Object.values(this.inquiries).filter(q => people.some(p => p.id === q.person_id));
    if (phone && this.policy.stopKeywords.includes(String(e.body).trim().toUpperCase())) {
      this.suppressed[phone] = e.occurred_at;
      for (const q of qs) this.note(e, `STOP from ${phone} (occurred ${e.occurred_at}): all SMS to this phone suppressed across reps and services`, q);
      if (!qs.length) this.note(e, `STOP from ${phone} recorded`);
      for (const m of Object.values(this.messages))
        if (m.to === phone && m.history[0].at > e.occurred_at)
          this.task("compliance_review", this.inquiries[m.inquiry_id], this.policy.manager, `SMS ${m.id} was sent after a STOP that arrived late.`, "Review and confirm suppression.", e.received_at, "stopviol:" + m.id);
      return;
    }
    for (const q of qs) this.task("reply", q, q.covering_id ?? q.owner_id!, `Inbound reply from ${phone}: "${e.body}"`, "Respond to the lead.", e.received_at);
  }
}
