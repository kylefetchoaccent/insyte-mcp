// Offline test for src/tools/records.ts and src/codes.ts: insyte_find, insyte_job_overview and
// insyte_customer_overview against a local mock of Insyte. The mock serves the saved US
// $metadata and synthetic rows with real field names, and REJECTS any $select, $expand or
// $filter that names a field or navigation the schema lacks, so a typo in a tool fails here.
// Mocks prove code paths, not Insyte behaviour. Exits 1 on any failure.
//   node test/records.offline.mjs    (after npm run build)
import http from "node:http";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Connections } from "../dist/connections.js";
import { createServer, MAX_RESULT_CHARS } from "../dist/server.js";
import { CODES, labelFor } from "../dist/codes.js";

const metadata = fs.readFileSync("test/fixtures/us-v2-metadata.xml", "utf8");
const openapi = fs.readFileSync("test/fixtures/us-openapi-v2.json", "utf8");

// --- schema from the fixture (regex is enough for this file's shape) ---------------------------
const types = {};
for (const m of metadata.matchAll(/<EntityType Name="(\w+)"[^>]*>([\s\S]*?)<\/EntityType>/g)) {
  types[m[1]] = {
    fields: new Set([...m[2].matchAll(/<Property Name="(\w+)"/g)].map((p) => p[1])),
    navs: new Map([...m[2].matchAll(/<NavigationProperty Name="(\w+)" Type="(?:Collection\()?[\w.]*\.(\w+)\)?"/g)].map((p) => [p[1], p[2]])),
  };
}
const setType = Object.fromEntries([...metadata.matchAll(/<EntitySet Name="(\w+)" EntityType="[^"]*\.(\w+)"/g)].map((m) => [m[1], m[2]]));
const TABLE_TYPE = { ...setType, Addresses: "V2_AddressRequestModel" };

// --- synthetic data ----------------------------------------------------------------------------
const D = (n) => `2026-10-${String(n).padStart(2, "0")}T09:00:00Z`;
const data = {
  Contacts: [
    { ID: 1, FirstName: "Jane", LastName: "Smith", Email: "jane.smith@example.com", Mobile: "0412 345 678", WorkPhone: null, HomePhone: "", JobTitle: "Owner", AddressID: 1, Notes: "SECRET NOTE" },
    { ID: 2, FirstName: "John", LastName: "Smythe", Email: "john@example.com", Mobile: "0499 111 222" },
    { ID: 3, FirstName: "Janet", LastName: "O'Brien", Email: "janet@example.com", Mobile: "0400 000 003" },
    ...Array.from({ length: 30 }, (_, i) => ({ ID: 10 + i, FirstName: "Bulk", LastName: `Smithson${i}`, Email: `b${i}@example.com`, Mobile: `0300 000 ${100 + i}` })),
  ],
  Companies: [
    { ID: 1, Name: "Smith Blinds Pty", Phone: "02 5550 1234", Email: "info@smithblinds.example", AccountType: "Wholesale" },
    { ID: 2, Name: "Acme Awnings", Phone: "02 5550 9999", Email: "acme@example.com" },
  ],
  Addresses: [{ ID: 1, AddressLines: "12 Oak St", City: "Tempe", State: "AZ", Postcode: "85284", Country: "United States" }],
  Users: [{ ID: 5, FullName: "Sam Rep", FirstName: "Sam", LastName: "Rep" }],
  Jobs: [
    { ID: 101, Reference: "J0023497-1", Stage: "stage_job_order", Status: "status_job_open", JobType: "type_job_sales", JobDate: D(5), CloseDate: null, ProjectCustomerPO: null, LineCount: 3, SalesRepID: 5, ContactID: 1, CompanyID: 1, OpportunityID: 211, AddressID: 1 },
    { ID: 102, Reference: "J0023497-6", Stage: "stage_job_order_edit", Status: "status_job_open", JobType: "type_job_service", JobDate: D(9), ProjectCustomerPO: null, LineCount: 0, SiteContactID: 1, CompanyID: 2 },
    { ID: 103, Reference: "J0000500-1", Stage: "stage_job_quote", Status: "status_job_open", JobType: "type_job_sales", JobDate: D(1), ProjectCustomerPO: "SMITH-PO-77", ContactID: 3 },
    { ID: 104, Reference: "J0000600-1", Stage: "stage_job_made_up", Status: "status_job_made_up", JobType: "type_job_made_up", JobDate: D(2), ContactID: 1 },
    { ID: 900, Reference: "J0099999-1", Stage: "stage_job_order", Status: "status_job_open", JobType: "type_job_sales", JobDate: D(3), LineCount: 400, ContactID: 2 },
  ],
  JobLines: [
    { ID: 1001, JobID: 101, JobLineNo: "1", Product: "Retreat Roller Shade", Qty: 2, StandardPriceExTax: 300, DiscountedPriceExTax: 250, DiscountedPriceIncTax: 267.5, Stage: "stage_job_line_confirmed", Status: "status_job_line_open", DispatchStage: "dispatch_job_line_install_not_booked", LineType: "type_job_line_new" },
    { ID: 1002, JobID: 101, JobLineNo: "2", Product: "Broadleaf Shutter", Qty: 1, DiscountedPriceExTax: 900, Stage: "stage_job_line_mystery", Status: "status_job_line_open", DispatchStage: "dispatch_job_line_installed", LineType: "type_job_line_remake" },
    { ID: 1003, JobID: 101, JobLineNo: "3", Product: "Zebra Shade", Qty: 3, DiscountedPriceExTax: 120, Stage: "stage_job_line_cm_completed", Status: "status_job_line_on_hold", Location: null },
    ...Array.from({ length: 400 }, (_, i) => ({ ID: 5000 + i, JobID: 900, JobLineNo: String(i + 1), Product: `Long product name ${i} ${"x".repeat(250)}`, Qty: 1, DiscountedPriceExTax: 10, Stage: "stage_job_line_supply", Status: "status_job_line_open", DispatchStage: "dispatch_job_line_collected" })),
  ],
  Payments: [{ ID: 7001, Date: D(6), Amount: 500, Status: "status_payment_confirmed" }],
  JobPaymentAllocations: [{ ID: 8001, JobID: 101, PaymentID: 7001, Amount: 500 }],
  Activities: Array.from({ length: 7 }, (_, i) => ({ ID: 3000 + i, JobID: 101, Subject: `Visit ${i + 1}`, Start: D(10 + i), Status: "activity_status_scheduled", ActivityType: "Check Measure", Closed: false })),
  Invoices: [{ ID: 4001, JobID: 101, InvoiceNo: "INV-1", InvoiceDate: D(7), Status: "status_invoice_paid", CreditNote: false }],
  Opportunities: [
    ...Array.from({ length: 12 }, (_, i) => ({ ID: 200 + i, Description: `Window job ${i}`, Status: i === 11 ? "status_lead_won" : "status_lead_open", PipelineStage: i === 11 ? "stage_lead_contract" : "stage_lead_quotation", ContactID: 1, CreatedOn: D(i + 1), LeadDate: D(i + 1) })),
    { ID: 300, Description: "Smith kitchen blinds", Status: "status_lead_lost", PipelineStage: "stage_lead_lost", ContactID: 3, CompanyID: 1, CreatedOn: D(20) },
  ],
};

const NAVS = {
  Jobs: {
    SalesRep: (r) => one("Users", "ID", r.SalesRepID),
    Contact: (r) => one("Contacts", "ID", r.ContactID),
    Company: (r) => one("Companies", "ID", r.CompanyID),
    Address: (r) => one("Addresses", "ID", r.AddressID),
    Opportunity: (r) => one("Opportunities", "ID", r.OpportunityID),
    JobLines: (r) => ({ table: "JobLines", rows: data.JobLines.filter((l) => l.JobID === r.ID) }),
    PaymentAllocations: (r) => ({ table: "JobPaymentAllocations", rows: data.JobPaymentAllocations.filter((a) => a.JobID === r.ID) }),
    Activities: (r) => ({ table: "Activities", rows: data.Activities.filter((a) => a.JobID === r.ID) }),
  },
  JobPaymentAllocations: { Payment: (r) => one("Payments", "ID", r.PaymentID) },
  Contacts: { Address: (r) => one("Addresses", "ID", r.AddressID) },
};
function one(table, key, value) {
  const row = value == null ? undefined : data[table].find((x) => x[key] === value);
  return { table, row };
}

// --- mock server -------------------------------------------------------------------------------
const mode = { expandFails: false, failRoute: null };
const log = [];
const invalid = [];
let inflight = 0, maxInflight = 0;

class Bad extends Error {}

function splitTop(s, sep) {
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function parseExpand(expand) {
  return splitTop(expand, ",").map((item) => {
    const m = /^(\w+)(?:\((.*)\))?$/s.exec(item.trim());
    if (!m) throw new Bad(`bad expand item ${item}`);
    const opts = {};
    for (const o of splitTop(m[2] ?? "", ";")) {
      const eq = o.indexOf("=");
      opts[o.slice(0, eq)] = o.slice(eq + 1);
    }
    return { nav: m[1], opts };
  });
}
function checkShape(type, select, expand) {
  const t = types[type];
  if (!t) throw new Bad(`unknown type ${type}`);
  for (const f of splitTop(select ?? "", ",")) if (!t.fields.has(f.trim()) && !t.navs.has(f.trim())) throw new Bad(`${type} has no field ${f}`);
  for (const { nav, opts } of expand ? parseExpand(expand) : []) {
    const target = t.navs.get(nav);
    if (!target) throw new Bad(`${type} has no navigation ${nav}`);
    for (const k of Object.keys(opts)) if (!["$select", "$expand"].includes(k)) throw new Bad(`nested option ${k} not used against Insyte`);
    checkShape(target, opts.$select, opts.$expand);
  }
}
function project(table, row, select, expand) {
  const out = select ? Object.fromEntries(splitTop(select, ",").map((f) => [f, row[f]]).filter(([, v]) => v !== undefined)) : { ...row };
  for (const { nav, opts } of expand ? parseExpand(expand) : []) {
    const res = NAVS[table][nav](row);
    if (res.rows) out[nav] = res.rows.map((r) => project(res.table, r, opts.$select, opts.$expand));
    else out[nav] = res.row ? project(res.table, res.row, opts.$select, opts.$expand) : null;
  }
  return out;
}
// $filter: or / and / parentheses / contains / startswith / eq. Anything else is a failure.
function compileFilter(src, type) {
  const toks = [];
  const re = /\s*(\(|\)|,|'(?:[^']|'')*'|-?\d+(?:\.\d+)?|[A-Za-z_][\w/]*)/y;
  let m, pos = 0;
  while (pos < src.length && (m = (re.lastIndex = pos, re.exec(src)))) { toks.push(m[1]); pos = re.lastIndex; }
  if (pos < src.trimEnd().length) throw new Bad(`cannot parse filter at ${src.slice(pos)}`);
  let i = 0;
  const eat = (t) => { if (toks[i] !== t) throw new Bad(`expected ${t} got ${toks[i]}`); i++; };
  const field = (f) => { if (!types[type].fields.has(f)) throw new Bad(`${type} has no field ${f}`); return f; };
  const lit = (t) => (t.startsWith("'") ? t.slice(1, -1).replace(/''/g, "'") : Number(t));
  const atom = () => {
    if (toks[i] === "(") { i++; const f = or(); eat(")"); return f; }
    const t = toks[i++];
    if (t === "contains" || t === "startswith") {
      eat("("); const f = field(toks[i++]); eat(","); const v = String(lit(toks[i++])).toLowerCase(); eat(")");
      return (r) => (t === "contains" ? String(r[f] ?? "").toLowerCase().includes(v) : String(r[f] ?? "").toLowerCase().startsWith(v));
    }
    const f = field(t); eat("eq"); const v = lit(toks[i++]);
    return (r) => (typeof v === "number" ? Number(r[f]) === v : r[f] === v);
  };
  const and = () => { let l = atom(); while (toks[i] === "and") { i++; const a = l, b = atom(); l = (r) => a(r) && b(r); } return l; };
  const or = () => { let l = and(); while (toks[i] === "or") { i++; const a = l, b = and(); l = (r) => a(r) || b(r); } return l; };
  const f = or();
  if (i < toks.length) throw new Bad(`unexpected ${toks[i]}`);
  return f;
}

function listRows(table, rows, u) {
  const type = TABLE_TYPE[table];
  const select = u.searchParams.get("$select"), expand = u.searchParams.get("$expand");
  checkShape(type, select, expand);
  let out = rows;
  if (u.searchParams.get("$filter")) out = out.filter(compileFilter(u.searchParams.get("$filter"), type));
  const ob = u.searchParams.get("$orderby");
  if (ob) {
    const [f, dir] = ob.split(" ");
    if (!types[type].fields.has(f)) throw new Bad(`${type} has no field ${f}`);
    out = [...out].sort((a, b) => (a[f] > b[f] ? 1 : a[f] < b[f] ? -1 : 0) * (dir === "desc" ? -1 : 1));
  }
  const total = out.length;
  const skip = +(u.searchParams.get("$skip") ?? 0), top = +(u.searchParams.get("$top") ?? 1000);
  const body = { value: out.slice(skip, skip + top).map((r) => project(table, r, select, expand)) };
  if (u.searchParams.get("$count")) body["@odata.count"] = total;
  return body;
}

const srv = http.createServer(async (req, res) => {
  inflight++; maxInflight = Math.max(maxInflight, inflight);
  res.on("finish", () => inflight--);
  await new Promise((r) => setTimeout(r, 3)); // long enough for parallel requests to overlap
  const u = new URL(req.url, "http://x");
  const send = (code, body) => res.writeHead(code, { "content-type": "application/json" }).end(typeof body === "string" ? body : JSON.stringify(body));
  if (u.pathname === "/v2/$metadata") { res.writeHead(200, { "content-type": "application/xml" }).end(metadata); return; }
  if (u.pathname === "/openapi.v2.json") { send(200, openapi); return; }
  const m = /^\/v2\/(\w+)(?:\((\d+)\))?(?:\/(\w+))?$/.exec(u.pathname);
  if (!m) { res.writeHead(404).end(); return; }
  if (req.headers.authorization !== "X-ApiKey testkey") { res.writeHead(401).end(); return; }
  const [, set, id, rel] = m;
  if (!data[set]) { res.writeHead(404).end(); return; }
  if (u.searchParams.get("$top") !== "1" || u.searchParams.get("$filter")) log.push(`${set}${id ? `(${id})` : ""}${rel ? `/${rel}` : ""}`);
  try {
    if (set === "Jobs" && !rel && mode.expandFails && /JobLines/.test(u.searchParams.get("$expand") ?? "")) {
      send(500, { error: { message: "Exception has been thrown by the target of an invocation." } });
      return;
    }
    if (rel && mode.failRoute === rel) { send(500, { error: { message: "Exception has been thrown by the target of an invocation." } }); return; }
    if (rel) {
      const parent = data[set].find((r) => String(r.ID) === id);
      const nav = NAVS[set]?.[rel];
      if (!parent || !nav) { send(404, { error: { message: "no such route" } }); return; }
      const { table, rows } = nav(parent);
      send(200, listRows(table, rows, u));
      return;
    }
    if (id) {
      const row = data[set].find((r) => String(r.ID) === id);
      if (!row) { res.writeHead(404).end(); return; }
      send(200, project(set, row, u.searchParams.get("$select"), u.searchParams.get("$expand")));
      return;
    }
    send(200, listRows(set, data[set], u));
  } catch (err) {
    if (!(err instanceof Bad)) throw err;
    invalid.push(`${req.url} -> ${err.message}`);
    send(400, { error: { message: `The query specified in the URI is not valid. ${err.message}` } });
  }
});
await new Promise((r) => srv.listen(0, r));
const base = `http://127.0.0.1:${srv.address().port}`;

// --- harness -----------------------------------------------------------------------------------
async function connect(names) {
  const conns = new Connections(names.map((name) => ({ name, base, apiKey: "testkey", source: "test" })), "auto");
  const server = createServer(conns, { profile: "support" });
  const client = new Client({ name: "records-test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const call = async (client, name, args) => {
  let r;
  try {
    r = await client.callTool({ name, arguments: args });
  } catch (err) {
    return { error: err.message }; // the SDK may reject bad arguments as a protocol error
  }
  const t = r.content[0].text;
  if (r.isError) return { error: t };
  return { text: t, json: JSON.parse(t) };
};
const fails = [];
let passed = 0;
const check = (label, ok, got) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 400)}`}`);
  if (ok) passed++; else fails.push(label);
};
const reqs = (fn) => (log.length = 0, fn().then((r) => [r, [...log]]));

// --- tests -------------------------------------------------------------------------------------
const one1 = await connect(["alpha"]);

// codes
check("labelFor gives label and source for a confirmed code", labelFor("JobLines.Stage", "stage_job_line_confirmed")?.label === "Confirmed" && !!labelFor("JobLines.Stage", "stage_job_line_confirmed")?.source);
check("labelFor is undefined for an unknown code and unknown field", labelFor("JobLines.Stage", "stage_job_line_mystery") === undefined && labelFor("Nope.Field", "x") === undefined && labelFor("Jobs.Stage", "__proto__") === undefined);
check("a real code with no source label stays unlabelled", labelFor("Jobs.Stage", "stage_job_order_edit") === undefined && labelFor("Jobs.Status", "status_job_open") === undefined);
check("every label has a non-empty source", Object.values(CODES).every((t) => Object.values(t).every((e) => e.label && e.source)));
const knownCols = (field) => { const [set, f] = field.split("."); return types[setType[set]]?.fields.has(f); };
check("every coded field exists in the US schema", Object.keys(CODES).every(knownCols), Object.keys(CODES).filter((k) => !knownCols(k)));

const instr = one1.getInstructions() ?? "";
check("module instructions reach the server instructions", /insyte_find first/.test(instr) && /insyte_job_overview/.test(instr));

// find
let [r, seen] = await reqs(() => call(one1, "insyte_find", { query: "smith" }));
check("find 'smith' hits all four kinds", r.json && ["contacts", "companies", "jobs", "opportunities"].every((k) => r.json.results[k].returned >= 1), r.error ?? r.json.results);
check("find: default limit 10 caps contacts and says more", r.json.results.contacts.returned === 10 && r.json.results.contacts.hasMore === true);
check("find: one request per kind, in order", seen.join(",") === "Contacts,Companies,Jobs,Opportunities", seen);
check("find: no system key with one system", !("system" in r.json));
check("find: rows carry identifying fields only (no Notes, no JobTitle)", !r.text.includes("SECRET NOTE") && !("JobTitle" in r.json.results.contacts.rows[0]) && !("Notes" in r.json.results.contacts.rows[0]));
check("find: empty fields are dropped", r.json.results.contacts.rows.every((x) => !("WorkPhone" in x) || x.WorkPhone));
r = await call(one1, "insyte_find", { query: "smith", limit: 3, kinds: ["contacts"] });
check("find respects limit 3 and kinds", r.json.results.contacts.returned === 3 && Object.keys(r.json.results).join() === "contacts", r.json ?? r.error);
r = await call(one1, "insyte_find", { query: "smith", limit: 25, kinds: ["contacts"] });
check("find limit 25 returns 25 of 31", r.json.results.contacts.returned === 25 && r.json.results.contacts.hasMore === true);
r = await call(one1, "insyte_find", { query: "smith", limit: 26 });
check("find rejects limit over 25", !!r.error, r);
r = await call(one1, "insyte_find", { query: "jane smith", kinds: ["contacts"] });
check("find: two words must both match", r.json?.results.contacts.returned === 1 && r.json.results.contacts.rows[0].ID === 1, r.json ?? r.error);
r = await call(one1, "insyte_find", { query: "o'brien", kinds: ["contacts"] });
check("find: apostrophe is escaped", r.json?.results.contacts.returned === 1 && r.json.results.contacts.rows[0].ID === 3, r.json ?? r.error);
r = await call(one1, "insyte_find", { query: "0412 345", kinds: ["contacts"] });
check("find: phone fragments match phone fields", r.json?.results.contacts.rows.map((x) => x.ID).join() === "1", r.json ?? r.error);
r = await call(one1, "insyte_find", { query: "J0023497", kinds: ["jobs"] });
check("find: job reference prefix, labels beside codes", r.json?.results.jobs.returned === 2 && r.json.results.jobs.rows.some((j) => j.Stage === "stage_job_order" && j.StageLabel === "Order"), r.json ?? r.error);
check("find: unlabelled real code has no label key", r.json.results.jobs.rows.find((j) => j.ID === 102)?.StageLabel === undefined && r.json.results.jobs.rows.find((j) => j.ID === 102)?.Stage === "stage_job_order_edit");
r = await call(one1, "insyte_find", { query: "SMITH-PO", kinds: ["jobs"] });
check("find: matches customer PO", r.json?.results.jobs.rows[0]?.ID === 103);
r = await call(one1, "insyte_find", { query: "kitchen", kinds: ["opportunities"] });
check("find: opportunities match description, status labelled", r.json?.results.opportunities.rows[0]?.StatusLabel === "Lost", r.json ?? r.error);
r = await call(one1, "insyte_find", { query: "zzzzzz" });
check("find: no match gives a note, not an error", r.json?.note?.includes("No matches"), r.json ?? r.error);
r = await call(one1, "insyte_find", { query: "--" , kinds: ["contacts"] });
check("find: unsearchable words give a plain error per kind", /letters/.test(r.json?.results.contacts.error ?? ""), r.json ?? r.error);

// job overview
[r, seen] = await reqs(() => call(one1, "insyte_job_overview", { id: 101 }));
const j = r.json;
check("job overview by id: header, labels and raw codes", j?.job.Reference === "J0023497-1" && j.job.Stage === "stage_job_order" && j.job.StageLabel === "Order" && j.job.StatusLabel === undefined && j.job.JobTypeLabel === "Sales", j ?? r.error);
check("job overview: one expanded request plus invoices", seen.join(",") === "Jobs,Invoices", seen);
check("job overview: contact, company, address, rep, opportunity from the expand", j.job.Contact.FirstName === "Jane" && j.job.Company.Name === "Smith Blinds Pty" && j.job.Address.City === "Tempe" && j.job.SalesRep.FullName === "Sam Rep" && j.job.Opportunity.StatusLabel === "Won" && j.job.Opportunity.PipelineStage === "stage_lead_contract");
check("job overview: null fields dropped", !("CloseDate" in j.job));
check("job overview: lines with labels, unknown code unlabelled", j.lines.length === 3 && j.lines[0].StageLabel === "Confirmed" && j.lines[0].Stage === "stage_job_line_confirmed" && j.lines[1].Stage === "stage_job_line_mystery" && !("StageLabel" in j.lines[1]) && j.lines[1].DispatchStageLabel === "Installed" && j.lines[1].LineTypeLabel === "Remake" && j.lines[2].StageLabel === "CM Completed (Unconfirmed variant)" && j.lines[2].StatusLabel === "On hold", j.lines);
check("job overview: line quantity and price fields present", j.lines[0].Qty === 2 && j.lines[0].DiscountedPriceExTax === 250 && j.lines[0].Product === "Retreat Roller Shade");
check("job overview: any allocation counts as a deposit", j.deposit.received === true && j.deposit.allocatedTotal === 500 && j.deposit.payments[0].Date === D(6) && j.deposit.payments[0].Status === "status_payment_confirmed", j.deposit);
check("job overview: invoices with raw status", j.invoices.length === 1 && j.invoices[0].InvoiceNo === "INV-1" && j.invoices[0].Status === "status_invoice_paid");
check("job overview: 5 newest activities of 7", j.activities.total === 7 && j.activities.recent.length === 5 && j.activities.recent[0].Subject === "Visit 7" && j.activities.recent[4].Subject === "Visit 3");
check("job overview: no notes when all went well", !("notes" in j));
r = await call(one1, "insyte_job_overview", { id: 102 });
check("job overview: no deposit, no lines, unlabelled stage kept raw", r.json?.deposit.received === false && r.json.lines.length === 0 && r.json.job.Stage === "stage_job_order_edit" && !("StageLabel" in r.json.job), r.json ?? r.error);
r = await call(one1, "insyte_job_overview", { id: 104 });
check("job overview: made-up job codes pass through with no labels", r.json?.job.Stage === "stage_job_made_up" && !("StageLabel" in r.json.job) && !("StatusLabel" in r.json.job) && !("JobTypeLabel" in r.json.job), r.json ?? r.error);
r = await call(one1, "insyte_job_overview", { reference: "J0023497-6" });
check("job overview by exact reference", r.json?.job.ID === 102, r.json ?? r.error);
r = await call(one1, "insyte_job_overview", { reference: "J0023497" });
check("job overview: bare reference lists the suffixed jobs", r.json?.matches?.length === 2 && /call insyte_job_overview again/.test(r.json.note), r.json ?? r.error);
r = await call(one1, "insyte_job_overview", { reference: "J0000500" });
check("job overview: bare reference with one match opens it", r.json?.job.ID === 103, r.json ?? r.error);
r = await call(one1, "insyte_job_overview", { reference: "nope" });
check("job overview: unknown reference says what to do", /insyte_find/.test(r.error ?? ""), r);
r = await call(one1, "insyte_job_overview", {});
check("job overview: needs id or reference", /id or reference/.test(r.error ?? ""), r);
r = await call(one1, "insyte_job_overview", { id: 12345 });
check("job overview: unknown id says what to do", /insyte_find/.test(r.error ?? ""), r);

// fallback
mode.expandFails = true;
[r, seen] = await reqs(() => call(one1, "insyte_job_overview", { id: 101 }));
const f = r.json;
check("fallback: same lines, deposit and activities without the expand", f?.lines.length === 3 && f.lines[0].StageLabel === "Confirmed" && f.deposit.received === true && f.deposit.allocatedTotal === 500 && f.deposit.payments[0].Date === D(6) && f.activities.total === 7 && f.activities.recent.length === 5, f ?? r.error);
check("fallback: says it read in parts, contact is an ID only", f.notes?.some((n) => /read separately/.test(n)) && f.job.ContactID === 1 && !("Contact" in f.job));
check("fallback: sequential relation routes, activities by filter", seen.join(",") === "Jobs,Jobs,Jobs(101)/JobLines,Jobs(101)/PaymentAllocations,Activities,Invoices", seen);
mode.failRoute = "JobLines";
r = await call(one1, "insyte_job_overview", { id: 101 });
check("fallback: one failed part is named and the rest still returned", r.json?.lines.length === 0 && r.json.deposit.received === true && r.json.notes.some((n) => /Could not read JobLines/.test(n)), r.json ?? r.error);
mode.failRoute = null;
mode.expandFails = false;

// cap
r = await call(one1, "insyte_job_overview", { id: 900 });
check("output under the cap for a 400-line job", !!r.text && r.text.length <= MAX_RESULT_CHARS && r.text.length > 20_000, r.text?.length ?? r.error);
check("cut lines are said, not silent", r.json?.lines.length > 0 && r.json.lines.length < 400 && r.json.notes.some((n) => new RegExp(`Showing ${r.json.lines.length} of 400 lines`).test(n)), r.json?.notes);

// customer overview
r = await call(one1, "insyte_customer_overview", { contactId: 1 });
const c = r.json;
check("customer overview: contact details with address", c?.contact.FirstName === "Jane" && c.contact.Address.City === "Tempe" && !r.text.includes("SECRET NOTE"), c ?? r.error);
check("customer overview: jobs newest first, site-contact jobs included, labelled", c.jobs.rows.map((x) => x.ID).join() === "102,101,104" && c.jobs.total === 3 && c.jobs.rows[1].StageLabel === "Order", c.jobs);
check("customer overview: opportunities limited to 10, newest first, total counted", c.opportunities.returned === 10 && c.opportunities.total === 12 && c.opportunities.rows[0].ID === 211 && c.opportunities.rows[0].StatusLabel === "Won" && c.opportunities.rows[0].PipelineStage === "stage_lead_contract" && !("PipelineStageLabel" in c.opportunities.rows[0]), c.opportunities.rows.map((x) => x.ID));
r = await call(one1, "insyte_customer_overview", { companyId: 1 });
check("customer overview: company with its jobs and opportunities", r.json?.company.Name === "Smith Blinds Pty" && r.json.jobs.rows.map((x) => x.ID).join() === "101" && r.json.opportunities.rows[0].ID === 300 && r.json.opportunities.rows[0].PipelineStageLabel === "Lost", r.json ?? r.error);
r = await call(one1, "insyte_customer_overview", { contactId: 1, companyId: 1 });
check("customer overview: both ids refused", /exactly one/.test(r.error ?? ""), r);
r = await call(one1, "insyte_customer_overview", {});
check("customer overview: no id refused", /exactly one/.test(r.error ?? ""), r);
r = await call(one1, "insyte_customer_overview", { contactId: 99999 });
check("customer overview: unknown id says what to do", /insyte_find/.test(r.error ?? ""), r);

// two systems
const two = await connect(["alpha", "beta"]);
for (const [tool, args] of [["insyte_find", { query: "smith" }], ["insyte_job_overview", { id: 101 }], ["insyte_customer_overview", { contactId: 1 }]]) {
  const bad = await call(two, tool, args);
  check(`${tool}: system required with two systems`, /alpha, beta/.test(bad.error ?? "") && /system/i.test(bad.error ?? ""), bad);
  const good = await call(two, tool, { ...args, system: "BETA" });
  check(`${tool}: result tagged with system`, good.json?.system === "beta", good.json ?? good.error);
}
r = await call(two, "insyte_find", { query: "smith", system: "gamma" });
check("unknown system lists the real ones", /alpha, beta/.test(r.error ?? ""), r);

// no request ever had a field the schema lacks, and none overlapped
check("mock saw no field or navigation outside the US schema", invalid.length === 0, invalid);
check("requests never overlapped", maxInflight === 1, maxInflight);

await one1.close(); await two.close(); srv.close();
console.log(`\n${passed} passed, ${fails.length} failed${fails.length ? `: ${fails.join("; ")}` : ""}`);
process.exit(fails.length ? 1 : 0);
