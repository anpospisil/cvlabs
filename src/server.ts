// Local UI: node src/server.ts [data.json]  -> http://localhost:3000
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { Engine } from "./engine.ts";
import { buildCards } from "./view.ts";

const dataPath = process.argv[2] ?? "data/sample_data.json";
const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const PORT = Number(process.env.PORT ?? 3000);

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/state") {
    const data = JSON.parse(readFileSync(dataPath, "utf8")); // fresh state on every request
    const total = data.events.length;
    const upto = Math.min(Number(url.searchParams.get("upto") ?? total), total);
    const eng = new Engine(data).run(upto);
    const body = {
      total, upto,
      last_event: upto ? data.events[upto - 1] : null,
      last_log: eng.log.filter(l => upto && l.event === data.events[upto - 1].event_id && l.at === data.events[upto - 1].received_at).map(l => l.text),
      reps: Object.values(eng.reps),
      cards: buildCards(eng),
    };
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(body));
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
}).listen(PORT, () => console.log(`Lead workflow UI: http://localhost:${PORT}`));
