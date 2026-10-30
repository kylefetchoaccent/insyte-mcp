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
}

export class InsyteError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const DESCRIPTION_TERM = "Org.OData.Core.V1.Description";

export class InsyteClient {
  readonly base: string;
  version = "";
  private sets = new Map<string, DataSet>();

  constructor(base: string, private readonly apiKey: string, private readonly requestedVersion: string) {
    // People paste the endpoint from the Api Integration page, which may include /v2 or /v3.
    this.base = base.replace(/\/+$/, "").replace(/\/v\d+$/i, "");
  }

  async init(): Promise<void> {
    this.version = this.requestedVersion === "auto" ? await this.detectVersion() : this.requestedVersion;
    const xml = await this.text(`/${this.version}/$metadata`);
    const related = await this.loadRelated();
    for (const set of parseMetadata(xml)) {
      set.related = related.get(set.name.toLowerCase()) ?? [];
      this.sets.set(set.name.toLowerCase(), set);
    }
    if (this.sets.size === 0) throw new InsyteError(`No data sets found in ${this.base}/${this.version}/$metadata`);
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
    if (opts.select) checkSelect(set, opts.select);
    let path = `/${this.version}/${set.name}`;
    if (relation) {
      const rel = set.related.find((r) => r.toLowerCase() === relation.name.toLowerCase());
      if (!rel) {
        throw new InsyteError(
          `"${relation.name}" is not a related list of ${set.name}.` +
            (set.related.length ? ` Available: ${set.related.join(", ")}.` : ` ${set.name} has no related lists.`),
        );
      }
      path += `(${keyLiteral(set, relation.id)})/${rel}`;
    }

    const params = new URLSearchParams();
    if (opts.select) params.set("$select", opts.select);
    if (opts.filter) params.set("$filter", opts.filter);
    if (opts.orderby) params.set("$orderby", opts.orderby);
    if (opts.expand) params.set("$expand", opts.expand);
    if (opts.skip) params.set("$skip", String(opts.skip));
    if (opts.count) params.set("$count", "true");
    // Ask for one extra row so we can tell the caller whether more exist.
    params.set("$top", String(opts.limit + 1));

    const rows: unknown[] = [];
    let totalCount: number | undefined;
    let url: string | undefined = `${this.base}${path}?${params}`;
    while (url && rows.length <= opts.limit) {
      let page: Record<string, unknown>;
      try {
        page = (await this.json(url)) as Record<string, unknown>;
      } catch (err) {
        // Single-valued relations (e.g. JobLines(1)/Job) reject paging options.
        if (!relation || rows.length || !(err instanceof InsyteError) || err.status !== 400) throw err;
        const single = new URLSearchParams(params);
        for (const p of ["$top", "$skip", "$count", "$filter", "$orderby"]) single.delete(p);
        page = (await this.json(`${this.base}${path}${single.size ? `?${single}` : ""}`)) as Record<string, unknown>;
      }
      if (totalCount === undefined && typeof page["@odata.count"] === "number") totalCount = page["@odata.count"];
      const value = page.value;
      if (Array.isArray(value)) rows.push(...value);
      else if (value === undefined) rows.push(stripOData(page)); // single-valued relation
      url = typeof page["@odata.nextLink"] === "string" ? this.sameOrigin(page["@odata.nextLink"]) : undefined;
    }
    const hasMore = rows.length > opts.limit;
    return { rows: rows.slice(0, opts.limit).map(stripOData), hasMore, totalCount };
  }

  async get(setName: string, id: string | number, opts: { select?: string; expand?: string }): Promise<unknown> {
    const set = this.dataSet(setName);
    if (opts.select) checkSelect(set, opts.select);
    const params = new URLSearchParams();
    if (opts.select) params.set("$select", opts.select);
    if (opts.expand) params.set("$expand", opts.expand);
    const qs = params.size ? `?${params}` : "";
    return stripOData(await this.json(`${this.base}/${this.version}/${set.name}(${keyLiteral(set, id)})${qs}`));
  }

  private async detectVersion(): Promise<string> {
    try {
      await this.text("/v3/$metadata");
      return "v3";
    } catch {
      return "v2";
    }
  }

  // The OpenAPI document lists the /{set}({id})/{relation} routes. It is optional:
  // without it, related lists are simply unavailable.
  private async loadRelated(): Promise<Map<string, string[]>> {
    const related = new Map<string, string[]>();
    let paths: Record<string, unknown> = {};
    for (const doc of [`/openapi.${this.version}.json`, "/openapi.json"]) {
      try {
        paths = ((await this.json(`${this.base}${doc}`)) as { paths?: Record<string, unknown> }).paths ?? {};
        break;
      } catch {
        // try the next document
      }
    }
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

  private async text(path: string): Promise<string> {
    const res = await this.fetch(`${this.base}${path}`, "application/xml");
    return res.text();
  }

  private async json(url: string): Promise<unknown> {
    const res = await this.fetch(url, "application/json");
    return res.json();
  }

  private async fetch(url: string, accept: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `X-ApiKey ${this.apiKey}`, Accept: accept },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new InsyteError(`Could not reach ${new URL(url).host}: ${(err as Error).message}`);
    }
    if (res.ok) return res;
    throw new InsyteError(explain(res.status, await res.text()), res.status);
  }
}

function explain(status: number, body: string): string {
  let detail = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message ?? (typeof parsed?.value === "string" ? parsed.value : detail);
  } catch {
    // not JSON; keep the raw text
  }
  const hint =
    status === 401 || status === 403
      ? " Check INSYTE_API_KEY: the key must exist under Settings > Integration > Api Integration, belong to a licensed user, and have READ scope."
      : status === 400
        ? " The OData query is probably invalid; check field names with insyte_describe_dataset."
        : status === 404
          ? " The record or route does not exist."
          : "";
  return `Insyte API returned ${status}${detail ? `: ${detail}` : "."}${hint}`;
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
