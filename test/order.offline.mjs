// Checks the $orderby the client adds for stable paging, and the two-sided code sample.
// Local mock of Insyte; records every request. Exits 1 on any failure.
import http from "node:http";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const metadata = fs.readFileSync("test/fixtures/us-v2-metadata.xml", "utf8");
const openapi = fs.readFileSync("test/fixtures/us-openapi-v2.json", "utf8");
const FULL = 300;
let sampleSize = 5; // rows the mock returns for a Jobs sample
let cutRelation = false; // truncate the JobLines route so the client falls back to expand
const log = [];
const json = (res, body) => res.writeHead(200, { "content-type": "application/json" }).end(typeof body === "string" ? body : JSON.stringify(body));
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/v2/$metadata") { res.writeHead(200, { "content-type": "application/xml" }).end(metadata); return; }
  if (u.pathname === "/openapi.v2.json") { json(res, openapi); return; }
  if (!u.pathname.startsWith("/v2/")) { res.writeHead(404).end(); return; } // no v3 here
  if (req.headers.authorization !== "X-ApiKey testkey") { res.writeHead(401).end(); return; }
  log.push({ path: u.pathname, q: Object.fromEntries(u.searchParams) });
  if (u.pathname === "/v2/Jobs(1)/JobLines" && cutRelation) { json(res, '{"value":[{"ID":'); return; }
  if (u.pathname === "/v2/Jobs(1)") { json(res, { ID: 1, JobLines: [{ ID: 7 }] }); return; }
  if (u.pathname === "/v2/Jobs") {
    // Newest sample holds one code, oldest another, so a merge is visible in the output.
    const code = u.searchParams.get("$orderby") === "ID asc" ? "stage_job_archived" : "stage_job_quote";
    const n = Math.min(sampleSize, +u.searchParams.get("$top"));
    json(res, { value: Array.from({ length: n }, (_, i) => ({ ID: i + 1, Stage: code })) });
    return;
  }
  json(res, { value: [] });
});
await new Promise((r) => srv.listen(0, r));
const base = `http://127.0.0.1:${srv.address().port}`;
const connect = async (name) => {
  const c = new Client({ name, version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], stderr: "inherit",
    env: { ...process.env, INSYTE_API_KEY: "testkey", INSYTE_API_BASE: base + "/v2", INSYTE_API_VERSION: "auto", INSYTE_MCP_HOME: fs.mkdtempSync(`${process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"}/insyte-order-`) } }));
  return c;
};
let client = await connect("order");
const tool = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return r.isError ? `ERROR ${r.content[0].text}` : r.content[0].text; };
const fails = [];
const check = (label, ok, got) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  got ${JSON.stringify(got)}`}`); if (!ok) fails.push(label); };
let mark = 0;
const since = () => log.slice(mark);
const begin = () => { mark = log.length; };

begin();
await tool("insyte_query", { dataset: "Jobs", limit: 2 });
let reqs = since().filter((r) => r.path === "/v2/Jobs"); // skips the init key probe
check("list with no orderby sends the key ascending", reqs.length === 1 && reqs[0].q.$orderby === "ID", reqs);

begin();
await tool("insyte_query", { dataset: "Jobs", limit: 2, orderby: "Reference desc" });
reqs = since();
check("caller orderby is kept", reqs.length === 1 && reqs[0].q.$orderby === "Reference desc", reqs);

begin();
await tool("insyte_get_related", { dataset: "Jobs", id: 1, relation: "JobLines", limit: 2 });
reqs = since();
check("relation list gets the target key orderby", reqs.length === 1 && reqs[0].path === "/v2/Jobs(1)/JobLines" && reqs[0].q.$orderby === "ID", reqs);

begin();
await tool("insyte_get_related", { dataset: "Jobs", id: 1, relation: "JobLines", limit: 2, orderby: "Quantity desc" });
reqs = since();
check("relation list keeps caller orderby", reqs.length === 1 && reqs[0].q.$orderby === "Quantity desc", reqs);

cutRelation = true;
begin();
await tool("insyte_get_related", { dataset: "Jobs", id: 1, relation: "JobLines", limit: 2 });
const exp = since().find((r) => r.path === "/v2/Jobs(1)" && r.q.$expand);
check("viaExpand nested options get the key orderby", !!exp && /JobLines\(.*\$orderby=ID[;)]/.test(exp.q.$expand), exp);
begin();
await tool("insyte_get_related", { dataset: "Jobs", id: 1, relation: "JobLines", limit: 2, orderby: "Quantity desc" });
const exp2 = since().find((r) => r.path === "/v2/Jobs(1)" && r.q.$expand);
check("viaExpand keeps caller orderby", !!exp2 && /\$orderby=Quantity desc/.test(exp2.q.$expand) && !/\$orderby=ID[;)]/.test(exp2.q.$expand), exp2);
cutRelation = false;

const sampleCalls = () => since().filter((r) => r.path === "/v2/Jobs");
sampleSize = 5;
begin();
let out = await tool("insyte_describe_dataset", { dataset: "Jobs" });
reqs = sampleCalls();
check("short first sample: 1 request, newest order", reqs.length === 1 && reqs[0].q.$orderby === "ID desc", reqs);
check("short sample shows only newest codes", /stage_job_quote/.test(out) && !/stage_job_archived/.test(out), out.slice(0, 200));

// A fresh server process has an empty code cache.
await client.close();
client = await connect("order2");
sampleSize = FULL + 1;
begin();
out = await tool("insyte_describe_dataset", { dataset: "Jobs" });
reqs = sampleCalls();
check("full first sample: 2 requests, desc then asc", reqs.length === 2 && reqs[0].q.$orderby === "ID desc" && reqs[1].q.$orderby === "ID asc", reqs);
check("merged codes from both samples in describe output", /stage_job_quote/.test(out) && /stage_job_archived/.test(out), out.slice(0, 300));
begin();
await tool("insyte_describe_dataset", { dataset: "Jobs" });
check("second describe is cached: no new sample requests", sampleCalls().length === 0, sampleCalls());

await client.close(); srv.close();
console.log(`\n${fails.length ? `${fails.length} FAILED` : "all checks passed"}`);
process.exit(fails.length ? 1 : 0);
