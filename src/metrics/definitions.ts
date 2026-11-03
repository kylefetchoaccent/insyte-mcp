// Verified metric definitions. Each one pins the date field, the filter and the arithmetic, so
// the server returns one number with its definition attached instead of Claude re-deriving it.
// Every definition cites the memory file "01-odata-api-and-data-model.md" (KB below) and carries
// its [UNVERIFIED] and [CONFLICT] markers into caveats. Field names are checked against the
// saved US $metadata by test/metrics.offline.mjs (see `uses`).

import { InsyteError } from "../insyte.js";

export type GroupBy = "none" | "month" | "rep";
export type Row = Record<string, any>;

// One thing a row adds to the result: a count of 1 or an amount, on a date, for a rep.
export interface Item {
  date: string;
  rep: string;
  // Set when the metric has its own breakdown (jobs by stage).
  key?: string;
  n: number;
}

export interface MetricDef {
  id: string;
  title: string;
  definition: string;
  unit: string;
  dateField: string;
  dateWhy: string;
  // Name of the built-in breakdown shown even with groupBy none.
  breakdown?: string;
  groupings: GroupBy[];
  repField: string;
  dataset: string;
  // `to` is the day after the requested end date: a datetime compared with `le 2026-06-30`
  // would drop everything on the 30th after midnight.
  filter(from: string, toNext: string): string;
  select: string;
  expand?: string;
  computation: string;
  // Fields and navigations used, by data set, for the $metadata check in the tests.
  uses: Record<string, string[]>;
  contribute(row: Row, range: { from: string; to: string }): Item[];
  source: string[];
  caveats: string[];
}

const KB = "memory/insyte/01-odata-api-and-data-model.md";

// Caveats every metric shares.
const COMMON = [
  "[UNVERIFIED] Insyte does not document the timezone of its dates. Filters use bare YYYY-MM-DD and months come from the date text as returned (UTC, Z), so a day or month boundary can shift if the business keeps local time. [src: KB > Timezone, Known gaps]",
  "Figures are a live read at query time. Insyte keeps no history, so a later run can differ if records change.",
];

const SOLD_STAGES = ["stage_job_order", "stage_job_order_edit"];
const LINE_PRICE = "DiscountedPriceExTax";
const NO_REP = "(no rep)";

function num(v: unknown, what: string): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new InsyteError(`Insyte returned ${JSON.stringify(v)} for ${what}, which is not a number. Nothing was totalled. Check the field with insyte_describe_dataset.`);
  }
  return n;
}

function when(v: unknown, what: string): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) {
    throw new InsyteError(`Insyte returned ${JSON.stringify(v)} for ${what}, which is not a date. Nothing was totalled.`);
  }
  return v;
}

function list(v: unknown, what: string): Row[] {
  if (!Array.isArray(v)) {
    throw new InsyteError(`Insyte did not return ${what} for a record, so the total would be wrong. Nothing was totalled. Retry, or narrow the date range.`);
  }
  return v as Row[];
}

const rep = (v: unknown) => (v === null || v === undefined ? NO_REP : String(v));

const linesTotal = (job: Row) => list(job.JobLines, "JobLines").reduce((s, l) => s + num(l[LINE_PRICE], `JobLines.${LINE_PRICE}`), 0);

const LINE_NOTES = [
  `[UNVERIFIED] ${LINE_PRICE} is the price field used. The knowledge base says revenue is on lines but does not say which price field is "revenue"; StandardPriceExTax (before discount) and the IncTax fields give different totals. [src: KB > JobLines]`,
  "[UNVERIFIED] Every line on the job counts, including cancelled lines (status_job_line_cancelled exists, 192 on SWB), and the price is summed as stored, not multiplied by Qty. The knowledge base does not say how either is treated.",
];

export const METRICS: MetricDef[] = [
  {
    id: "sold_revenue",
    title: "Sold revenue",
    definition:
      `Total ${LINE_PRICE} (ex tax) of all lines on Jobs that are signed orders (Stage stage_job_order or stage_job_order_edit), counted in the period when the linked Opportunity's CloseDate falls. A deposit is not required.`,
    unit: `amount (sum of JobLines.${LINE_PRICE}, ex tax, in the tenant's currency)`,
    dateField: "Opportunities.CloseDate",
    dateWhy: "Jobs.CloseDate is the administrative closure date, after signing in every sampled row. The Opportunity's CloseDate is the sold anchor.",
    groupings: ["none", "month", "rep"],
    repField: "Jobs.SalesRepID",
    dataset: "Opportunities",
    filter: (from, toNext) => `CloseDate ge ${from} and CloseDate lt ${toNext}`,
    select: "ID,CloseDate",
    expand: `Jobs($select=ID,Stage,SalesRepID;$expand=JobLines($select=ID,${LINE_PRICE}))`,
    computation: `Scans Opportunities closed in the period. For each Job under them whose Stage is a sold stage, adds up JobLines.${LINE_PRICE}. The Stage test runs in the server code on the returned Jobs.`,
    uses: {
      Opportunities: ["ID", "CloseDate", "Jobs"],
      Jobs: ["ID", "Stage", "SalesRepID", "JobLines"],
      JobLines: ["ID", LINE_PRICE],
    },
    contribute(row) {
      const date = when(row.CloseDate, "Opportunities.CloseDate");
      return list(row.Jobs, "Jobs")
        .filter((j) => SOLD_STAGES.includes(j.Stage))
        .map((j) => ({ date, rep: rep(j.SalesRepID), n: linesTotal(j) }));
    },
    source: [
      `${KB} > Wrong-number traps (Jobs.CloseDate as a sold anchor; bare "revenue")`,
      `${KB} > Entities > Opportunities (CloseDate is the Sold Revenue anchor)`,
      `${KB} > Enumerations > Jobs.Stage (Sold cohort = order, order_edit)`,
      `${KB} > Contested semantics (Sold revenue gate)`,
    ],
    caveats: [
      "[CONFLICT] Kerry proposed that sold also needs a PaymentAllocation to exist. That was never confirmed, so this metric uses the reading in use: stage only, payment optional. Use closed_revenue for the deposit reading. [src: KB > Contested semantics]",
      "Jobs with no linked Opportunity cannot be dated by Opportunity.CloseDate and are not counted.",
      "[UNVERIFIED] The Opportunity's own Status is not checked, and service Jobs (JobType type_job_service) in a sold stage are included. The knowledge base says neither way.",
      "rep grouping uses the Job's SalesRepID. It matched the Opportunity's rep for 96% of Jobs in a 2026-07-24 SWB slice. Reps appear as Insyte user IDs. [src: KB > Jobs]",
      ...LINE_NOTES,
      ...COMMON,
    ],
  },
  {
    id: "closed_revenue",
    title: "Closed revenue",
    definition:
      `Total ${LINE_PRICE} (ex tax) of all lines on Jobs that have at least one PaymentAllocation linked to a Payment, counted in the period of the Job's earliest linked Payment date. Any linked payment counts as the deposit.`,
    unit: `amount (sum of JobLines.${LINE_PRICE}, ex tax, in the tenant's currency)`,
    dateField: "Payments.Date (earliest payment linked to the Job)",
    dateWhy: "Payments.Date is the Closed Revenue anchor. Payments.IsDeposit is empty on 99.2% of payments since 2025-01-01, so it is never used. The earliest payment date is the default for Jobs with several payments.",
    groupings: ["none", "month", "rep"],
    repField: "Jobs.SalesRepID",
    dataset: "Jobs",
    filter: (from, toNext) => `PaymentAllocations/any(pa: pa/Payment/Date ge ${from} and pa/Payment/Date lt ${toNext})`,
    select: "ID,Stage,SalesRepID",
    expand: `PaymentAllocations($expand=Payment($select=ID,Date)),JobLines($select=ID,${LINE_PRICE})`,
    computation: `Scans Jobs with a payment dated in the period. Keeps a Job only if its earliest linked payment date is inside the period, then adds up JobLines.${LINE_PRICE}. The Job's Stage is not checked.`,
    uses: {
      Jobs: ["ID", "Stage", "SalesRepID", "PaymentAllocations", "JobLines"],
      JobPaymentAllocations: ["Payment"],
      Payments: ["ID", "Date"],
      JobLines: ["ID", LINE_PRICE],
    },
    contribute(row, range) {
      const dates = list(row.PaymentAllocations, "PaymentAllocations")
        .map((a) => a.Payment)
        .filter((p) => p && p.Date !== null && p.Date !== undefined)
        .map((p) => when(p.Date, "Payments.Date"));
      if (!dates.length) return [];
      const first = dates.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
      // The server filter matches a Job with any payment in the period; ownership is the earliest.
      if (first.slice(0, 10) < range.from || first.slice(0, 10) > range.to) return [];
      return [{ date: first, rep: rep(row.SalesRepID), n: linesTotal(row) }];
    },
    source: [
      `${KB} > Wrong-number traps (Payments.IsDeposit; quote-stage Jobs holding a deposit; multi-deposit attribution)`,
      `${KB} > Query patterns > Cross-entity lambda filtering (the Closed-Revenue-MTD pattern)`,
      `${KB} > Entities > Payments (Date is the Closed Revenue anchor), JobPaymentAllocations`,
    ],
    caveats: [
      "[UNVERIFIED] Multi-deposit attribution is TBD. Earliest payment date is the default (matches the salesperson view). Accountants may want the last payment instead. [src: KB > Wrong-number traps, Never confirmed by Accent]",
      "[CONFLICT] The knowledge base calls closed revenue \"Sold and deposit received\" but also says quote-stage Jobs holding a deposit are intentionally counted (3 of 23,158 on SWB). This metric follows the second: no Stage test, so quote, cancelled and lost Jobs with a payment are included. [src: KB > Wrong-number traps]",
      "Any linked payment counts, not only the first deposit, because Payments.IsDeposit is unreliable. Payments.Status is not checked; only status_payment_confirmed has been seen.",
      "[UNVERIFIED] Service Jobs with a payment are included. The knowledge base does not say whether to exclude them.",
      "rep grouping uses the Job's SalesRepID, shown as an Insyte user ID.",
      ...LINE_NOTES,
      ...COMMON,
    ],
  },
  {
    id: "service_jobs",
    title: "Service jobs",
    definition: "Number of Jobs with JobType type_job_service created in the period (JobDate), in any stage.",
    unit: "count of Jobs",
    dateField: "Jobs.JobDate",
    dateWhy: "JobDate is the job creation and quote anchor. CloseDate is the administrative end of the job.",
    groupings: ["none", "month", "rep"],
    repField: "Jobs.SalesRepID",
    dataset: "Jobs",
    filter: (from, toNext) => `JobType eq 'type_job_service' and JobDate ge ${from} and JobDate lt ${toNext}`,
    select: "ID,JobDate,SalesRepID",
    computation: "Counts the Jobs returned. Service work is the Job-level JobType, not JobLines.LineType, which undercounts it by about three orders of magnitude.",
    uses: { Jobs: ["ID", "JobDate", "SalesRepID", "JobType"] },
    contribute: (row) => [{ date: when(row.JobDate, "Jobs.JobDate"), rep: rep(row.SalesRepID), n: 1 }],
    source: [
      `${KB} > Service Jobs (JobType is the primary axis)`,
      `${KB} > Wrong-number traps (JobLine.LineType as the service axis)`,
      `${KB} > Enumerations > Jobs.JobType`,
    ],
    caveats: [
      "[UNVERIFIED] The knowledge base defines which Jobs are service work but not which date places one in a period. JobDate (creation) is used here.",
      "Cancelled and lost service Jobs are included. The knowledge base does not say to exclude them.",
      "Parent-job linkage is not on the API, so remakes are not matched to their original sale. [src: KB > Service Jobs]",
      ...COMMON,
    ],
  },
  {
    id: "jobs_by_stage",
    title: "Jobs by stage",
    definition: "Number of Jobs created in the period (JobDate), split by their current Stage code (for example stage_job_quote, stage_job_order).",
    unit: "count of Jobs",
    dateField: "Jobs.JobDate",
    dateWhy: "JobDate is the job creation and quote anchor.",
    breakdown: "Jobs.Stage",
    groupings: ["none"],
    repField: "Jobs.SalesRepID",
    dataset: "Jobs",
    filter: (from, toNext) => `JobDate ge ${from} and JobDate lt ${toNext}`,
    select: "ID,JobDate,Stage,SalesRepID",
    computation: "Counts the Jobs returned, grouped by the Stage code on each Job. Stage is the Job's stage now, not when it was created.",
    uses: { Jobs: ["ID", "JobDate", "Stage", "SalesRepID"] },
    contribute: (row) => [{ date: when(row.JobDate, "Jobs.JobDate"), rep: rep(row.SalesRepID), key: String(row.Stage ?? "(no stage)"), n: 1 }],
    source: [`${KB} > Entities > Jobs (Stage, JobDate)`, `${KB} > Enumerations > Jobs.Stage and the joint distribution`],
    caveats: [
      "Stage is the current stage. The knowledge base records no stage history on the API, so this cannot say what a Job's stage was at an earlier date.",
      "Stage and Status drift apart in Insyte (a Job at stage_job_invoiced may carry status_job_open), so do not read this as open versus closed. [src: KB > Contested semantics]",
      "All job types are included, service Jobs among them.",
      ...COMMON,
    ],
  },
  {
    id: "won_opportunities",
    title: "Won opportunities",
    definition: "Number of Opportunities with a won Status (status_lead_won) whose CloseDate falls in the period.",
    unit: "count of Opportunities",
    dateField: "Opportunities.CloseDate",
    dateWhy: "CloseDate is the date an opportunity was won or lost. The same anchor as sold_revenue.",
    groupings: ["none", "month", "rep"],
    repField: "Opportunities.RepresentativeID",
    dataset: "Opportunities",
    filter: (from, toNext) => `contains(Status,'won') and CloseDate ge ${from} and CloseDate lt ${toNext}`,
    select: "ID,CloseDate,RepresentativeID",
    computation: "Counts the Opportunities returned. The server-side contains(Status,'won') matched only status_lead_won on SWB, so no client-side filter is needed.",
    uses: { Opportunities: ["ID", "CloseDate", "RepresentativeID", "Status"] },
    contribute: (row) => [{ date: when(row.CloseDate, "Opportunities.CloseDate"), rep: rep(row.RepresentativeID), n: 1 }],
    source: [
      `${KB} > Enumerations > Opportunities.Status (status_lead_won is the canonical Won value)`,
      `${KB} > Query patterns > Server-side filter beats client-side regex`,
    ],
    caveats: [
      "The won-only check (contains 'won') was verified on the SWB tenant. Another tenant could hold other values containing 'won'. [src: KB > Availability drifts]",
      "rep grouping uses Opportunities.RepresentativeID, shown as an Insyte user ID. It can differ from the Job's SalesRepID used by the revenue metrics.",
      ...COMMON,
    ],
  },
];

export function findMetric(id: string): MetricDef {
  const m = METRICS.find((x) => x.id === id);
  if (!m) throw new InsyteError(`Unknown metric "${id}". Call insyte_list_metrics for the available ones: ${METRICS.map((x) => x.id).join(", ")}.`);
  return m;
}
