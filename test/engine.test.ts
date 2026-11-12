import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Engine, POLICY, normEmail, normPhone } from "../src/engine.ts";

const load = () => JSON.parse(readFileSync(new URL("../data/sample_data.json", import.meta.url), "utf8"));
const run = (data = load(), policy = POLICY) => new Engine(data, policy).run();
const bySub = (e: Engine, sid: string) => Object.values(e.inquiries).find(q => q.submissions.includes(sid))!;

test("normalizes email and phone formats", () => {
  assert.equal(normEmail(" TAYLOR.REED@EXAMPLE.COM "), "taylor.reed@example.com");
  for (const p of ["(202) 555-0106", "+1 202-555-0106", "+12025550106"]) assert.equal(normPhone(p), "+12025550106");
});

test("redelivered event is ignored; repeat submission attaches without duplicate task", () => {
  const e = run();
  assert.ok(e.log.some(l => l.event === "E002" && l.text.startsWith("Ignored")));
  const q = bySub(e, "F100");
  assert.deepEqual(q.submissions, ["F100", "F101"]);
  assert.equal(e.tasks.filter(t => t.inquiry_id === q.id && t.kind === "first_call").length, 1);
});

test("new inquiry routes to least-loaded eligible available rep", () => {
  assert.equal(bySub(run(), "F100").owner_id, "REP07");
});

test("same-service return keeps existing owner", () => {
  const q = bySub(run(), "F102");
  assert.equal(q.id, "L1002");
  assert.equal(q.owner_id, "REP04");
});

test("different service: keeps old assignment, new owner is eligible", () => {
  const e = run();
  const morgan = bySub(e, "F106");
  assert.equal(e.inquiries["L1003"].owner_id, "REP07"); // preserved
  assert.equal(morgan.owner_id, "REP05");
  assert.ok(e.reps["REP05"].eligible_service_units.includes("inadmissibility"));
  assert.equal(bySub(e, "F107").owner_id, "REP04"); // existing owner eligible -> reused
});

test("unavailable owner stays owner; eligible rep covers; owner notified", () => {
  const e = run();
  const q = e.inquiries["L1001"];
  assert.equal(q.owner_id, "REP03");
  assert.equal(q.covering_id, "REP07");
  assert.ok(e.openTasks(q, "coverage_notice").some(t => t.assignee === "REP03"));
});

test("no eligible available rep -> escalation, never an ineligible rep", () => {
  const data = load();
  for (const r of data.reps) if (r.eligible_service_units.includes("work_permits")) r.available = false;
  const e = run(data);
  const q = bySub(e, "F105");
  assert.equal(q.owner_id, null);
  assert.equal(q.status, "queued");
  assert.ok(e.openTasks(q, "escalation").length === 1);
});

test("conflicting identifiers go to review with no owner", () => {
  const e = run();
  for (const sid of ["F103", "F104"]) {
    const q = bySub(e, sid);
    assert.equal(q.status, "needs_review");
    assert.equal(q.owner_id, null);
    assert.equal(e.openTasks(q, "match_review").length, 1);
  }
});

test("STOP suppresses SMS across services and reps, even when received late", () => {
  const e = run();
  for (const sid of ["F106"]) assert.match(bySub(e, sid).sms_decisions[0].reason, /STOP/);
  assert.match(e.inquiries["L1003"].sms_decisions[0].reason, /STOP/);
  assert.equal(Object.values(e.messages).filter(m => m.to === "+14165550102").length, 0);
});

test("unknown timezone blocks automated SMS", () => {
  const data = load();
  data.events.push({ event_id: "X1", type: "call.finished", occurred_at: "2026-11-06T15:30:00Z", received_at: "2026-11-06T15:30:01Z",
    interaction_id: "IX", attempt_id: "CX", provider: "Close", lead_reference: { submission_id: "F105" }, provider_status: "completed", business_outcome: "voicemail_left", service: "work_permits" });
  assert.match(bySub(run(data), "F105").sms_decisions[0].reason, /timezone unknown/);
});

test("repeated call event does not send a second SMS", () => {
  const data = load();
  const call = data.events.find((x: any) => x.event_id === "E004");
  data.events.push({ ...call, event_id: "E004b" }); // same attempt, new event id
  const e = run(data);
  assert.equal(Object.values(e.messages).filter(m => m.call_attempt_id === "C100").length, 1);
});

test("late 'queued' does not regress 'delivered'; history kept", () => {
  const m = run().messages["M100"];
  assert.equal(m.state, "delivered");
  assert.ok(m.history.some(h => h.status === "queued"));
});

test("failed delivery creates exactly one actionable task, even if repeated", () => {
  const data = load();
  const fail = data.events.find((x: any) => x.event_id === "E007");
  data.events.push({ ...fail, event_id: "E007b" });
  const e = run(data);
  assert.equal(e.messages["M101"].state, "failed");
  const t = e.tasks.filter(t => t.kind === "sms_failed");
  assert.equal(t.length, 1);
  assert.equal(t[0].assignee, "REP04");
  assert.match(t[0].issue, /30007/);
});
