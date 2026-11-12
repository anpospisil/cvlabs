// Turns engine state into salesperson-facing cards (shared by CLI and UI).
import type { Engine } from "./engine.ts";

export const SERVICE_NAMES: Record<string, string> = { citizenship: "Citizenship", inadmissibility: "Inadmissibility", work_permits: "Work permits" };
const ATTENTION = ["sms_failed", "match_review", "escalation", "compliance_review"];

export function buildCards(eng: Engine) {
  const repLabel = (id: string | null) => (id ? `${id} ${eng.reps[id]?.name ?? ""}${eng.reps[id] && !eng.reps[id].available ? " (unavailable)" : ""}` : null);
  return Object.values(eng.inquiries).map(q => {
    const p = q.person_id ? eng.persons[q.person_id] : null;
    const phone = p?.phone ?? q.contact?.phone ?? null;
    const open = eng.openTasks(q);
    return {
      id: q.id,
      name: p?.name ?? `${q.contact?.name} (unmatched)`,
      service: SERVICE_NAMES[q.service] ?? q.service,
      status: q.status,
      owner: repLabel(q.owner_id),
      covering: repLabel(q.covering_id),
      people: [q.owner_id, q.covering_id, ...open.map(t => t.assignee)].filter(Boolean) as string[],
      phone,
      timezone: p?.timezone ?? q.contact?.timezone ?? null,
      sms_permission: p?.sms_permission ?? q.contact?.sms_permission ?? "unknown",
      stop: !!(phone && eng.suppressed[phone]),
      history: q.history,
      sms_decisions: q.sms_decisions,
      messages: Object.values(eng.messages).filter(m => m.inquiry_id === q.id).map(m => ({ id: m.id, state: m.state, error: m.error, body: m.body, history: m.history.map(h => h.status) })),
      tasks: open.map(t => ({ id: t.id, kind: t.kind, assignee: t.assignee, issue: t.issue, next_action: t.next_action })),
      attention: open.some(t => ATTENTION.includes(t.kind)),
      last_at: q.history.at(-1)?.at ?? "",
    };
  }).filter(c => c.history.length || c.tasks.length) // hide untouched legacy records
    .sort((a, b) => Number(b.attention) - Number(a.attention) || b.last_at.localeCompare(a.last_at));
}
