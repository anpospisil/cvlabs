// Usage: node src/cli.ts [data.json]  -> prints salesperson view, writes out/report.html + out/state.json
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Engine } from "./engine.ts";

const path = process.argv[2] ?? "data/sample_data.json";
const eng = new Engine(JSON.parse(readFileSync(path, "utf8"))).run();
const SVC: Record<string, string> = { citizenship: "Citizenship", inadmissibility: "Inadmissibility", work_permits: "Work permits" };
const rep = (id: string | null) => (id ? `${id} ${eng.reps[id].name}${eng.reps[id].available ? "" : " (UNAVAILABLE)"}` : "-");
const hhmm = (iso: string) => iso.slice(11, 16) + "Z";

type Card = { title: string; lines: string[]; next: string[]; flag: boolean };
const cards: Card[] = Object.values(eng.inquiries).map(q => {
  const p = q.person_id ? eng.persons[q.person_id] : null;
  const name = p?.name ?? `${q.contact?.name} (unmatched)`;
  const phone = p?.phone ?? q.contact?.phone;
  const msgs = Object.values(eng.messages).filter(m => m.inquiry_id === q.id);
  const open = eng.openTasks(q);
  const lines = [
    `Owner: ${rep(q.owner_id)}${q.covering_id ? `   Covering: ${rep(q.covering_id)}` : ""}   Status: ${q.status}`,
    `Phone: ${phone ?? "-"}   TZ: ${p?.timezone ?? q.contact?.timezone ?? "UNKNOWN"}   SMS permission: ${p?.sms_permission ?? q.contact?.sms_permission}   STOP: ${phone && eng.suppressed[phone] ? "YES" : "no"}`,
    ...q.history.map(h => `  ${hhmm(h.at)} [${h.event}] ${h.text}`),
    ...q.sms_decisions.map(d => `  SMS decision ${d.attempt}: ${d.sent ? "SENT" : "NOT SENT"} - ${d.reason}`),
    ...msgs.map(m => `  Message ${m.id}: ${m.state.toUpperCase()}${m.error ? " (" + m.error + ")" : ""}  history: ${m.history.map(h => h.status).join(" > ")}`),
  ];
  const next = open.length ? open.map(t => `[${t.kind}] ${t.assignee}: ${t.issue} -> ${t.next_action}`) : ["No open action."];
  const flag = open.some(t => ["sms_failed", "match_review", "escalation", "compliance_review"].includes(t.kind));
  return { title: `${q.id} | ${name} | ${SVC[q.service] ?? q.service}`, lines, next, flag };
});

for (const c of cards) console.log(`\n=== ${c.title}${c.flag ? "  !! NEEDS ATTENTION" : ""}\n${c.lines.join("\n")}\n  NEXT: ${c.next.join("\n        ")}`);
console.log(`\n=== Rep load after run: ${Object.values(eng.reps).map(r => `${r.id}=${r.assigned_today}`).join(" ")}`);
console.log(`=== Ignored/global log entries: ${eng.log.filter(l => l.text.startsWith("Ignored")).map(l => l.event).join(", ") || "none"}`);

const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as any)[ch]);
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Lead activity</title><style>
body{font:14px system-ui,sans-serif;max-width:1000px;margin:24px auto;padding:0 16px;color:#222}
.card{border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:12px 0}.flag{border-color:#d33;background:#fff6f6}
h2{font-size:15px;margin:0 0 6px}pre{white-space:pre-wrap;font:12px ui-monospace,monospace;margin:6px 0}.next{background:#eef5ff;padding:8px;border-radius:6px}
</style></head><body><h1>Lead activity - salesperson view</h1>
${cards.sort((a, b) => Number(b.flag) - Number(a.flag)).map(c => `<div class="card${c.flag ? " flag" : ""}"><h2>${esc(c.title)}${c.flag ? " - needs attention" : ""}</h2>
<div class="next"><b>Next:</b><br>${c.next.map(esc).join("<br>")}</div><pre>${esc(c.lines.join("\n"))}</pre></div>`).join("\n")}
</body></html>`;
mkdirSync("out", { recursive: true });
writeFileSync("out/report.html", html);
writeFileSync("out/state.json", JSON.stringify({ persons: eng.persons, inquiries: eng.inquiries, tasks: eng.tasks, messages: eng.messages, suppressed: eng.suppressed, reps: eng.reps }, null, 2));
console.log("\nWrote out/report.html and out/state.json");
