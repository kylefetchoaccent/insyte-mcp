// Offline checks for the support tools: profile gating, docs search over synthetic Markdown,
// schema comparison between mock US and AU hosts, and the deep system check against a mock
// that returns Insyte's "Invalid column name" 500. Needs `npm run build` first. Exits 1 on failure.
//   node test/support.offline.mjs
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Connections } from "../dist/connections.js";
import { createServer } from "../dist/server.js";

const fails = [];
const check = (label, ok, got) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 400)}`}`);
  if (!ok) fails.push(label);
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "insyte-support-"));
const usXml = fs.readFileSync("test/fixtures/us-v2-metadata.xml", "utf8");
const auXml = fs.readFileSync("test/fixtures/au-v2-metadata.xml", "utf8");
const countSets = (xml) => (xml.match(/<EntitySet /g) ?? []).length;
const US_SETS = countSets(usXml);
const AU_SETS = countSets(auXml);

// A mock Insyte host. onData(url) may return [status, body]; otherwise one empty row comes back.
function mockHost(xml, { onData, delayMs = 0 } = {}) {
  const stats = { inflight: 0, maxInflight: 0, dataRequests: [] };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/v2/$metadata") return void res.writeHead(200, { "content-type": "application/xml" }).end(xml);
    if (!/^\/v2\/\w+/.test(u.pathname)) return void res.writeHead(404).end(); // no v3, no OpenAPI
    stats.inflight++;
    stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    stats.dataRequests.push(req.url);
    const custom = onData?.(u);
    const [status, body] = custom ?? [200, JSON.stringify({ value: [{ ID: 1 }] })];
    res.writeHead(status, { "content-type": "application/json" }).end(body);
    stats.inflight--;
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, stats, base: `http://127.0.0.1:${srv.address().port}` })));
}

async function inProcess(systems, profile) {
  const conns = new Connections(systems.map(([name, base]) => ({ name, base, apiKey: "testkey", source: "test" })), "auto");
  const server = createServer(conns, { profile });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "support-test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const call = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content[0].text };
};
const parse = (r) => JSON.parse(r.text);

// 1. Profile gating, through the real entry point.
const gate = await mockHost(usXml);
async function toolsFor(profile) {
  const client = new Client({ name: "gate", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      stderr: "ignore",
      env: { ...process.env, INSYTE_API_KEY: "testkey", INSYTE_API_BASE: `${gate.base}/v2`, INSYTE_MCP_PROFILE: profile, INSYTE_MCP_HOME: fs.mkdtempSync(path.join(tmp, "home-")) },
    }),
  );
  const names = (await client.listTools()).tools.map((t) => t.name);
  const instructions = client.getInstructions() ?? "";
  await client.close();
  return { names, instructions };
}
const SUPPORT_TOOLS = ["insyte_docs_search", "insyte_compare_schemas", "insyte_check_system"];
const pub = await toolsFor("public");
const sup = await toolsFor("support");
check("public profile has none of the support tools", SUPPORT_TOOLS.every((t) => !pub.names.includes(t)), pub.names);
check("support profile has all three support tools", SUPPORT_TOOLS.every((t) => sup.names.includes(t)), sup.names);
check("support instructions say these are staff tools; public ones do not", /Accent staff tools/.test(sup.instructions) && !/Accent staff tools/.test(pub.instructions), sup.instructions.slice(-200));
gate.srv.close();

// 2. Docs search over synthetic Markdown.
const docs = path.join(tmp, "docs");
fs.mkdirSync(path.join(docs, "sub"), { recursive: true });
fs.writeFileSync(path.join(docs, "pricing.md"), "# Pricing\n\nIntro text about pricing.\n\n## Importing price lists\n\nTo import a price list, upload the CSV file on the Price Lists page. The import checks every row.\n\n## Discounts\n\nDiscounts apply per customer group.\n");
fs.writeFileSync(path.join(docs, "sub", "misc.md"), "# Misc\n\n" + "Filler words about nothing in particular. ".repeat(80) + "One stray mention of import appears here.\n\n## Fabrics\n\nFabric libraries hold swatches and colours.\n");
for (let i = 1; i <= 12; i++) fs.writeFileSync(path.join(docs, `widget${i}.md`), `# Widget note ${i}\n\nThe widget number ${i} needs care.\n`);
// Plain text like the Confluence export: title on the first line, no headings.
fs.writeFileSync(path.join(docs, "IWDOC-99. Discontinued dates-0101.txt"), "Discontinued Dates for Fabrics\r\nA fabric can carry a discontinued date.\r\n\r\nAfter the date the configurator hides the swatch.\r\n");
const hub = await inProcess([["main", "http://127.0.0.1:9"]], "support");

delete process.env.INSYTE_DOCS_DIR;
let r = await call(hub, "insyte_docs_search", { query: "import" });
check("docs search with INSYTE_DOCS_DIR unset: plain message, not an error", !r.isError && /INSYTE_DOCS_DIR/.test(r.text) && /No docs folder/.test(r.text), r);
process.env.INSYTE_DOCS_DIR = path.join(tmp, "does-not-exist");
r = await call(hub, "insyte_docs_search", { query: "import" });
check("docs search with a missing folder: plain message, not an error", !r.isError && /not found/.test(r.text), r);

process.env.INSYTE_DOCS_DIR = docs;
r = await call(hub, "insyte_docs_search", { query: "import price list" });
let out = parse(r);
check("ranking: the focused section beats the long section with one stray mention", out.hits[0]?.heading === "Importing price lists" && out.hits[0].file === "pricing.md", out.hits);
check("the weaker match is still returned, after the better one", out.hits.some((h) => h.file === "sub/misc.md") && out.hits.findIndex((h) => h.file === "sub/misc.md") > 0, out.hits);
check("snippet comes from the section and is short", /import/i.test(out.hits[0].snippet) && out.hits[0].snippet.length <= 250, out.hits[0]);
check("hits carry only file, heading and snippet", Object.keys(out.hits[0]).sort().join() === "file,heading,snippet", out.hits[0]);
r = await call(hub, "insyte_docs_search", { query: "widget" });
check("default limit is 5", parse(r).returned === 5, parse(r).returned);
r = await call(hub, "insyte_docs_search", { query: "widget", limit: 3 });
check("limit 3 returns 3", parse(r).returned === 3, parse(r).returned);
r = await call(hub, "insyte_docs_search", { query: "widget", limit: 10 });
check("limit 10 returns 10 of 12", parse(r).returned === 10, parse(r).returned);
r = await call(hub, "insyte_docs_search", { query: "widget", limit: 11 });
check("limit above 10 is refused", r.isError, r);
r = await call(hub, "insyte_docs_search", { query: "discontinued configurator swatch" });
out = parse(r);
check("plain-text page: indexed, titled by its first line", out.hits[0]?.heading === "Discontinued Dates for Fabrics" && /\.txt$/.test(out.hits[0].file) && /configurator/.test(out.hits[0].snippet), out.hits);
r = await call(hub, "insyte_docs_search", { query: "zzzznomatch" });
check("no match returns zero hits", parse(r).returned === 0, r);
// Lazy, once per process: a file added after the first search is not seen.
fs.writeFileSync(path.join(docs, "late.md"), "# Latecomer\n\nuniquelatetoken here.\n");
r = await call(hub, "insyte_docs_search", { query: "uniquelatetoken" });
check("index is built once per process", parse(r).returned === 0, r);
await hub.close();

// 3. Compare two mock systems.
const us = await mockHost(usXml);
const au = await mockHost(auXml);
const cmp = await inProcess([["us", us.base], ["au", au.base]], "support");
r = await call(cmp, "insyte_compare_schemas", { systemA: "us", systemB: "au" });
check("compare: real data set counts differ as in technical.md (37 vs 32)", US_SETS === 37 && AU_SETS === 32 && r.text.includes("Data sets: us 37, au 32"), r.text.slice(0, 400));
check("compare: summary comes before details", r.text.indexOf("Summary") < r.text.indexOf("Only in us") && r.text.indexOf("Only in us:") > 0, r.text.slice(0, 600));
check("compare: the five extra US data sets are counted", /- Only in us: 5\n/.test(r.text) && /- Only in au: 0\n/.test(r.text), r.text.slice(0, 500));
check("compare: output stays under the cap", r.text.length < 60_000, r.text.length);
check("compare: both systems named in the output", /us \(API v2/.test(r.text) && /au \(API v2/.test(r.text), r.text.slice(0, 200));
r = await call(cmp, "insyte_compare_schemas", { systemA: "us", systemB: "us" });
check("compare: the same system twice is refused", r.isError && /different systems/.test(r.text), r);
r = await call(cmp, "insyte_compare_schemas", { systemA: "us", systemB: "nope" });
check("compare: unknown system is refused and lists the real names", r.isError && /us, au/.test(r.text), r);
check("compare: sequential requests only", us.stats.maxInflight <= 1 && au.stats.maxInflight <= 1, [us.stats.maxInflight, au.stats.maxInflight]);
check("compare: sent no data reads", us.stats.dataRequests.every((u) => /\$top=1/.test(u)) && au.stats.dataRequests.every((u) => /\$top=1/.test(u)), us.stats.dataRequests.slice(0, 3));
await cmp.close();

// 4. check_system against a mock with Insyte's column fault and one plain failure.
const BAD_SET = "SupplyJobLines";
const BAD_COL = "ProductBaseUnit";
const faulty = await mockHost(usXml, {
  onData: (u) => {
    const set = u.pathname.split("/")[2];
    if (set === BAD_SET && !u.searchParams.get("$select")) {
      return [500, JSON.stringify({ error: { message: `Invalid column name '${BAD_COL}'.` } })];
    }
    if (set === "Jobs") return [400, JSON.stringify({ error: { message: "Bad request." } })];
    return undefined;
  },
});
const chk = await inProcess([["acme", faulty.base]], "support");
r = await call(chk, "insyte_check_system", { system: "acme" });
out = parse(r);
check("shallow check: host, API version, data set count, no deep section", out.connected === true && out.host.startsWith("127.0.0.1") && out.apiVersion === "v2" && out.dataSets === US_SETS && !out.deep && out.system === "acme", out);
const readsAfterShallow = faulty.stats.dataRequests.length;
check("shallow check: only the connect probe touched data", readsAfterShallow === 1, readsAfterShallow);
r = await call(chk, "insyte_check_system", { deep: true });
out = parse(r);
const bad = out.deep?.skipped?.find((s) => s.dataset === BAD_SET);
check("deep check: the column fault is reported as skipped fields", bad && bad.fields.includes(BAD_COL), out.deep?.skipped);
check("deep check: a data set that fails outright is listed with its error", out.deep?.errors?.length === 1 && out.deep.errors[0].dataset === "Jobs" && /400/.test(out.deep.errors[0].error), out.deep?.errors);
check("deep check: every other data set is ok", out.deep?.checked === US_SETS && out.deep.ok === US_SETS - 2 && out.deep.failed === 1 && out.deep.withSkippedFields === 1, out.deep && { ...out.deep, skipped: undefined, errors: undefined });
check("deep check: requests ran one at a time", faulty.stats.maxInflight <= 1, faulty.stats.maxInflight);
check("deep check: every read except the fault retry has no select", faulty.stats.dataRequests.slice(readsAfterShallow).filter((u) => !u.startsWith("/v2/" + BAD_SET)).every((u) => !/$select/.test(u)), faulty.stats.dataRequests.slice(readsAfterShallow).filter((u) => /$select/.test(u)));
await chk.close();

// 5. Stops early when the budget runs out, and says so.
const slow = await mockHost(usXml, { delayMs: 700 });
const slowClient = await inProcess([["slowco", slow.base]], "support");
r = await call(slowClient, "insyte_check_system", { deep: true, budgetSeconds: 5 });
out = parse(r);
check("deep check: stops at the time budget with a note", out.deep?.checked < US_SETS && /Stopped after 5 seconds/.test(out.deep?.note ?? "") && /unchecked/.test(out.deep.note), out.deep && { ...out.deep, skipped: undefined, errors: undefined });
await slowClient.close();

// 6. A system that cannot connect is a finding, not a tool error.
const deadClient = await inProcess([["gone", "http://127.0.0.1:9"]], "support");
r = await call(deadClient, "insyte_check_system", {});
out = parse(r);
check("check of an unreachable system: connected false with the connect error", !r.isError && out.connected === false && out.system === "gone" && /Could not reach|Could not check/.test(out.connectError), r);
await deadClient.close();

for (const h of [us, au, faulty, slow]) h.srv.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fails.length ? `${fails.length} FAILED` : "all checks passed"}`);
process.exit(fails.length ? 1 : 0);
