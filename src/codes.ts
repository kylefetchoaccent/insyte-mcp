// Plain-English labels for the codes Insyte stores in Status, Stage and Type fields.
// Every entry comes from the Insyte memory base (insyte/01-odata-api-and-data-model.md
// unless a source says otherwise) and names where. A code with no entry has no label:
// callers pass it through raw. Never add a label that no source gives. Several enum sets
// differ between tenants, so a missing code says nothing about whether it is valid.

export interface CodeLabel {
  label: string;
  source: string;
}

const LINE_STAGES = "01 JobLine.Stage table (probe 2026-06-01/03, Kerry translator, Confluence IWDOC Jobline Stages)";
const DISPATCH = "01 JobLine.DispatchStage (Confluence IWDOC Dispatch Stages, Kerry Spero)";

// Keyed by "DataSet.Field", then by code.
export const CODES: Record<string, Record<string, CodeLabel>> = {
  // Jobs.Stage: the memory base gives no UI label list. Only stages it names in prose get one.
  "Jobs.Stage": {
    stage_job_quote: { label: "Quote", source: "01 Jobs.Stage; 05 glossary ('quote stage')" },
    stage_job_order: { label: "Order", source: "01 Jobs.Stage ('Sold cohort'), 05 glossary (Won opps need order/order_edit)" },
    stage_job_invoiced: { label: "Invoiced", source: "01 Jobs.Stage ('closed stages observed in use')" },
    stage_job_complete: { label: "Complete", source: "01 Jobs.Stage ('closed stages observed in use')" },
    stage_job_cancelled: { label: "Cancelled", source: "01 Jobs.Stage ('closed stages observed in use')" },
    stage_job_lost: { label: "Lost", source: "01 Jobs.Stage ('closed stages observed in use')" },
    // No label: quote_edit, order_edit, invoice, install, installed, remeasure. Named, never described.
  },
  // [CONFLICT] whether "closed" means Stage in complete/invoiced/cancelled/lost or Status = status_job_closed (01 Contested semantics).
  "Jobs.Status": {
    status_job_closed: { label: "Closed", source: "01 Jobs.Status (Kerry-confirmed as the closed value)" },
    status_job_cancelled: { label: "Cancelled", source: "05 glossary ('job statuses referenced include cancelled/lost/closed')" },
    status_job_lost: { label: "Lost", source: "05 glossary ('job statuses referenced include cancelled/lost/closed')" },
    // No label: status_job_open, status_job_quote. Observed only.
  },
  "Jobs.JobType": {
    type_job_sales: { label: "Sales", source: "01 Service Jobs ('J0023329-1 (sales) -> J0023329-4 (service)')" },
    type_job_service: { label: "Service", source: "01 Service Jobs; 05 glossary (service order / remake order)" },
  },
  "JobLines.Stage": {
    stage_job_line_unconfirmed: { label: "Unconfirmed", source: LINE_STAGES },
    stage_job_line_unconfirmed_sent: { label: "Unconfirmed (Sent variant)", source: `${LINE_STAGES}; not in Confluence, label from the probe table` },
    stage_job_line_confirmed: { label: "Confirmed", source: LINE_STAGES },
    stage_job_line_cm_not_booked: { label: "CM Not Booked", source: LINE_STAGES },
    stage_job_line_cm_booked: { label: "CM Booked", source: LINE_STAGES },
    stage_job_line_cm_inprogress: { label: "CM In Progress", source: LINE_STAGES },
    // [CONFLICT] Kerry says there is no CM Complete status; the probe found 95-104 live rows.
    stage_job_line_cm_completed: { label: "CM Completed (Unconfirmed variant)", source: `${LINE_STAGES}; [CONFLICT] with Kerry Row 20` },
    stage_job_line_cm_completed_reschedule: { label: "CM Completed Reschedule", source: LINE_STAGES },
    // Documented in Confluence, never seen in SWB data.
    stage_job_line_supply_pending: { label: "Supply Pending", source: "01 JobLine.Stage (Confluence; absent from SWB data)" },
    stage_job_line_supply: { label: "Supply", source: LINE_STAGES },
    stage_job_line_dispatch: { label: "Dispatch", source: LINE_STAGES },
    stage_job_line_invoicing: { label: "Invoicing", source: LINE_STAGES },
  },
  // Labels are the field's own description in 01 ("open/closed/cancelled/on-hold").
  "JobLines.Status": {
    status_job_line_open: { label: "Open", source: "01 JobLines field notes" },
    status_job_line_closed: { label: "Closed", source: "01 JobLines field notes" },
    status_job_line_cancelled: { label: "Cancelled", source: "01 JobLines field notes; 05 glossary" },
    status_job_line_on_hold: { label: "On hold", source: "01 JobLines field notes" },
    // No label: status_job_closed on a line (75 rows, [UNVERIFIED] anomaly).
  },
  "JobLines.DispatchStage": {
    dispatch_job_line_install_not_booked: { label: "Install Not Booked", source: DISPATCH },
    dispatch_job_line_install_booked: { label: "Install Booked", source: DISPATCH },
    // [CONFLICT] the 2026-06-01 tally shows no 'installed' and the 2026-07-24 slice shows no 'delivered'.
    dispatch_job_line_installed: { label: "Installed", source: DISPATCH },
    dispatch_job_line_delivered: { label: "Delivered", source: DISPATCH },
    // The glossary calls these stages "Awaiting Delivery/Pickup"; the sub-stage list says "Not Booked".
    dispatch_job_line_delivery_not_booked: { label: "Delivery Not Booked", source: `${DISPATCH}; 05 glossary says 'Awaiting Delivery'` },
    dispatch_job_line_pickup_not_booked: { label: "Pickup Not Booked", source: `${DISPATCH}; 05 glossary says 'Awaiting Pickup'` },
    dispatch_job_line_collected: { label: "Collected", source: DISPATCH },
    // No label: dispatch_job_line_pending_service. The code-to-"Service Pending" link is not stated in a source.
  },
  "JobLines.LineType": {
    type_job_line_remake: { label: "Remake", source: "01 JobLine.LineType (Confluence, 2026-06-16)" },
    type_job_line_alter: { label: "Alter", source: "01 JobLine.LineType (Confluence, 2026-06-16)" },
    type_job_line_service: { label: "Service", source: "01 JobLine.LineType (Confluence, 2026-06-16)" },
    // No label: type_job_line_new. Probe value only.
  },
  "Opportunities.Status": {
    status_lead_won: { label: "Won", source: "01 Opportunities.Status (canonical Won value)" },
    status_lead_lost: { label: "Lost", source: "01 Opportunities.Status" },
    status_lead_open: { label: "Open", source: "01 Opportunities.Status ('the remaining 402 are open + lost')" },
  },
  // Four stages have Confluence definitions (05 Pipeline Stage). The rest are named, never described.
  "Opportunities.PipelineStage": {
    // [CONFLICT] pipeline_stage_quote (code evidence) vs stage_lead_quotation (data evidence). Only the latter appears in data.
    stage_lead_quotation: { label: "Quotation", source: "05 Pipeline Stage (Confluence); 01 [CONFLICT] on the raw enum" },
    stage_lead_negotiation: { label: "Negotiation", source: "05 Pipeline Stage (Confluence)" },
    stage_lead_won: { label: "Won", source: "05 Pipeline Stage (Confluence)" },
    stage_lead_lost: { label: "Lost", source: "05 Pipeline Stage (Confluence)" },
  },
};

// Activities.Status and Invoices.Status are listed in the memory base without labels, so they have none.

export function labelFor(field: string, code: unknown): CodeLabel | undefined {
  if (typeof code !== "string") return undefined;
  const table = CODES[field];
  return table && Object.hasOwn(table, code) ? table[code] : undefined;
}

// Adds "<Field>Label" next to each coded field of a row that has a known label. Raw codes stay.
export function withLabels<T extends Record<string, unknown>>(dataset: string, row: T): T & Record<string, string> {
  const out: Record<string, unknown> = { ...row };
  for (const field of Object.keys(row)) {
    const hit = labelFor(`${dataset}.${field}`, row[field]);
    if (hit) out[`${field}Label`] = hit.label;
  }
  return out as T & Record<string, string>;
}
