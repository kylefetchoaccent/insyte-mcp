// Thin client for the Insyte Web API (OData). Reads the service $metadata once and
// uses it to validate requests, so the MCP tools work for every data set the
// tenant's API version exposes without hand-written definitions.

import { XMLParser } from "fast-xml-parser";

export interface Field {
  name: string;
  type: string;
  nullable: boolean;
  description?: string;
}

export interface Navigation {
  name: string;
  targetType: string;
  collection: boolean;
  description?: string;
}

export interface DataSet {
  name: string;
  typeName: string;
  description?: string;
  key: string[];
  fields: Field[];
  navigations: Navigation[];
  // Sub-resources reachable as /{set}({id})/{relation}, from the OpenAPI document.
  related: string[];
}

export interface QueryOptions {
  select?: string;
  filter?: string;
  orderby?: string;
  expand?: string;
  limit: number;
  skip?: number;
  count?: boolean;
}

export interface QueryResult {
  rows: unknown[];
  hasMore: boolean;
  totalCount?: number;
  // Fields left out because Insyte cannot read them on this tenant.
  skipped?: string[];
}

export class InsyteError extends Error {
  // incomplete: the API answered 200 but the body was cut off mid-JSON.
  constructor(message: string, readonly status?: number, readonly incomplete = false) {
    super(message);
  }
}

const DESCRIPTION_TERM = "Org.OData.Core.V1.Description";

// Insyte runs one API host per region. $metadata is public on both, so only an
// authenticated request shows which one holds the key's tenant.
export const KNOWN_HOSTS = ["https://api.myinsyte.com.au", "https://api.myinsyte.com"];

// Status, Stage, Type and similar fields hold codes such as stage_job_quote.
const CODE_VALUE = /^[a-z]+(_[a-z0-9]+)+$/;
const CODE_SAMPLE_ROWS = 300;
const MAX_CODES = 25;

// Opt-in, in-process cache for the public schema documents ($metadata, OpenAPI), shared by
// every client that is given it. They carry no key and no tenant data, so sharing is safe.
// Concurrent first users of one entry share a single download. Failures are never cached.
export class SchemaCache {
  private readonly entries = new Map<string, { at: number; value: unknown }>();
  private readonly loading = new Map<string, Promise<unknown>>();
  constructor(private readonly ttlMs = 3_600_000, private readonly maxEntries = 64) {}

  // load returns undefined to say "nothing worth keeping"; that result is not stored.
  async load<T>(key: string, load: () => Promise<T | undefined>): Promise<T | undefined> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value as T;
    const pending = this.loading.get(key);
    if (pending) return pending as Promise<T | undefined>;
    const p = load()
      .then((value) => {
        if (value !== undefined) {
          this.entries.delete(key);
          this.entries.set(key, { at: Date.now(), value });
          // Hosts come from callers' system lists, so keep the table bounded.
          while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
        }
        return value;
      })
      .finally(() => this.loading.delete(key));
    this.loading.set(key, p);
    return p;
  }
}

export interface ClientOptions {
  // Shared schema documents; unset (the stdio default) means every client downloads its own.
  schemaCache?: SchemaCache;
  // Wraps each Insyte request, e.g. to cap concurrency per principal and host. It holds its
  // slot until the response body is read.
  gate?: (url: string, run: () => Promise<Response>) => Promise<Response>;
  // Per Insyte request, in milliseconds (default 60000).
  timeoutMs?: number;
  // Aborts every request of this client, e.g. when the caller has gone or timed out.
  signal?: AbortSignal;
}

export class InsyteClient {
  base = "";
  version = "";
  // Set when no candidate host accepted the key; the server still starts so the
  // metadata tools work, and data calls return the 401 with this explanation.
  authWarning?: string;
  private sets = new Map<string, DataSet>();
  private codes = new Map<string, Map<string, string[]>>();
  private unreadable = new Map<string, Set<string>>();
  private readonly candidates: string[];
  private readonly baseError?: string;

  constructor(base: string, private readonly apiKey: string, private readonly requestedVersion: string, private opts: ClientOptions = {}) {
    // People paste the endpoint from the Api Integration page, which may include /v2 or /v3.
    let explicit = base.trim().toLowerCase() === "auto" ? "" : base.trim();
    if (explicit && !/^[a-z]+:\/\//i.test(explicit)) explicit = `https://${explicit}`;
    this.candidates = explicit ? [explicit.replace(/\/+$/, "").replace(/\/v\d+$/i, "")] : KNOWN_HOSTS;
    // The key must never travel unencrypted; plain http is only for a local test server.
    if (explicit && !/^https:\/\//i.test(explicit) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(explicit)) {
      this.baseError = `The endpoint "${explicit}" is not https. Use the https:// API Endpoint shown on the Api Integration page, or auto.`;
    }
  }

  // Connections builds clients without options; the hosted server adds them per request.
  configure(opts: ClientOptions): void {
    this.opts = { ...this.opts, ...opts };
  }

  async init(): Promise<void> {
    if (this.baseError) throw new InsyteError(this.baseError);
    const rejected: string[] = [];
    const failed: string[] = [];
    for (const host of this.candidates) {
      this.base = host;
      try {
        await this.loadMetadata();
        const probe = await this.probeKey();
        if (probe === "accepted") {
          await this.attachRelated();
          return;
        }
        if (probe === "rejected") rejected.push(host);
        else failed.push(`${new URL(host).host}: ${probe}`);
      } catch (err) {
        failed.push(`${new URL(host).host}: ${err instanceof InsyteError && err.status ? `returned ${err.status}` : (err as Error).message}`);
      }
    }
    // A host we could not check might be the right region. Fail now so the next call
    // tries again, rather than pinning a host that rejects the key all session.
    if (failed.length) throw new InsyteError(`Could not check the API key with Insyte. ${failed.join(" | ")}`);
    // Every host rejected the key. Keep the first so the metadata tools still work.
    if (this.base !== rejected[0]) {
      this.base = rejected[0];
      await this.loadMetadata();
    }
    await this.attachRelated();
    this.authWarning =
      `${rejected.map((h) => new URL(h).host).join(" and ")} rejected the API key. The key may be wrong, deleted, or belong to a user without an API licence` +
      (this.candidates.length === 1 ? `, or the endpoint setting may point at the wrong region (${otherHosts(this.base)}).` : ".");
  }

  private async loadMetadata(): Promise<void> {
    this.sets.clear();
    this.codes.clear();
    this.unreadable.clear();
    const cache = this.opts.schemaCache;
    const host = this.base.toLowerCase();
    // The version probe is cached per host; the schema per host and version.
    this.version =
      this.requestedVersion !== "auto" ? this.requestedVersion : cache ? (await cache.load(`version|${host}`, () => this.detectVersion()))! : await this.detectVersion();
    const fetchSets = async (): Promise<DataSet[]> => {
      const parsed = parseMetadata(await this.text(`/${this.version}/$metadata`));
      if (parsed.length === 0) throw new InsyteError(`No data sets found in ${this.base}/${this.version}/$metadata`);
      return parsed;
    };
    // Clone, because attachRelated writes into the sets.
    const sets = cache ? structuredClone((await cache.load(`metadata|${host}|${this.version}`, fetchSets))!) : await fetchSets();
    for (const set of sets) this.sets.set(set.name.toLowerCase(), set);
  }

  // Loaded only for the host that accepted the key: the OpenAPI document is close to 1 MB.
  private async attachRelated(): Promise<void> {
    const related = await this.loadRelated();
    for (const set of this.sets.values()) set.related = related.get(set.name.toLowerCase()) ?? [];
  }

  // The only request in init that carries the key. Only a 2xx counts as accepted.
  private async probeKey(): Promise<"accepted" | "rejected" | string> {
    const set = this.dataSets().find((s) => s.key.length === 1) ?? this.dataSets()[0];
    try {
      // Any 2xx accepts the key; the body doesn't matter here.
      await this.fetch(`${this.base}/${this.version}/${set.name}?$top=1&$select=${set.key.join(",")}`, "application/json", true);
      return "accepted";
    } catch (err) {
      if (err instanceof InsyteError && (err.status === 401 || err.status === 403)) return "rejected";
      // The data-query hints in the message don't apply to a connection check.
      return err instanceof InsyteError && err.status ? `returned ${err.status}` : (err as Error).message;
    }
  }

  // Code-valued string fields of a data set and the codes seen in its most recent records.
  async codeValues(setName: string): Promise<Map<string, string[]>> {
    const set = this.dataSet(setName);
    const cached = this.codes.get(set.name);
    if (cached) return cached;
    const strings = set.fields.filter((f) => f.type === "Edm.String").map((f) => f.name);
    const found = new Map<string, string[]>();
    if (strings.length) {
      const { rows } = await this.query(set.name, {
        select: strings.join(","),
        orderby: `${set.key[0]} desc`,
        limit: CODE_SAMPLE_ROWS,
      });
      const seen = new Map<string, Set<string>>();
      const plain = new Set<string>();
      for (const row of rows as Record<string, unknown>[]) {
        for (const name of strings) {
          const v = row[name];
          if (typeof v !== "string" || v === "") continue;
          if (!CODE_VALUE.test(v)) plain.add(name);
          else (seen.get(name) ?? seen.set(name, new Set()).get(name)!).add(v);
        }
      }
      for (const [name, values] of seen) {
        if (!plain.has(name) && values.size <= MAX_CODES) found.set(name, [...values].sort());
      }
    }
    this.codes.set(set.name, found);
    return found;
  }

  dataSets(): DataSet[] {
    return [...this.sets.values()];
  }

  dataSet(name: string): DataSet {
    const wanted = name.trim().toLowerCase();
    const set = this.sets.get(wanted) ?? this.sets.get(`${wanted}s`) ?? this.sets.get(wanted.replace(/y$/, "ies"));
    if (set) return set;
    const close = this.dataSets()
      .filter((s) => s.name.toLowerCase().includes(name.toLowerCase().replace(/s$/, "")))
      .map((s) => s.name);
    throw new InsyteError(
      `Unknown data set "${name}".` +
        (close.length ? ` Did you mean: ${close.join(", ")}?` : " Call insyte_list_datasets to see what is available."),
    );
  }

  async query(setName: string, opts: QueryOptions, relation?: { id: string | number; name: string }): Promise<QueryResult> {
    const set = this.dataSet(setName);
    if (!relation) {
      if (opts.select) checkSelect(set, opts.select);
      return this.readable(set, opts.select, (select) => this.list(`/${this.version}/${set.name}`, { ...opts, select }));
    }

    const rel = set.related.find((r) => r.toLowerCase() === relation.name.toLowerCase());
    if (!rel) {
      throw new InsyteError(
        `"${relation.name}" is not a related list of ${set.name}.` +
          (set.related.length ? ` Available: ${set.related.join(", ")}.` : ` ${set.name} has no related lists.`),
      );
    }
    const path = `/${this.version}/${set.name}(${keyLiteral(set, relation.id)})/${rel}`;
    const nav = set.navigations.find((n) => n.name === rel);
    // select applies to the related records, not the parent.
    const target = nav && this.dataSets().find((s) => s.typeName.split(".").pop() === nav.targetType);
    if (opts.select && target) checkSelect(target, opts.select);

    return this.readable(target, opts.select, async (select) => {
      const o = { ...opts, select };
      try {
        // A single-valued relation (e.g. JobLines(1)/Job) rejects paging options.
        if (nav && !nav.collection) {
          const page = (await this.json(this.url(path, { $select: o.select, $expand: o.expand }))) as Record<string, unknown>;
          return { rows: [stripOData(page)], hasMore: false };
        }
        return await this.list(path, o);
      } catch (err) {
        // Some relation routes return a truncated body, and a missing single record comes
        // back as 404. The same data is reachable by expanding the parent.
        if (nav && err instanceof InsyteError && (err.incomplete || err.status === 404)) {
          return this.viaExpand(set, relation.id, nav, o);
        }
        // Without a navigation property the shape is unknown; a 400 means it is single-valued.
        if (!nav && err instanceof InsyteError && err.status === 400) {
          const page = (await this.json(this.url(path, { $select: o.select, $expand: o.expand }))) as Record<string, unknown>;
          return Array.isArray(page.value) ? { rows: page.value.map(stripOData), hasMore: false } : { rows: [stripOData(page)], hasMore: false };
        }
        throw err;
      }
    });
  }

  async get(setName: string, id: string | number, opts: { select?: string; expand?: string }): Promise<{ record: unknown; skipped?: string[] }> {
    const set = this.dataSet(setName);
    if (opts.select) checkSelect(set, opts.select);
    const path = `/${this.version}/${set.name}(${keyLiteral(set, id)})`;
    const { rows, skipped } = await this.readable(set, opts.select, async (select) => ({
      rows: [stripOData(await this.json(this.url(path, { $select: select, $expand: opts.expand })))],
      hasMore: false,
    }));
    return { record: rows[0], skipped };
  }

  private async list(path: string, opts: QueryOptions): Promise<QueryResult> {
    const rows: unknown[] = [];
    let totalCount: number | undefined;
    let url: string | undefined = this.url(path, {
      $select: opts.select,
      $filter: opts.filter,
      $orderby: opts.orderby,
      $expand: opts.expand,
      $skip: opts.skip ? String(opts.skip) : undefined,
      $count: opts.count ? "true" : undefined,
      // Ask for one extra row so we can tell the caller whether more exist.
      $top: String(opts.limit + 1),
    });
    while (url && rows.length <= opts.limit) {
      const page = (await this.json(url)) as Record<string, unknown>;
      if (totalCount === undefined && typeof page["@odata.count"] === "number") totalCount = page["@odata.count"];
      if (Array.isArray(page.value)) rows.push(...page.value);
      url = typeof page["@odata.nextLink"] === "string" ? this.sameOrigin(page["@odata.nextLink"]) : undefined;
    }
    return { rows: rows.slice(0, opts.limit).map(stripOData), hasMore: rows.length > opts.limit, totalCount };
  }

  private url(path: string, params: Record<string, string | undefined>): string {
    const qs = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1]));
    return `${this.base}${path}${qs.size ? `?${qs}` : ""}`;
  }

  // Some tenants' databases lack columns the API still maps (seen: SupplyJobLines.ProductBaseUnit),
  // and any request that reads them fails with a 500. When the caller named no fields, find
  // those columns once, leave them out from then on, and report them as skipped.
  private async readable(target: DataSet | undefined, select: string | undefined, run: (select?: string) => Promise<QueryResult>): Promise<QueryResult> {
    if (!target || select) return run(select);
    for (let attempt = 0; ; attempt++) {
      const skipped = [...(this.unreadable.get(target.name) ?? [])];
      const fields = skipped.length ? target.fields.map((f) => f.name).filter((n) => !skipped.includes(n)).join(",") : undefined;
      try {
        const result = await run(fields);
        return skipped.length ? { ...result, skipped } : result;
      } catch (err) {
        // Unreadable columns show up as a 500, or as a 200 cut off mid-stream.
        if (attempt > 0 || !(err instanceof InsyteError) || !(err.status === 500 || err.incomplete)) throw err;
        let bad = unreadableColumns(err, target);
        if (!bad.length) bad = await this.findUnreadable(target);
        if (!bad.length) throw err;
        this.unreadable.set(target.name, new Set([...skipped, ...bad]));
      }
    }
  }

  // List queries only say "Exception has been thrown"; fetching one whole record names the columns.
  private async findUnreadable(set: DataSet): Promise<string[]> {
    if (set.key.length !== 1) return [];
    try {
      const page = (await this.json(this.url(`/${this.version}/${set.name}`, { $top: "1", $select: set.key[0] }))) as { value?: Record<string, unknown>[] };
      const id = page.value?.[0]?.[set.key[0]];
      if (id === undefined) return [];
      await this.json(this.url(`/${this.version}/${set.name}(${keyLiteral(set, id as string | number)})`, {}));
    } catch (err) {
      return unreadableColumns(err, set);
    }
    return [];
  }

  private async viaExpand(set: DataSet, id: string | number, nav: Navigation, opts: QueryOptions): Promise<QueryResult> {
    const nested: string[] = [];
    if (opts.select) nested.push(`$select=${opts.select}`);
    if (opts.expand) nested.push(`$expand=${opts.expand}`);
    if (nav.collection) {
      if (opts.filter) nested.push(`$filter=${opts.filter}`);
      if (opts.orderby) nested.push(`$orderby=${opts.orderby}`);
      if (opts.skip) nested.push(`$skip=${opts.skip}`);
      if (opts.count) nested.push("$count=true");
      nested.push(`$top=${opts.limit + 1}`);
    }
    const params = new URLSearchParams({
      $select: set.key.join(","),
      $expand: nested.length ? `${nav.name}(${nested.join(";")})` : nav.name,
    });
    const parent = (await this.json(`${this.base}/${this.version}/${set.name}(${keyLiteral(set, id)})?${params}`)) as Record<string, unknown>;
    const value = parent[nav.name];
    const rows = Array.isArray(value) ? value : value == null ? [] : [value];
    const count = parent[`${nav.name}@odata.count`];
    return {
      rows: rows.slice(0, opts.limit).map(stripOData),
      hasMore: rows.length > opts.limit,
      totalCount: typeof count === "number" ? count : undefined,
    };
  }

  private async detectVersion(): Promise<string> {
    try {
      await this.text("/v3/$metadata");
      return "v3";
    } catch (err) {
      // Only "no v3 here" means v2; anything else (network, 5xx) must not silently pick a version.
      if (err instanceof InsyteError && err.status === 404) return "v2";
      throw err;
    }
  }

  // The OpenAPI document lists the /{set}({id})/{relation} routes. It is optional:
  // without it, related lists are simply unavailable.
  private async loadRelated(): Promise<Map<string, string[]>> {
    const cache = this.opts.schemaCache;
    if (!cache) return (await this.fetchRelated()) ?? new Map();
    // A missing document is not cached, so the next client tries again.
    const shared = await cache.load(`openapi|${this.base.toLowerCase()}|${this.version}`, () => this.fetchRelated());
    return structuredClone(shared ?? new Map<string, string[]>());
  }

  private async fetchRelated(): Promise<Map<string, string[]> | undefined> {
    const related = new Map<string, string[]>();
    let paths: Record<string, unknown> | undefined;
    for (const doc of [`/openapi.${this.version}.json`, "/openapi.json"]) {
      try {
        paths = ((await this.json(`${this.base}${doc}`, false)) as { paths?: Record<string, unknown> }).paths ?? {};
        break;
      } catch {
        // try the next document
      }
    }
    if (!paths) return undefined;
    const route = new RegExp(`^/${this.version}/([A-Za-z]+)\\(\\{[^}]+\\}\\)/([A-Za-z]+)$`);
    for (const [path, ops] of Object.entries(paths)) {
      const m = route.exec(path);
      if (!m || !(ops as Record<string, unknown>).get) continue;
      const list = related.get(m[1].toLowerCase()) ?? [];
      list.push(m[2]);
      related.set(m[1].toLowerCase(), list);
    }
    return related;
  }

  private sameOrigin(link: string): string {
    const next = new URL(link, this.base);
    // Never send the API key anywhere but the configured host.
    if (next.origin !== new URL(this.base).origin) throw new InsyteError(`Refusing to follow next page link to ${next.origin}`);
    return next.toString();
  }

  // Only $metadata goes through here, and Insyte serves it without a key, so none is sent.
  private async text(path: string): Promise<string> {
    const res = await this.fetch(`${this.base}${path}`, "application/xml", false);
    return res.text();
  }

  private async json(url: string, auth = true): Promise<unknown> {
    const res = await this.fetch(url, "application/json", auth);
    const body = await res.text();
    try {
      return JSON.parse(body);
    } catch {
      throw new InsyteError(
        `Insyte API returned an incomplete response for ${new URL(url).pathname} (${body.length} bytes, cut off mid-JSON). This is a fault in the Insyte API; try the same data through insyte_query with a filter.`,
        res.status,
        true,
      );
    }
  }

  private async fetch(url: string, accept: string, auth: boolean): Promise<Response> {
    let res: Response;
    const send = async (): Promise<Response> => {
      const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 60_000);
      let signal = timeout;
      const outer = this.opts.signal;
      if (outer) {
        // Manual join instead of AbortSignal.any, which needs Node 20.3.
        const both = new AbortController();
        for (const s of [timeout, outer]) s.aborted ? both.abort() : s.addEventListener("abort", () => both.abort(), { once: true });
        signal = both.signal;
      }
      return fetch(url, {
        headers: auth ? { Authorization: `X-ApiKey ${this.apiKey}`, Accept: accept } : { Accept: accept },
        signal,
      });
    };
    try {
      const gate = this.opts.gate;
      // Under a gate, read the body before releasing the slot so the cap covers the whole transfer.
      res = gate
        ? await gate(url, async () => {
            const r = await send();
            const buf = await r.arrayBuffer();
            return new Response(buf.byteLength ? buf : null, { status: r.status, statusText: r.statusText, headers: r.headers });
          })
        : await send();
    } catch (err) {
      throw new InsyteError(`Could not reach ${new URL(url).host}: ${(err as Error).message}`);
    }
    if (res.ok) return res;
    const expanded = new URL(url).searchParams.has("$expand");
    throw new InsyteError(explain(res.status, await res.text(), new URL(url).origin, this.candidates.length === 1, expanded), res.status);
  }
}

function otherHosts(base: string): string {
  const others = KNOWN_HOSTS.filter((h) => h !== base);
  return others.length ? `the other Insyte endpoint is ${others.join(", ")}` : "check the API Endpoint on the Api Integration page";
}

function explain(status: number, body: string, origin: string, explicitBase: boolean, expanded = false): string {
  let detail = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message ?? (typeof parsed?.value === "string" ? parsed.value : detail);
  } catch {
    // not JSON; keep the raw text
  }
  const hint =
    status === 401 || status === 403
      ? ` ${new URL(origin).host} rejected the API key. The key must exist under Settings > Integration > Api Integration, belong to a licensed user, and have READ scope.` +
        (explicitBase ? ` The endpoint setting must also match the API Endpoint shown on that page (${otherHosts(origin)}).` : "")
      : status === 400
        ? " The OData query is probably invalid; check field names with insyte_describe_dataset."
        : status === 404
          ? " The record or route does not exist."
          : status === 500 && /Invalid column name/.test(detail)
            ? " Insyte cannot read those fields on this system; leave them out of select."
            : status >= 500
              ? " This is a server error inside Insyte. Passing select with only the fields you need sometimes avoids it."
              : "";
  // Expanding a data set with unreadable columns fails the whole request (seen: SupplyJobLines).
  const expandHint =
    status >= 500 && expanded ? " If expand pulls in a data set with fields Insyte cannot read, give that expand a nested $select, e.g. Lines($select=ID,Quantity)." : "";
  return `Insyte API returned ${status}${detail ? `: ${detail}` : "."}${hint}${expandHint}`;
}

function unreadableColumns(err: unknown, set: DataSet): string[] {
  if (!(err instanceof InsyteError) || err.status !== 500) return [];
  const named = [...err.message.matchAll(/Invalid column name '(\w+)'/g)].map((m) => m[1]);
  return set.fields.map((f) => f.name).filter((n) => named.includes(n));
}

function keyLiteral(set: DataSet, id: string | number): string {
  const keyField = set.fields.find((f) => f.name === set.key[0]);
  const value = String(id).trim();
  if (keyField?.type === "Edm.String") return `'${value.replace(/'/g, "''")}'`;
  if (keyField?.type === "Edm.Guid") {
    if (!/^[0-9a-f-]{36}$/i.test(value)) throw new InsyteError(`${set.name} IDs are GUIDs; "${value}" is not one.`);
    return value;
  }
  if (!/^-?\d+$/.test(value)) throw new InsyteError(`${set.name} IDs are numbers; "${value}" is not one.`);
  return value;
}

function checkSelect(set: DataSet, select: string): void {
  const known = new Set([...set.fields, ...set.navigations].map((f) => f.name.toLowerCase()));
  const unknown = select
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !known.has(s.split("/")[0].toLowerCase()));
  if (unknown.length) {
    throw new InsyteError(
      `${set.name} has no field ${unknown.map((u) => `"${u}"`).join(", ")}. Call insyte_describe_dataset for the field list.`,
    );
  }
}

function stripOData(row: unknown): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  return Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith("@odata.")));
}

// --- $metadata parsing -------------------------------------------------------

type Node = Record<string, any>;

const ARRAY_TAGS = new Set([
  "Schema",
  "EntityType",
  "Property",
  "NavigationProperty",
  "PropertyRef",
  "EntitySet",
  "Annotation",
  "NavigationPropertyBinding",
]);

export function parseMetadata(xml: string): DataSet[] {
  const doc = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    removeNSPrefix: true,
    // The hook also sees attributes, and EntitySet has an EntityType attribute.
    isArray: (tag, _path, _leaf, isAttribute) => !isAttribute && ARRAY_TAGS.has(tag),
  }).parse(xml);

  const schemas: Node[] = doc?.Edmx?.DataServices?.Schema ?? [];
  const types = new Map<string, Node>();
  for (const schema of schemas) {
    for (const t of schema.EntityType ?? []) types.set(`${schema.Namespace}.${t.Name}`, t);
  }

  const sets: DataSet[] = [];
  for (const schema of schemas) {
    for (const s of schema.EntityContainer?.EntitySet ?? []) {
      const t = types.get(s.EntityType);
      if (!t) continue;
      sets.push({
        name: s.Name,
        typeName: s.EntityType,
        description: describe(s) ?? describe(t),
        key: (t.Key?.PropertyRef ?? []).map((r: Node) => r.Name),
        fields: (t.Property ?? []).map((p: Node) => ({
          name: p.Name,
          type: p.Type,
          nullable: p.Nullable !== "false",
          description: describe(p),
        })),
        navigations: (t.NavigationProperty ?? []).map((n: Node) => {
          const collection = /^Collection\(/.test(n.Type);
          const target = String(n.Type).replace(/^Collection\((.*)\)$/, "$1");
          return { name: n.Name, targetType: target.split(".").pop()!, collection, description: describe(n) };
        }),
        related: [],
      });
    }
  }
  return sets;
}

function describe(node: Node): string | undefined {
  return (node.Annotation ?? []).find((a: Node) => a.Term === DESCRIPTION_TERM)?.String;
}
