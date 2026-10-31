// Asserting check against a live tenant: every data set, every related list, codes, paging,
// errors. Needs INSYTE_API_KEY (and INSYTE_API_BASE unless auto-detect should be tested).
// Prints IDs and counts only, never record contents. Exits 1 on any failure.
//   node test/live.mjs [server entry, default dist/index.js]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = process.argv[2] ?? "dist/index.js";
const client = new Client({ name: "live", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: [entry], env: process.env, stderr: "inherit" }));

const outputs = [];
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const body = r.content.map((c) => c.text).join("\n");
  outputs.push(body);
  let parsed;
  try { parsed = JSON.parse(body); } catch {}
  return { err: !!r.isError, body, parsed };
};
const fails = [];
const check = (label, ok, info = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${info ? `  ${info}` : ""}`);
  if (!ok) fails.push(label);
};
const short = (r) => r.body.replace(/\s+/g, " ").slice(0, 200);

const list = await call("insyte_list_datasets", {});
const sets = [...list.body.matchAll(/^- (\w+)/gm)].map((m) => m[1]);
check("list_datasets", !list.err && sets.length > 0 && !/WARNING/.test(list.body), `${sets.length} sets; ${list.body.split("\n")[0]}`);

const described = {};
for (const s of sets) {
  const d = await call("insyte_describe_dataset", { dataset: s });
  const key = /Key: ([\w, ]*)/.exec(d.body)?.[1].split(", ") ?? [];
  const related = [...(d.body.split("## Related lists")[1] ?? "").matchAll(/^- (\w+)/gm)].map((m) => m[1]);
  described[s] = d.body;
  const q = await call("insyte_query", { dataset: s, select: key.join(","), orderby: `${key[0]} desc`, limit: 2, count: true });
  const ok = !q.err && Array.isArray(q.parsed?.rows);
  check(`query ${s}`, ok, ok ? `returned=${q.parsed.returned} total=${q.parsed.totalCount}` : short(q));
  const whole = await call("insyte_query", { dataset: s, limit: 1 });
  check(`query ${s} without select`, !whole.err, whole.err ? short(whole) : whole.parsed.skipped ?? "");
  const parent = q.parsed?.rows?.[0]?.[key[0]];
  if (parent !== undefined && key.length === 1) {
    const rec = await call("insyte_get_record", { dataset: s, id: parent });
    check(`get_record ${s}(${parent}) without select`, !rec.err, rec.err ? short(rec) : rec.parsed?.note ?? "");
  }
  for (const rel of related) {
    if (parent === undefined) { console.log(`SKIP  related ${s}->${rel}  (no ${s} records)`); continue; }
    const r = await call("insyte_get_related", { dataset: s, id: parent, relation: rel, limit: 3, count: true });
    check(`related ${s}(${parent})->${rel}`, !r.err && Array.isArray(r.parsed?.rows), r.err ? short(r) : `returned=${r.parsed.returned}`);
  }
}

// Codes: describe must expose them, and filtering on a listed code must find records.
const stageCodes = /- Stage \(String\)[^\n]*Codes seen[^:]*: ([^\n.]+)/.exec(described.Jobs ?? "")?.[1].split(", ") ?? [];
check("Jobs.Stage codes listed", stageCodes.length > 0, stageCodes.join(","));
const quote = stageCodes.find((c) => /quote/.test(c)) ?? stageCodes[0];
if (quote) {
  const byCode = await call("insyte_query", { dataset: "Jobs", select: "ID", filter: `Stage eq '${quote}'`, limit: 1, count: true });
  check(`filter on code ${quote}`, !byCode.err && byCode.parsed.totalCount > 0, `total=${byCode.parsed?.totalCount}`);
}
const withCodes = Object.entries(described).filter(([, b]) => /Codes seen/.test(b)).map(([s]) => s);
check("codes found across data sets", withCodes.length >= 3, withCodes.join(","));

// Relations that used to break: route returns truncated JSON, or 404 for a missing single record.
const sjl = await call("insyte_query", { dataset: "SupplyJobLines", select: "ID,SupplyJobID", orderby: "ID desc", limit: 1 });
const sj = sjl.parsed?.rows?.[0]?.SupplyJobID;
if (sj !== undefined) {
  const viaFilter = await call("insyte_query", { dataset: "SupplyJobLines", select: "ID", filter: `SupplyJobID eq ${sj}`, limit: 100 });
  const viaRel = await call("insyte_get_related", { dataset: "SupplyJobs", id: sj, relation: "SupplyJobLines", select: "ID", limit: 100, count: true });
  const ids = (r) => (r.parsed?.rows ?? []).map((x) => x.ID).sort((a, b) => a - b).join(",");
  check(`SupplyJobs(${sj})->SupplyJobLines matches filter`, !viaRel.err && ids(viaRel) === ids(viaFilter) && ids(viaRel) !== "", `${ids(viaRel) || short(viaRel)} vs ${ids(viaFilter)}`);
  const paged = await call("insyte_get_related", { dataset: "SupplyJobs", id: sj, relation: "SupplyJobLines", select: "ID", orderby: "ID desc", limit: 1 });
  check("related fallback honours limit/orderby", !paged.err && paged.parsed.returned === 1, short(paged));
  const expanded = await call("insyte_query", { dataset: "SupplyJobs", select: "ID", expand: "SupplyJobLines", filter: `ID eq ${sj}`, limit: 1 });
  check("expand of unreadable set: works or explains nested $select", !expanded.err || /nested \$select/.test(expanded.body), short(expanded));
} else console.log("SKIP  SupplyJobs relation checks  (no SupplyJobLines records)");
const noLead = await call("insyte_query", { dataset: "Opportunities", select: "ID", filter: "ExternalLeadID eq null", limit: 1 });
const opp = noLead.parsed?.rows?.[0]?.ID;
if (opp !== undefined) {
  const r = await call("insyte_get_related", { dataset: "Opportunities", id: opp, relation: "ExternalLead", select: "ID" });
  check(`Opportunities(${opp})->ExternalLead empty, not an error`, !r.err && r.parsed.returned === 0, short(r));
} else console.log("SKIP  empty ExternalLead check  (every opportunity has a lead)");
const lineFields = /# JobLines[\s\S]*?## Fields\n([\s\S]*?)\n\n/.exec(described.JobLines ?? "")?.[1];
const jobFields = new Set([...(described.Jobs ?? "").matchAll(/^- (\w+) \(/gm)].map((m) => m[1]));
const lineOnly = [...(lineFields ?? "").matchAll(/^- (\w+) \(/gm)].map((m) => m[1]).find((f) => !jobFields.has(f));
const recentJob = await call("insyte_query", { dataset: "JobLines", select: "ID,JobID", orderby: "ID desc", limit: 1 });
const jobId = recentJob.parsed?.rows?.[0]?.JobID;
if (lineOnly && jobId !== undefined) {
  const r = await call("insyte_get_related", { dataset: "Jobs", id: jobId, relation: "JobLines", select: `ID,${lineOnly}`, limit: 1 });
  check(`related select uses child fields (${lineOnly})`, !r.err, short(r));
  const bad = await call("insyte_get_related", { dataset: "Jobs", id: jobId, relation: "JobLines", select: "ID,Reference", limit: 1 });
  check("related select rejects parent-only field locally", bad.err && /JobLines has no field "Reference"/.test(bad.body), short(bad));
} else console.log("SKIP  related select checks  (no JobLines records)");

// get_record
const job = (await call("insyte_query", { dataset: "Jobs", select: "ID", limit: 1 })).parsed?.rows?.[0]?.ID;
let r = await call("insyte_get_record", { dataset: "Jobs", id: String(job), select: "ID,Stage", expand: "SalesRep($select=ID)" });
check("get_record + expand", !r.err && r.parsed?.ID === job && "SalesRep" in r.parsed, short(r));
r = await call("insyte_get_record", { dataset: "Jobs", id: 999999999 });
check("get_record missing -> 404", r.err && /404/.test(r.body), short(r));
r = await call("insyte_get_record", { dataset: "Jobs", id: "abc" });
check("get_record bad id -> local error", r.err && /numbers/.test(r.body), short(r));

// Paging and caps
const ids = (x) => x.parsed.rows.map((y) => y.ID).join(",");
const a = await call("insyte_query", { dataset: "Jobs", select: "ID", orderby: "ID asc", limit: 10 });
const b1 = await call("insyte_query", { dataset: "Jobs", select: "ID", orderby: "ID asc", limit: 5 });
const b2 = await call("insyte_query", { dataset: "Jobs", select: "ID", orderby: "ID asc", limit: 5, skip: b1.parsed.nextSkip });
check("paging 10 == 5+5", ids(a) === `${ids(b1)},${ids(b2)}` && b1.parsed.nextSkip === 5);
const big = await call("insyte_query", { dataset: "Jobs", select: "ID", limit: 1000 });
check("limit 1000 has no duplicates", !big.err && new Set(big.parsed.rows.map((x) => x.ID)).size === big.parsed.returned, `returned=${big.parsed?.returned}`);
const wide = await call("insyte_query", { dataset: "JobLines", limit: 1000 });
check("wide rows trimmed with a note", !wide.err && wide.parsed.returned < 1000 && /Cut to/.test(wide.parsed.note ?? ""), `returned=${wide.parsed?.returned}`);
// The cap is 60,000 characters of the exact text returned; trimming packs close to it.
check("trimmed output fits the cap and packs near it", wide.body.length <= 60_000 && wide.body.length > 50_000, `chars=${wide.body.length}`);
const narrow = await call("insyte_query", { dataset: "Jobs", select: "ID,Reference,Stage,Status,JobDate,JobType", limit: 1000 });
check("narrow rows trimmed by fit, not halved", !narrow.err && narrow.body.length <= 60_000 && (narrow.parsed.returned === 1000 || narrow.body.length > 50_000), `returned=${narrow.parsed?.returned} chars=${narrow.body.length}`);

// Query errors
r = await call("insyte_query", { dataset: "Jobs", filter: "Nope eq 1", limit: 1 });
check("bad filter -> 400 with hint", r.err && /400/.test(r.body) && /insyte_describe_dataset/.test(r.body), short(r));
r = await call("insyte_query", { dataset: "Jobs", select: "ID,NotAField" });
check("bad select -> local error", r.err && /no field "NotAField"/.test(r.body), short(r));
const apiKey = process.env.INSYTE_API_KEY?.trim();
check("key never appears in any tool output", !apiKey || !outputs.some((o) => o.includes(apiKey)), `${outputs.length} outputs scanned`);

console.log(`\n${fails.length ? `${fails.length} FAILED:\n  ${fails.join("\n  ")}` : "all checks passed"}`);
await client.close();
process.exit(fails.length ? 1 : 0);
