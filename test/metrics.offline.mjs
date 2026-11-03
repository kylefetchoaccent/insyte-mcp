// Checks the metric tools against a local mock of Insyte: the US fixture metadata plus synthetic
// rows with real field names. Every expected number below was worked out by hand (see the
// comments); the mock proves the code paths, not real Insyte totals. Exits 1 on any failure.
//   node test/metrics.offline.mjs        (run after `npm run build`)
import http from "node:http";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Connections } from "../dist/connections.js";
import { createServer } from "../dist/server.js";
import { parseMetadata } from "../dist/insyte.js";
import { METRICS } from "../dist/metrics/definitions.js";

const metadata = fs.readFileSync("test/fixtures/us-v2-metadata.xml", "utf8");

// --- synthetic data -----------------------------------------------------------------------
const line = (p) => ({ ID: 1, DiscountedPriceExTax: p });
const job = (stage, rep, prices) => ({ ID: 1, Stage: stage, SalesRepID: rep, JobLines: prices.map(line) });

// Sold revenue, Opportunities closed 2026-06-01..2026-07-31.
//  opp1 06-10: order rep7 100.50+200.25=300.75 (quote job 999 is not sold)
//  opp2 06-30T23:00Z: order_edit rep8 50, order rep7 10.10+20.20=30.30  -> June total 300.75+50+30.30=381.05
//  opp3 07-02: order, no rep, 1000;  opp4 no jobs;  opp5: cancelled job 5000 (not sold)
//  600 more opps on 07-05, one order job each, rep9, one line of 10.00 -> 6000
const BULK = 600;
const soldRows = [
  { CloseDate: "2026-06-10T09:00:00Z", Jobs: [job("stage_job_order", 7, [100.5, 200.25]), job("stage_job_quote", 7, [999])] },
  { CloseDate: "2026-06-30T23:00:00Z", Jobs: [job("stage_job_order_edit", 8, [50]), job("stage_job_order", 7, [10.1, 20.2])] },
  { CloseDate: "2026-07-02T09:00:00Z", Jobs: [job("stage_job_order", null, [1000])] },
  { CloseDate: "2026-07-15T09:00:00Z", Jobs: [] },
  { CloseDate: "2026-07-20T09:00:00Z", Jobs: [job("stage_job_cancelled", 7, [5000])] },
  ...Array.from({ length: BULK }, () => ({ CloseDate: "2026-07-05T09:00:00Z", Jobs: [job("stage_job_order", 9, [10])] })),
].map((r, i) => ({ ID: i + 1, ...r }));

const pay = (d) => ({ Payment: d === null ? null : { ID: 1, Date: d } });
const cJob = (rep, stage, dates, prices) => ({ SalesRepID: rep, Stage: stage, PaymentAllocations: dates.map(pay), JobLines: prices.map(line) });
// Closed revenue, request 06-01..06-30 (the mock returns the same superset a real "any payment in range" filter would).
//  J10 rep7: payments 06-05, 06-20, earliest 06-05 -> 400+100=500
//  J11 rep8: payments 05-28, 06-10, earliest is May -> out of a June range; 900 in a May+June range
//  J12 rep7 quote stage: payment 06-30T12:00Z -> counted (cash is cash): 25.5+24.5=50
//  J13 no rep: an empty allocation then 06-15 -> 75.75.   June: 500+50+75.75=625.75;  rep7 550, no rep 75.75
const closedRows = [
  cJob(7, "stage_job_order", ["2026-06-05T10:00:00Z", "2026-06-20T10:00:00Z"], [400, 100]),
  cJob(8, "stage_job_order", ["2026-05-28T10:00:00Z", "2026-06-10T10:00:00Z"], [900]),
  cJob(7, "stage_job_quote", ["2026-06-30T12:00:00Z"], [25.5, 24.5]),
  cJob(null, "stage_job_order", [null, "2026-06-15T10:00:00Z"], [75.75]),
].map((r, i) => ({ ID: 10 + i, ...r }));

const sj = (date, rep, stage = "stage_job_order") => ({ JobDate: date, SalesRepID: rep, Stage: stage });
// Service jobs: 5 in total. March 2 (reps 1, 1), April 2 (rep 2, none), May 1 (rep 2).
const serviceAlpha = [sj("2026-03-03T08:00:00Z", 1), sj("2026-03-20T08:00:00Z", 1), sj("2026-04-01T08:00:00Z", 2), sj("2026-04-30T23:59:00Z", null), sj("2026-05-09T08:00:00Z", 2)].map((r, i) => ({ ID: i + 1, ...r }));
const serviceBeta = [sj("2026-03-04T08:00:00Z", 5), sj("2026-03-05T08:00:00Z", 5)].map((r, i) => ({ ID: i + 1, ...r }));
// Jobs by stage: quote 3, order 2, lost 1.
const stageRows = ["stage_job_quote", "stage_job_order", "stage_job_quote", "stage_job_lost", "stage_job_order", "stage_job_quote"].map((s, i) => ({ ID: i + 1, ...sj("2026-06-01T08:00:00Z", 1, s) }));
// Won opportunities: June 2 (rep7, rep7), July 1 (rep8).
const wonRows = [["2026-06-02T08:00:00Z", 7], ["2026-06-03T08:00:00Z", 7], ["2026-07-01T08:00:00Z", 8]].map(([d, r], i) => ({ ID: i + 1, CloseDate: d, RepresentativeID: r }));

// --- mock Insyte ---------------------------------------------------------------------------
let override; // { rows, fakeCount, noCount } for won_opportunities queries
const log = [];
const dataRows = (key, set, filter) => {
  if (set === "Opportunities") return /contains\(Status,'won'\)/.test(filter) ? (override?.rows ?? wonRows) : soldRows;
  if (set === "Jobs") {
    if (/PaymentAllocations\/any/.test(filter)) return closedRows;
    if (/type_job_service/.test(filter)) return key === "keyB" ? serviceBeta : serviceAlpha;
    return stageRows;
  }
  return [];
};
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/v2/$metadata") { res.writeHead(200, { "content-type": "application/xml" }).end(metadata); return; }
  if (!/^\/v2\/\w+$/.test(u.pathname)) { res.writeHead(404).end(); return; }
  const key = (req.headers.authorization ?? "").replace("X-ApiKey ", "");
  if (key !== "keyA" && key !== "keyB") { res.writeHead(401).end(); return; }
  const set = u.pathname.slice(4);
  const top = +u.searchParams.get("$top"), skip = +(u.searchParams.get("$skip") ?? 0);
  if (set !== "Jobs" && set !== "Opportunities") { res.writeHead(200, { "content-type": "application/json" }).end('{"value":[]}'); return; }
  const filter = u.searchParams.get("$filter") ?? "";
  log.push({ set, filter, top, skip, orderby: u.searchParams.get("$orderby"), count: !!u.searchParams.get("$count"), key });
  const all = dataRows(key, set, filter);
  const take = Math.min(top, 100); // the server's own page size, so every call crosses nextLinks
  const body = { value: all.slice(skip, skip + take).map((r) => ({ ...r, "@odata.etag": "x" })) };
  if (u.searchParams.get("$count") && !override?.noCount) body["@odata.count"] = override?.fakeCount ?? all.length;
  if (top > take && skip + take < all.length) {
    const next = new URL(req.url, `http://${req.headers.host}`);
    next.searchParams.set("$skip", String(skip + take)); next.searchParams.set("$top", String(top - take));
    next.searchParams.delete("$count");
    body["@odata.nextLink"] = next.toString();
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
});
await new Promise((r) => srv.listen(0, r));
const base = `http://127.0.0.1:${srv.address().port}/v2`;

async function connect(systems) {
  const conns = new Connections(systems.map(([name, apiKey]) => ({ name, base, apiKey, source: "test" })), "auto");
  const server = createServer(conns, { profile: "public" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "metrics-test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const one = await connect([["main", "keyA"]]);
const two = await connect([["alpha", "keyA"], ["beta", "keyB"]]);

const metric = async (c, args) => {
  const r = await c.callTool({ name: "insyte_metric", arguments: args });
  const t = r.content[0].text;
  return r.isError ? { err: t } : { body: JSON.parse(t), raw: t };
};
const fails = [];
const check = (label, ok, got) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 400)}`}`); if (!ok) fails.push(label); };
const flat = (groups) => groups?.map((g) => `${g.key}=${g.value}/${g.matched}`).join(" ");

// --- schema: every field a definition uses exists in the real US metadata ------------------
const sets = new Map(parseMetadata(metadata).map((s) => [s.name, s]));
const missing = [];
for (const m of METRICS) {
  for (const [ds, names] of Object.entries(m.uses)) {
    const s = sets.get(ds);
    if (!s) { missing.push(`${m.id}: no data set ${ds}`); continue; }
    const known = new Set([...s.fields.map((f) => f.name), ...s.navigations.map((n) => n.name)]);
    for (const n of names) if (!known.has(n)) missing.push(`${m.id}: ${ds}.${n}`);
  }
}
check("every field and navigation the definitions use exists in the US $metadata fixture", missing.length === 0, missing);
check("each definition names a source, a date field and caveats", METRICS.every((m) => m.source.length && m.dateField && m.dateWhy && m.caveats.length), METRICS.map((m) => m.id));

// --- list_metrics: no Insyte calls --------------------------------------------------------
const before = log.length;
const lr = await one.callTool({ name: "insyte_list_metrics", arguments: {} });
const list = JSON.parse(lr.content[0].text);
check("insyte_list_metrics returns ids, titles, definitions, caveats and makes no Insyte calls",
  list.metrics.map((m) => m.id).join() === "sold_revenue,closed_revenue,service_jobs,jobs_by_stage,won_opportunities" &&
  list.metrics.every((m) => m.title && m.definition && m.caveats.length) && log.length === before, list.metrics.map((m) => m.id));
check("list carries the UNVERIFIED and CONFLICT markers", /\[UNVERIFIED\]/.test(lr.content[0].text) && /\[CONFLICT\]/.test(lr.content[0].text), "");
check("server instructions mention insyte_metric", /insyte_metric/.test(one.getInstructions?.() ?? ""), one.getInstructions?.());

// --- sold revenue --------------------------------------------------------------------------
log.length = 0;
let r = await metric(one, { metric: "sold_revenue", from: "2026-06-01", to: "2026-07-31" });
check("sold_revenue: 381.05 + 1000 + 6000 = 7381.05 over 604 order jobs, 605 opportunities scanned", r.body?.value === 7381.05 && r.body.matched === 604 && r.body.rowsScanned === 605, r.body ?? r);
const calls = log.filter((l) => l.top === 251);
check("sold_revenue pages to completion: three calls, skip 0/250/500, key orderby, count only on the first", calls.map((l) => l.skip).join() === "0,250,500" && calls.every((l) => l.orderby === "ID") && calls[0].count && !calls[1].count, calls);
check("sold_revenue filter uses the next day as an exclusive end, on Opportunities.CloseDate", calls[0].filter === "CloseDate ge 2026-06-01 and CloseDate lt 2026-08-01", calls[0].filter);
check("sold_revenue output carries definition, dateField, query, caveats, unit; no system with one system",
  /signed orders/.test(r.body?.definition) && r.body.dateField === "Opportunities.CloseDate" && /\$expand=Jobs\(/.test(r.body.query) && /\$orderby=ID/.test(r.body.query) &&
  r.body.caveats.some((c) => /\[CONFLICT\]/.test(c)) && r.body.caveats.some((c) => /timezone/.test(c)) && /ex tax/.test(r.body.unit) && !("system" in r.body), r.body);
r = await metric(one, { metric: "sold_revenue", from: "2026-06-01", to: "2026-07-31", groupBy: "month" });
check("sold_revenue by month: 2026-06 381.05 (3 jobs), 2026-07 7000 (601 jobs)", flat(r.body?.groups) === "2026-06=381.05/3 2026-07=7000/601" && r.body.value === 7381.05, r.body ?? r);
r = await metric(one, { metric: "sold_revenue", from: "2026-06-01", to: "2026-07-31", groupBy: "rep" });
check("sold_revenue by rep: 9=6000, none=1000, 7=331.05, 8=50", flat(r.body?.groups) === "9=6000/600 (no rep)=1000/1 7=331.05/2 8=50/1", r.body?.groups ?? r);

// --- closed revenue ------------------------------------------------------------------------
r = await metric(one, { metric: "closed_revenue", from: "2026-06-01", to: "2026-06-30" });
check("closed_revenue June: earliest-payment rule gives 500 + 50 + 75.75 = 625.75 (J11 belongs to May)", r.body?.value === 625.75 && r.body.matched === 3 && r.body.rowsScanned === 4, r.body ?? r);
check("closed_revenue query uses the PaymentAllocations lambda and the Payment expand", /PaymentAllocations\/any\(pa: pa\/Payment\/Date ge 2026-06-01 and pa\/Payment\/Date lt 2026-07-01\)/.test(r.body?.query) && /Payment\(\$select=ID,Date\)/.test(r.body.query), r.body?.query);
check("closed_revenue caveats carry multi-deposit TBD and the quote-stage conflict", r.body?.caveats.some((c) => /Multi-deposit attribution is TBD/.test(c)) && r.body.caveats.some((c) => /\[CONFLICT\]/.test(c)), r.body?.caveats);
r = await metric(one, { metric: "closed_revenue", from: "2026-05-01", to: "2026-06-30", groupBy: "month" });
check("closed_revenue May-June by month: 2026-05 900, 2026-06 625.75, total 1525.75", flat(r.body?.groups) === "2026-05=900/1 2026-06=625.75/3" && r.body.value === 1525.75, r.body ?? r);
r = await metric(one, { metric: "closed_revenue", from: "2026-06-01", to: "2026-06-30", groupBy: "rep" });
check("closed_revenue by rep: 7=550, none=75.75", flat(r.body?.groups) === "7=550/2 (no rep)=75.75/1", r.body?.groups ?? r);

// --- service jobs, jobs by stage, won opportunities ---------------------------------------
r = await metric(one, { metric: "service_jobs", from: "2026-03-01", to: "2026-05-31" });
check("service_jobs: 5, filtered on JobType type_job_service and JobDate", r.body?.value === 5 && /JobType eq 'type_job_service' and JobDate ge 2026-03-01 and JobDate lt 2026-06-01/.test(r.body.query), r.body ?? r);
r = await metric(one, { metric: "service_jobs", from: "2026-03-01", to: "2026-05-31", groupBy: "month" });
check("service_jobs by month: 03=2, 04=2, 05=1", flat(r.body?.groups) === "2026-03=2/2 2026-04=2/2 2026-05=1/1", r.body?.groups ?? r);
r = await metric(one, { metric: "service_jobs", from: "2026-03-01", to: "2026-05-31", groupBy: "rep" });
check("service_jobs by rep: 1=2, 2=2, none=1", flat(r.body?.groups) === "1=2/2 2=2/2 (no rep)=1/1", r.body?.groups ?? r);
r = await metric(one, { metric: "jobs_by_stage", from: "2026-06-01", to: "2026-06-30" });
check("jobs_by_stage: quote 3, order 2, lost 1, total 6", flat(r.body?.groups) === "stage_job_quote=3/3 stage_job_order=2/2 stage_job_lost=1/1" && r.body.value === 6, r.body ?? r);
r = await metric(one, { metric: "jobs_by_stage", from: "2026-06-01", to: "2026-06-30", groupBy: "month" });
check("jobs_by_stage refuses groupBy month and says what to use", /already split by Jobs\.Stage/.test(r.err ?? "") && !("body" in r), r);
r = await metric(one, { metric: "won_opportunities", from: "2026-06-01", to: "2026-07-31" });
check("won_opportunities: 3, filtered with contains(Status,'won') on CloseDate", r.body?.value === 3 && /contains\(Status,'won'\) and CloseDate ge 2026-06-01 and CloseDate lt 2026-08-01/.test(r.body.query), r.body ?? r);
r = await metric(one, { metric: "won_opportunities", from: "2026-06-01", to: "2026-07-31", groupBy: "month" });
check("won_opportunities by month: 06=2, 07=1", flat(r.body?.groups) === "2026-06=2/2 2026-07=1/1", r.body?.groups ?? r);
r = await metric(one, { metric: "won_opportunities", from: "2026-06-01", to: "2026-07-31", groupBy: "rep" });
check("won_opportunities by rep: 7=2, 8=1", flat(r.body?.groups) === "7=2/2 8=1/1", r.body?.groups ?? r);

// --- scan cap and partial-scan refusals ---------------------------------------------------
log.length = 0;
override = { rows: wonRows, fakeCount: 25000 };
r = await metric(one, { metric: "won_opportunities", from: "2020-01-01", to: "2026-07-31" });
check("scan cap by count: 25,000 rows refused after one request, with a narrowing hint, no value", /Refused/.test(r.err ?? "") && /25,000/.test(r.err) && /Narrow from and to/.test(r.err) && !/"value"/.test(r.err) && log.filter((l) => l.top === 251).length === 1, r.err ?? r.body);
const huge = Array.from({ length: 20_001 }, (_, i) => ({ ID: i + 1, CloseDate: "2026-06-02T08:00:00Z", RepresentativeID: 7 }));
override = { rows: huge, noCount: true };
r = await metric(one, { metric: "won_opportunities", from: "2020-01-01", to: "2026-07-31" });
check("scan cap with no count from Insyte: stops past 20,000 rows and refuses", /Refused/.test(r.err ?? "") && /more than 20,001/.test(r.err) && !("body" in r), r.err ?? r.body?.value);
override = { rows: huge.slice(0, 20_000), noCount: true };
r = await metric(one, { metric: "won_opportunities", from: "2020-01-01", to: "2026-07-31" });
check("exactly 20,000 rows is allowed and fully counted", r.body?.value === 20000 && r.body.rowsScanned === 20000, r.err ?? r.body);
override = { rows: wonRows, fakeCount: 4 };
r = await metric(one, { metric: "won_opportunities", from: "2026-06-01", to: "2026-07-31" });
check("count and rows disagree (records changed mid-scan): refused, no value", /changed during the scan/.test(r.err ?? "") && !("body" in r), r.err ?? r.body);
override = undefined;

// --- inputs ------------------------------------------------------------------------------
r = await metric(one, { metric: "sold_revenue", from: "2026-6-1", to: "2026-06-30" });
check("bad date format refused with an example", /YYYY-MM-DD/.test(r.err ?? "") && /2026-06-01/.test(r.err), r);
r = await metric(one, { metric: "sold_revenue", from: "2026-02-30", to: "2026-03-01" });
check("impossible calendar date refused", /real calendar date/.test(r.err ?? ""), r);
r = await metric(one, { metric: "sold_revenue", from: "2026-07-01", to: "2026-06-01" });
check("to before from refused", /before from/.test(r.err ?? ""), r);
r = await metric(one, { metric: "nope", from: "2026-06-01", to: "2026-06-30" });
check("unknown metric refused by the schema", !!r.err, r);

// --- several systems ------------------------------------------------------------------------
r = await metric(two, { metric: "service_jobs", from: "2026-03-01", to: "2026-05-31" });
check("two systems and no system: refused, names listed", /alpha, beta/.test(r.err ?? "") && !("body" in r), r);
r = await metric(two, { metric: "service_jobs", from: "2026-03-01", to: "2026-05-31", system: "beta" });
check("system beta: value 2 tagged with system beta", r.body?.value === 2 && r.body.system === "beta", r.body ?? r);
r = await metric(two, { metric: "service_jobs", from: "2026-03-01", to: "2026-05-31", system: "alpha" });
check("system alpha: value 5 tagged with system alpha", r.body?.value === 5 && r.body.system === "alpha", r.body ?? r);
r = await metric(two, { metric: "service_jobs", from: "2026-03-01", to: "2026-05-31", system: "gamma" });
check("unknown system refused with the real names", /No Insyte system named "gamma"/.test(r.err ?? "") && /alpha, beta/.test(r.err), r);

await one.close(); await two.close(); srv.close();
console.log(`\n${fails.length ? `${fails.length} FAILED` : "all checks passed"}`);
process.exit(fails.length ? 1 : 0);
