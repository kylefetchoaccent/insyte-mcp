// Find and overview tools for the people who use Insyte all day: look someone up, then see
// a job or a customer in one call instead of chaining insyte_query. Everything is read-only,
// one request at a time (Accent AUP 4.4), and rows carry only the fields each answer needs.

import { z } from "zod";
import { MAX_RESULT_CHARS, ToolModule, readOnly, run, systemShape, text } from "../server.js";
import { InsyteClient, InsyteError } from "../insyte.js";
import { withLabels } from "../codes.js";

type Row = Record<string, unknown>;

const KINDS = ["contacts", "companies", "jobs", "opportunities"] as const;
type Kind = (typeof KINDS)[number];

const JOB_HEADER =
  "ID,Reference,Stage,Status,JobType,JobDate,OrderDate,CloseDate,QuoteExpiryDate,ETADate,ProjectCustomerPO,IsSigned,IsConfirmed,LineCount,OnHoldLineCount,SalesRepID,ContactID,CompanyID,OpportunityID";
const LINE_SELECT =
  "ID,JobLineNo,Product,ProductCode,Location,Qty,Width,Drop,StandardPriceExTax,DiscountedPriceExTax,DiscountedPriceIncTax,Stage,Status,DispatchStage,LineType,ETA";
const ALLOC_SELECT = "ID,Amount";
const PAYMENT_SELECT = "ID,Date,Amount,Status";
const ACTIVITY_SELECT = "ID,Subject,Start,End,Status,ActivityType,Closed,Cancelled";
const INVOICE_SELECT = "ID,InvoiceNo,InvoiceDate,DueDate,CloseDate,Status,CreditNote";
const RECENT_ACTIVITIES = 5;
// Nested $select/$expand inside $expand is the only expand syntax tested against Insyte, so no
// nested $top or $orderby: the newest activities are picked here instead.
const JOB_EXPAND = [
  "SalesRep($select=ID,FullName)",
  "Contact($select=ID,FirstName,LastName,Mobile,Email)",
  "Company($select=ID,Name)",
  "Address($select=AddressLines,City,State,Postcode)",
  "Opportunity($select=ID,Status,PipelineStage,CloseDate)",
  `JobLines($select=${LINE_SELECT})`,
  `PaymentAllocations($select=${ALLOC_SELECT};$expand=Payment($select=${PAYMENT_SELECT}))`,
  `Activities($select=${ACTIVITY_SELECT})`,
].join(",");

export const recordsModule: ToolModule = {
  name: "records",
  profiles: ["public", "support"],
  instructions:
    "When the user names a person, company or reference, call insyte_find first to get the ID. Then use insyte_job_overview or insyte_customer_overview, which return a whole job or customer in one call, instead of chaining several insyte_query calls.",
  register(server, { conns }) {
    const sys = systemShape(conns);
    const tag = (system: string) => (conns.multi ? { system } : {});

    server.registerTool(
      "insyte_find",
      {
        title: "Find contacts, companies, jobs or opportunities",
        description:
          "Search by name, email, phone, job reference or customer PO. Returns matches grouped by kind with IDs and identifying fields only. Use the IDs with insyte_job_overview or insyte_customer_overview. Contacts and companies match each word separately, so 'jane smith' works.",
        inputSchema: {
          query: z.string().min(2).describe("Text to look for: a name, part of an email or phone number, a job reference like J0023497-6, or a customer PO."),
          kinds: z.array(z.enum(KINDS)).optional().describe("Limit the search to these kinds. Default: all four."),
          limit: z.number().int().min(1).max(25).default(10).describe("Most matches per kind (1-25, default 10)."),
          ...sys,
        },
        annotations: readOnly,
      },
      async ({ query, kinds, limit, system }) =>
        run(async () => {
          const { name, client } = await conns.connect(system);
          const q = query.trim();
          const results: Record<string, unknown> = {};
          // One request per kind, in order.
          for (const kind of kinds?.length ? [...new Set(kinds)] : KINDS) {
            try {
              results[kind] = await findKind(client, kind, q, limit);
            } catch (err) {
              // One kind failing should not hide matches in the others.
              results[kind] = { error: (err as Error).message };
            }
          }
          const none = Object.values(results).every((r) => (r as { returned?: number }).returned === 0);
          return text(
            fit(() => ({
              ...tag(name),
              query: q,
              results,
              ...(none ? { note: "No matches. Try fewer or shorter words, or part of an email or phone number." } : {}),
            })),
          );
        }),
    );

    server.registerTool(
      "insyte_job_overview",
      {
        title: "Overview of one job",
        description:
          "One job in one call: header, contact, company, site address, lines (product, quantity, prices, stage with a plain-English label), deposit status, invoices and recent activities. Raw codes stay next to their labels. Pass id or reference.",
        inputSchema: {
          id: z.number().int().optional().describe("The job's ID, from insyte_find."),
          reference: z.string().optional().describe("The job reference, e.g. 'J0023497-6'. A reference without its suffix lists the matching jobs."),
          ...sys,
        },
        annotations: readOnly,
      },
      async ({ id, reference, system }) =>
        run(async () => {
          if (id === undefined && !reference?.trim()) throw new InsyteError("Pass id or reference. Use insyte_find to look a job up.");
          const { name, client } = await conns.connect(system);
          const notes: string[] = [];
          let jobId = id;
          if (jobId === undefined) {
            const ref = reference!.trim();
            const exact = await client.query("Jobs", { select: "ID", filter: `Reference eq '${esc(ref)}'`, limit: 1 });
            if (exact.rows.length) jobId = (exact.rows[0] as Row).ID as number;
            else {
              // "J0023497" with no suffix: the suffixed jobs share its prefix.
              const near = await client.query("Jobs", { select: "ID,Reference,Stage,Status,JobType", filter: `startswith(Reference,'${esc(ref)}')`, orderby: "Reference", limit: 11 });
              if (!near.rows.length) throw new InsyteError(`No job has the reference "${ref}". Use insyte_find to search by part of the reference or the customer PO.`);
              if (near.rows.length > 1) {
                return text(
                  fit(() => ({
                    ...tag(name),
                    note: `No job has exactly "${ref}". These jobs start with it; call insyte_job_overview again with the id or full reference.`,
                    matches: near.rows.slice(0, 10).map((r) => clean(withLabels("Jobs", r as Row))),
                    ...(near.rows.length > 10 ? { hasMore: true } : {}),
                  })),
                );
              }
              jobId = (near.rows[0] as Row).ID as number;
            }
          }
          const loaded = await loadJob(client, jobId, notes);
          const invoices = await part(notes, "invoices", async () =>
            (await client.query("Invoices", { select: INVOICE_SELECT, filter: `JobID eq ${jobId}`, orderby: "InvoiceDate desc", limit: 25 })).rows as Row[],
          );
          return text(shapeJob(tag(name), loaded, invoices ?? [], notes));
        }),
    );

    server.registerTool(
      "insyte_customer_overview",
      {
        title: "Overview of one customer",
        description:
          "A contact or company with its details and its 10 newest jobs and opportunities (labels beside raw codes). Pass contactId or companyId, not both. A contact also matches jobs and opportunities where they are the site contact. Insyte does not link contacts to companies, so a company overview cannot list its contacts.",
        inputSchema: {
          contactId: z.number().int().optional().describe("Contact ID, from insyte_find."),
          companyId: z.number().int().optional().describe("Company ID, from insyte_find."),
          ...sys,
        },
        annotations: readOnly,
      },
      async ({ contactId, companyId, system }) =>
        run(async () => {
          if ((contactId === undefined) === (companyId === undefined)) throw new InsyteError("Pass exactly one of contactId or companyId. Use insyte_find to get the ID.");
          const { name, client } = await conns.connect(system);
          const notes: string[] = [];
          const isContact = contactId !== undefined;
          const idValue = (isContact ? contactId : companyId)!;

          let who: Row | undefined;
          if (isContact) {
            const sel = "ID,FirstName,LastName,JobTitle,Email,Mobile,WorkPhone,HomePhone";
            const expand = "Address($select=AddressLines,City,State,Postcode,Country)";
            try {
              who = (await client.query("Contacts", { select: sel, expand, filter: `ID eq ${idValue}`, limit: 1 })).rows[0] as Row | undefined;
            } catch (err) {
              if (!canRetry(err)) throw err;
              notes.push("Address left out: Insyte could not expand it.");
              who = (await client.query("Contacts", { select: sel, filter: `ID eq ${idValue}`, limit: 1 })).rows[0] as Row | undefined;
            }
          } else {
            who = (await client.query("Companies", { select: "ID,Name,Phone,Email,WWW,AccountType,AccountOnHold,TaxExempt,CreditLimit", filter: `ID eq ${idValue}`, limit: 1 })).rows[0] as Row | undefined;
          }
          if (!who) throw new InsyteError(`No ${isContact ? "contact" : "company"} has ID ${idValue}. Use insyte_find to look it up.`);

          const match = (a: string, b: string) => (isContact ? `(${a} eq ${idValue} or ${b} eq ${idValue})` : `CompanyID eq ${idValue}`);
          const jobs = await part(notes, "jobs", () =>
            client.query("Jobs", {
              select: "ID,Reference,Stage,Status,JobType,JobDate,OrderDate,CloseDate,OpportunityID",
              filter: match("ContactID", "SiteContactID"),
              orderby: "JobDate desc",
              limit: 10,
              count: true,
            }),
          );
          const opps = await part(notes, "opportunities", () =>
            client.query("Opportunities", {
              select: "ID,Description,Status,PipelineStage,LeadDate,CloseDate,CreatedOn",
              filter: match("ContactID", "SiteContactID"),
              orderby: "CreatedOn desc",
              limit: 10,
              count: true,
            }),
          );
          const list = (r: typeof jobs, set: string) =>
            r && {
              ...(r.totalCount !== undefined ? { total: r.totalCount } : {}),
              returned: r.rows.length,
              rows: r.rows.map((x) => clean(withLabels(set, x as Row))),
            };
          return text(
            fit(() => ({
              ...tag(name),
              [isContact ? "contact" : "company"]: clean(who!),
              jobs: list(jobs, "Jobs"),
              opportunities: list(opps, "Opportunities"),
              ...(notes.length ? { notes } : {}),
            })),
          );
        }),
    );
  },
};

// --- find ---------------------------------------------------------------------------------

async function findKind(client: InsyteClient, kind: Kind, q: string, limit: number): Promise<unknown> {
  const spec = findSpec(kind, q);
  const res = await client.query(spec.set, { select: spec.select, filter: spec.filter, orderby: spec.orderby, limit });
  return { returned: res.rows.length, hasMore: res.hasMore, rows: res.rows.map((r) => clean(withLabels(spec.set, r as Row))) };
}

function findSpec(kind: Kind, q: string): { set: string; select: string; filter: string; orderby: string } {
  switch (kind) {
    case "contacts":
      return {
        set: "Contacts",
        select: "ID,FirstName,LastName,Email,Mobile,WorkPhone,HomePhone",
        filter: wordFilter(q, ["FirstName", "LastName", "Email"], ["Mobile", "WorkPhone", "HomePhone"]),
        orderby: "ID desc",
      };
    case "companies":
      return {
        set: "Companies",
        select: "ID,Name,Phone,Email,AccountType",
        filter: wordFilter(q, ["Name", "Email"], ["Phone", "BusinessNumber"]),
        orderby: "ID desc",
      };
    case "jobs":
      return {
        set: "Jobs",
        select: "ID,Reference,ProjectCustomerPO,Stage,Status,JobType,JobDate,ContactID,CompanyID",
        filter: `contains(Reference,'${esc(q)}') or contains(ProjectCustomerPO,'${esc(q)}')`,
        orderby: "JobDate desc",
      };
    case "opportunities":
      // Opportunities have no reference field: match the description, or the ID when given a number.
      return {
        set: "Opportunities",
        select: "ID,Description,Status,PipelineStage,ContactID,CompanyID,LeadDate,CloseDate",
        filter: `contains(Description,'${esc(q)}')` + (/^\d{1,9}$/.test(q) ? ` or ID eq ${q}` : ""),
        orderby: "ID desc",
      };
  }
}

// Every word must match one of the fields. Words with letters try the text fields, words with
// three or more digits try the phone fields, so "jane 0412" and "j.smith@x.com" both work.
function wordFilter(q: string, textFields: string[], phoneFields: string[]): string {
  const clauses: string[] = [];
  for (const word of q.split(/\s+/).filter(Boolean).slice(0, 4)) {
    const fields = [...(/[a-z]/i.test(word) ? textFields : []), ...(/\d{3}/.test(word) ? phoneFields : [])];
    if (fields.length) clauses.push(`(${fields.map((f) => `contains(${f},'${esc(word)}')`).join(" or ")})`);
  }
  if (!clauses.length) throw new InsyteError("Search words need letters, or at least three digits for a phone number.");
  return clauses.join(" and ");
}

// --- job overview -------------------------------------------------------------------------

interface LoadedJob {
  job: Row;
  lines: Row[];
  allocations: Row[];
  activities: Row[];
  // Set when only the newest activities were read.
  activityTotal?: number;
}

async function loadJob(client: InsyteClient, id: number, notes: string[]): Promise<LoadedJob> {
  const filter = `ID eq ${id}`;
  try {
    const rows = (await client.query("Jobs", { select: JOB_HEADER, expand: JOB_EXPAND, filter, limit: 1 })).rows as Row[];
    if (!rows.length) throw new InsyteError(`No job has ID ${id}. Use insyte_find to look it up.`);
    const { JobLines, PaymentAllocations, Activities, ...job } = rows[0];
    return { job, lines: (JobLines as Row[]) ?? [], allocations: (PaymentAllocations as Row[]) ?? [], activities: (Activities as Row[]) ?? [] };
  } catch (err) {
    if (!canRetry(err)) throw err;
    notes.push(`One-call read failed (${(err as Error).message.slice(0, 160)}), so the parts were read separately. Contact, company, address and opportunity show IDs only.`);
  }
  // Fallback: header alone, then each part by its own route, so one bad part does not lose the rest.
  const job = ((await client.query("Jobs", { select: JOB_HEADER, filter, limit: 1 })).rows as Row[])[0];
  if (!job) throw new InsyteError(`No job has ID ${id}. Use insyte_find to look it up.`);
  const rel = (relation: string, select: string, expand?: string) =>
    part(notes, relation, async () => (await client.query("Jobs", { select, expand, limit: 500 }, { id, name: relation })).rows as Row[]);
  const lines = (await rel("JobLines", LINE_SELECT)) ?? [];
  const allocations = (await rel("PaymentAllocations", ALLOC_SELECT, `Payment($select=${PAYMENT_SELECT})`)) ?? [];
  // Activities is not a related list of Jobs, so filter the Activities set by JobID.
  const recent = await part(notes, "activities", () =>
    client.query("Activities", { select: ACTIVITY_SELECT, filter: `JobID eq ${id}`, orderby: "Start desc", limit: RECENT_ACTIVITIES, count: true }),
  );
  return { job, lines, allocations, activities: (recent?.rows as Row[]) ?? [], activityTotal: recent?.totalCount };
}

function shapeJob(tag: Row, { job, lines, allocations, activities, activityTotal }: LoadedJob, invoices: Row[], notes: string[]): string {
  const { SalesRep, Contact, Company, Address, Opportunity, ...header } = job;
  const payments = allocations.map((a) => {
    const p = (a.Payment ?? {}) as Row;
    return clean({ Amount: a.Amount, PaymentID: p.ID, Date: p.Date, PaymentAmount: p.Amount, Status: p.Status });
  });
  const allocated = allocations.reduce((sum, a) => sum + (Number(a.Amount) || 0), 0);
  const newest = [...activities].sort((a, b) => String(b.Start ?? "").localeCompare(String(a.Start ?? "")));
  const shownActivities = newest.slice(0, RECENT_ACTIVITIES);
  const labelled = lines.map((l) => clean(withLabels("JobLines", l)));
  const sizes = { lines: labelled.length, payments: payments.length, invoices: invoices.length };
  return fit(
    (cuts) => ({
      ...tag,
      job: clean({
        ...withLabels("Jobs", header),
        SalesRep,
        Contact,
        Company,
        Address,
        Opportunity: Opportunity && withLabels("Opportunities", Opportunity as Row),
      }),
      lines: labelled.slice(0, cuts.lines),
      // Any payment allocation counts as a deposit: Payments.IsDeposit is empty on almost every payment.
      deposit: { received: allocations.length > 0, allocationCount: allocations.length, allocatedTotal: allocated, payments: payments.slice(0, cuts.payments) },
      invoices: invoices.slice(0, cuts.invoices).map((i) => clean(i)),
      activities: { total: activityTotal ?? activities.length, recent: shownActivities.map((a) => clean(a)) },
      ...(notes.length || cuts.lines < sizes.lines || cuts.payments < sizes.payments || cuts.invoices < sizes.invoices
        ? {
            notes: [
              ...notes,
              ...(cuts.lines < sizes.lines ? [`Showing ${cuts.lines} of ${sizes.lines} lines to fit the output limit. Use insyte_get_related on JobLines with a filter for the rest.`] : []),
              ...(cuts.payments < sizes.payments ? [`Showing ${cuts.payments} of ${sizes.payments} payments to fit the output limit.`] : []),
              ...(cuts.invoices < sizes.invoices ? [`Showing ${cuts.invoices} of ${sizes.invoices} invoices to fit the output limit.`] : []),
            ],
          }
        : {}),
    }),
    sizes,
  );
}

// --- helpers ------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/'/g, "''");

// Null and empty values add nothing; a missing field means empty.
function clean(row: Row): Row {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined && v !== ""));
}

// An expand that Insyte rejects or cannot finish is worth one retry in smaller pieces.
function canRetry(err: unknown): boolean {
  return err instanceof InsyteError && (err.incomplete || err.status === 400 || (err.status !== undefined && err.status >= 500));
}

// Runs one optional part. On failure the answer still returns, with a note saying what is missing.
async function part<T>(notes: string[], what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof InsyteError && (err.status === 401 || err.status === 403)) throw err;
    notes.push(`Could not read ${what}: ${(err as Error).message.slice(0, 200)}`);
    return undefined;
  }
}

// Renders compact JSON and halves the longest list until it fits under the output cap.
function fit(build: (cuts: Record<string, number>) => object, sizes: Record<string, number> = {}): string {
  const cuts = { ...sizes };
  for (;;) {
    const out = JSON.stringify(build(cuts));
    const biggest = Object.keys(cuts).sort((a, b) => cuts[b] - cuts[a])[0];
    if (out.length <= MAX_RESULT_CHARS) return out;
    if (!biggest || cuts[biggest] === 0) {
      throw new InsyteError(`The answer comes to ${out.length} characters, over the ${MAX_RESULT_CHARS}-character limit, and nothing more can be cut. Use insyte_query with a narrow select.`);
    }
    cuts[biggest] = Math.floor(cuts[biggest] / 2);
  }
}
