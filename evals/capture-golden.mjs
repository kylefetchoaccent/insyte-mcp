// Computes the expected number for every "number" check by running its goldenQuery through the
// MCP server, and writes evals/golden/<system>.json. Stores ids and numbers only, never row contents.
//   INSYTE_API_KEY=... node evals/capture-golden.mjs [--system name] [--only a,b]
// Read-only: it only calls the server's query tools, one at a time.
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadQuestions, validateQuestions, connectServer, resultText, parseSystemNames } from "./lib.mjs";

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

if (!process.env.INSYTE_API_KEY?.trim()) {
  console.error("INSYTE_API_KEY is not set, so there is nothing to capture golden values from.\n" +
    "Set INSYTE_API_KEY to a READ-scope Insyte key and run again.\n" +
    "No golden file was written.");
  process.exit(2);
}

const questions = loadQuestions();
const problems = validateQuestions(questions);
if (problems.length) { console.error("questions.jsonl is invalid:\n  " + problems.join("\n  ")); process.exit(2); }
const only = opt("--only")?.split(",");

const client = await connectServer();
const allSystems = parseSystemNames(resultText(await client.callTool({ name: "insyte_list_systems", arguments: {} })));
let systems = allSystems;
if (opt("--system")) systems = systems.filter((s) => s === opt("--system"));
if (!systems.length) { console.error("No matching Insyte system."); await client.close(); process.exit(2); }
const multi = allSystems.length > 1; // several systems: every call must name one

function extract(how, body) {
  if (how === "totalCount") return body.totalCount ?? null;
  if (how === "returned") return body.returned ?? null;
  if (how.startsWith("sum:")) {
    if (body.hasMore) return { value: null, note: "more rows than one page; narrow the golden query" };
    const f = how.slice(4);
    return (body.rows ?? []).reduce((s, r) => s + (Number(r[f]) || 0), 0);
  }
  return null;
}

fs.mkdirSync(path.join(ROOT, "evals", "golden"), { recursive: true });
let failures = 0;
for (const system of systems) {
  const items = {};
  for (const q of questions) {
    if (only && !only.includes(q.id)) continue;
    const c = q.checks.find((k) => k.type === "number");
    if (!c) continue;
    const gq = c.goldenQuery;
    const args = { ...gq.args, ...(multi ? { system } : {}) };
    const res = await client.callTool({ name: gq.tool, arguments: args });
    const text = resultText(res);
    if (res.isError) { console.log(`FAIL  ${system}/${q.id}: ${text.slice(0, 120)}`); items[q.id] = { value: null, note: "query failed" }; failures++; continue; }
    let body;
    try { body = JSON.parse(text); } catch { console.log(`FAIL  ${system}/${q.id}: result was not JSON`); items[q.id] = { value: null, note: "not JSON" }; failures++; continue; }
    const got = extract(gq.extract ?? "totalCount", body);
    const item = got && typeof got === "object" ? got : { value: got };
    const ids = (body.rows ?? []).map((r) => r.ID).filter((v) => v !== undefined).slice(0, 1000);
    if (ids.length && gq.extract !== "totalCount") item.ids = ids;
    if (item.value === null || item.value === undefined) failures++;
    items[q.id] = { ...item, capturedAt: new Date().toISOString() };
    console.log(`${item.value === null || item.value === undefined ? "FAIL" : "ok  "}  ${system}/${q.id}: ${item.value ?? item.note ?? "no value"}`);
  }
  const file = path.join(ROOT, "evals", "golden", `${system}.json`);
  let merged = items;
  if (only && fs.existsSync(file)) merged = { ...JSON.parse(fs.readFileSync(file, "utf8")).items, ...items };
  fs.writeFileSync(file, JSON.stringify({ system, capturedAt: new Date().toISOString(), items: merged }, null, 2));
  console.log(`Wrote ${path.relative(ROOT, file)}`);
}
await client.close();
process.exit(failures ? 1 : 0);
