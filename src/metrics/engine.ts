// Runs one metric: pages through every matching row, one request at a time, adds up what each
// row contributes, and refuses rather than return a total from a partial scan.

import { InsyteError } from "../insyte.js";
import { GroupBy, Item, MetricDef, Row } from "./definitions.js";

export const MAX_SCAN_ROWS = 20_000;
// Rows per request. Kept modest because the nested expands make each row heavy.
export const PAGE_ROWS = 250;

export interface PageRequest {
  filter: string;
  select: string;
  expand?: string;
  orderby: string;
  limit: number;
  skip: number;
  count: boolean;
}
export interface PageResult {
  rows: unknown[];
  hasMore: boolean;
  totalCount?: number;
}
export type FetchPage = (req: PageRequest) => Promise<PageResult>;

export interface Group {
  key: string;
  value: number;
  matched: number;
}
export interface MetricResult {
  metric: string;
  from: string;
  to: string;
  groupBy: GroupBy;
  value: number;
  groups?: Group[];
  matched: number;
  rowsScanned: number;
  unit: string;
  definition: string;
  dateField: string;
  query: string;
  caveats: string[];
}

export function parseRange(from: string, to: string): { from: string; to: string; toNext: string } {
  const day = (label: string, v: string) => {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : undefined;
    if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
      throw new InsyteError(`${label} must be a real calendar date written YYYY-MM-DD, for example 2026-06-01. Got "${v}".`);
    }
    return d;
  };
  const start = day("from", from);
  const end = day("to", to);
  if (end < start) throw new InsyteError(`to (${to}) is before from (${from}). Swap them or pick a new range.`);
  return { from, to, toNext: new Date(end.getTime() + 86_400_000).toISOString().slice(0, 10) };
}

function tooMany(def: MetricDef, n: number, exact: boolean, range: { from: string; to: string }): InsyteError {
  return new InsyteError(
    `Refused: ${def.title} for ${range.from} to ${range.to} would scan ${exact ? "" : "more than "}${n.toLocaleString("en-US")} ${def.dataset} rows, over the ${MAX_SCAN_ROWS.toLocaleString("en-US")}-row limit. ` +
      `Nothing was totalled, because a total from part of the rows would be wrong. Narrow from and to (for example one month at a time), run it once per range, and add the results yourself.`,
  );
}

export function queryText(def: MetricDef, range: { from: string; toNext: string }, orderby: string): string {
  const parts = [`$filter=${def.filter(range.from, range.toNext)}`, `$select=${def.select}`];
  if (def.expand) parts.push(`$expand=${def.expand}`);
  parts.push(`$orderby=${orderby}`, `$top=${PAGE_ROWS}`);
  return `GET ${def.dataset}?${parts.join("&")} (repeated with $skip, one request at a time, until the last page)`;
}

export async function runMetric(
  def: MetricDef,
  rangeIn: { from: string; to: string },
  groupBy: GroupBy,
  orderby: string,
  fetchPage: FetchPage,
): Promise<MetricResult> {
  if (!def.groupings.includes(groupBy)) {
    throw new InsyteError(
      `${def.title} cannot be grouped by ${groupBy}. ${def.breakdown ? `It is already split by ${def.breakdown}. ` : ""}Use groupBy ${def.groupings.join(" or ")}.`,
    );
  }
  const range = parseRange(rangeIn.from, rangeIn.to);
  const items: Item[] = [];
  let scanned = 0;
  let expected: number | undefined;
  for (let skip = 0; ; ) {
    const page = await fetchPage({
      filter: def.filter(range.from, range.toNext),
      select: def.select,
      expand: def.expand,
      orderby,
      limit: PAGE_ROWS,
      skip,
      count: skip === 0,
    });
    if (skip === 0) {
      expected = page.totalCount;
      if (expected !== undefined && expected > MAX_SCAN_ROWS) throw tooMany(def, expected, true, range);
    }
    scanned += page.rows.length;
    // Insyte did not report a count, or it was wrong: stop as soon as the scan passes the cap.
    if (scanned > MAX_SCAN_ROWS) throw tooMany(def, scanned, false, range);
    for (const row of page.rows) items.push(...def.contribute(row as Row, range));
    if (!page.hasMore) break;
    if (page.rows.length === 0) {
      throw new InsyteError(`Insyte said more ${def.dataset} rows exist but returned none after ${scanned}. Nothing was totalled. Try again, or narrow from and to.`);
    }
    skip += page.rows.length;
  }
  if (expected !== undefined && scanned !== expected) {
    throw new InsyteError(
      `Insyte counted ${expected} ${def.dataset} rows at the start but ${scanned} came back, so records changed during the scan. Nothing was totalled. Run it again.`,
    );
  }

  const isAmount = def.unit.startsWith("amount");
  const round = (v: number) => (isAmount ? Math.round(v * 100) / 100 : v);
  const sum = (xs: Item[]) => round(xs.reduce((s, i) => s + i.n, 0));
  const bucket = (i: Item) => (groupBy === "month" ? i.date.slice(0, 7) : groupBy === "rep" ? i.rep : (i.key as string));
  const grouped = groupBy !== "none" || def.breakdown;
  let groups: Group[] | undefined;
  if (grouped) {
    const by = new Map<string, Item[]>();
    for (const i of items) (by.get(bucket(i)) ?? by.set(bucket(i), []).get(bucket(i))!).push(i);
    groups = [...by].map(([key, xs]) => ({ key, value: sum(xs), matched: xs.length }));
    groups.sort(groupBy === "month" ? (a, b) => a.key.localeCompare(b.key) : (a, b) => b.value - a.value || a.key.localeCompare(b.key));
  }

  return {
    metric: def.id,
    from: range.from,
    to: range.to,
    groupBy,
    value: sum(items),
    ...(groups ? { groups } : {}),
    matched: items.length,
    rowsScanned: scanned,
    unit: def.unit,
    definition: def.definition,
    dateField: def.dateField,
    query: queryText(def, range, orderby),
    caveats: def.caveats,
  };
}
