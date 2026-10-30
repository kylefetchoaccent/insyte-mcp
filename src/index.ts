#!/usr/bin/env node
// Insyte MCP server: read-only access to an Insyte Web tenant for Claude, over stdio.
//
// Environment:
//   INSYTE_API_KEY      required. A READ-scope key from Settings > Integration > Api Integration.
//   INSYTE_API_BASE     optional. The API Endpoint shown on that page (default https://api.myinsyte.com.au).
//   INSYTE_API_VERSION  optional. v2, v3 or auto (default auto: v3 when the host offers it).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DataSet, InsyteClient, InsyteError } from "./insyte.js";

const MAX_LIMIT = 1000;
// Keep a single tool result comfortably inside Claude's context.
const MAX_RESULT_CHARS = 120_000;

const apiKey = process.env.INSYTE_API_KEY?.trim();
if (!apiKey) {
  console.error("INSYTE_API_KEY is not set. Create a READ key under Settings > Integration > Api Integration in Insyte.");
  process.exit(1);
}

const client = new InsyteClient(
  process.env.INSYTE_API_BASE?.trim() || "https://api.myinsyte.com.au",
  apiKey,
  (process.env.INSYTE_API_VERSION?.trim() || "auto").toLowerCase(),
);

const instructions = `Read-only access to an Insyte Web tenant (CRM and job management for blinds, shutters and awnings businesses) through its OData API.

Workflow: call insyte_list_datasets to find the right data set, insyte_describe_dataset to learn its field names, then insyte_query. Never guess field names.

OData tips:
- Filter syntax: contains(LastName,'smith'), startswith(Email,'kerry'), JobDate ge 2026-07-01T00:00:00Z, and/or/not.
- Dates are ISO 8601 without quotes.
- Text values such as Status and Stage may be capitalised differently from their descriptions: use tolower(Stage) eq 'quote', or look at a few rows first.
- Jobs and invoices carry no totals in API v2. Money is on the lines: expand JobLines or InvoiceLines with only the price fields you need and add them up.
- Always pass select with only the fields you need; rows are large.
- To count, use count=true with limit=1.
- expand pulls in related records (e.g. SalesRep), at most three levels deep.

The API key acts as one Insyte user, so results are limited to what that user may see. Records contain customer personal details; only surface what the user asked for.`;

const server = new McpServer({ name: "insyte", version: "0.1.0" }, { instructions });

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

const queryShape = {
  select: z.string().optional().describe("Comma-separated fields to return, e.g. 'ID,Reference,JobDate,Stage'. Strongly recommended."),
  filter: z.string().optional().describe("OData $filter expression, e.g. \"tolower(Stage) eq 'quote' and JobDate ge 2026-07-01T00:00:00Z\"."),
  orderby: z.string().optional().describe("OData $orderby, e.g. 'CreatedDate desc'."),
  expand: z.string().optional().describe("OData $expand of navigation properties, e.g. 'SalesRep($select=FirstName,LastName)'."),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(50).describe(`Maximum rows to return (1-${MAX_LIMIT}, default 50).`),
  skip: z.number().int().min(0).optional().describe("Rows to skip, for paging. Use the nextSkip value from a previous result."),
  count: z.boolean().optional().describe("Also return the total number of matching rows."),
};

server.registerTool(
  "insyte_list_datasets",
  {
    title: "List Insyte data sets",
    description: "List every data set (table) the Insyte API exposes, with a short description and what can be expanded or followed from it.",
    annotations: readOnly,
  },
  async () => {
    const lines = client.dataSets().map((s) => {
      const extras = [
        s.navigations.length ? `expand: ${s.navigations.map((n) => n.name).join(", ")}` : "",
        s.related.length ? `related: ${s.related.join(", ")}` : "",
      ].filter(Boolean);
      return `- ${s.name}${s.description ? ` — ${s.description}` : ""} (${s.fields.length} fields${extras.length ? `; ${extras.join("; ")}` : ""})`;
    });
    return text(`Insyte API ${client.version} at ${client.base}\n\n${lines.join("\n")}`);
  },
);

server.registerTool(
  "insyte_describe_dataset",
  {
    title: "Describe an Insyte data set",
    description: "Show the fields (name, type, description), key, navigation properties and related lists of one data set. Call before querying.",
    inputSchema: { dataset: z.string().describe("Data set name from insyte_list_datasets, e.g. 'Jobs'.") },
    annotations: readOnly,
  },
  async ({ dataset }) => run(() => text(describeSet(client.dataSet(dataset)))),
);

server.registerTool(
  "insyte_query",
  {
    title: "Query Insyte records",
    description: "Query a data set with OData options. Returns matching rows as JSON, plus whether more rows exist.",
    inputSchema: { dataset: z.string().describe("Data set name, e.g. 'Jobs'."), ...queryShape },
    annotations: readOnly,
  },
  async ({ dataset, ...opts }) =>
    run(async () => page(await client.query(dataset, opts), opts.skip ?? 0, opts.limit)),
);

server.registerTool(
  "insyte_get_record",
  {
    title: "Get one Insyte record",
    description: "Fetch a single record by its ID.",
    inputSchema: {
      dataset: z.string().describe("Data set name, e.g. 'Jobs'."),
      id: z.union([z.number(), z.string()]).describe("The record's ID (key) value."),
      select: queryShape.select,
      expand: queryShape.expand,
    },
    annotations: readOnly,
  },
  async ({ dataset, id, select, expand }) => run(async () => json(await client.get(dataset, id, { select, expand }))),
);

server.registerTool(
  "insyte_get_related",
  {
    title: "Get records related to an Insyte record",
    description:
      "Follow a related list from one record, e.g. the JobLines of Jobs(123) or the InvoiceLines of an invoice. insyte_describe_dataset lists the related lists.",
    inputSchema: {
      dataset: z.string().describe("Parent data set, e.g. 'Jobs'."),
      id: z.union([z.number(), z.string()]).describe("Parent record ID."),
      relation: z.string().describe("Related list name, e.g. 'JobLines'."),
      ...queryShape,
    },
    annotations: readOnly,
  },
  async ({ dataset, id, relation, ...opts }) =>
    run(async () => page(await client.query(dataset, opts, { id, name: relation }), opts.skip ?? 0, opts.limit)),
);

function describeSet(s: DataSet): string {
  const out = [`# ${s.name}`, s.description ?? "", `Key: ${s.key.join(", ")}`, "", "## Fields"];
  for (const f of s.fields) {
    out.push(`- ${f.name} (${f.type.replace(/^Edm\./, "")}${f.nullable ? "" : ", required"})${f.description ? ` — ${f.description}` : ""}`);
  }
  if (s.navigations.length) {
    out.push("", "## Expandable (use in expand)");
    for (const n of s.navigations) {
      out.push(`- ${n.name} → ${n.collection ? "many " : ""}${n.targetType}${n.description ? ` — ${n.description}` : ""}`);
    }
  }
  if (s.related.length) out.push("", "## Related lists (use insyte_get_related)", ...s.related.map((r) => `- ${r}`));
  return out.filter((l, i) => l !== "" || i > 1).join("\n");
}

function page(result: { rows: unknown[]; hasMore: boolean; totalCount?: number }, skip: number, limit: number) {
  let rows = result.rows;
  let truncated = false;
  // Drop rows from the end until the payload fits, and tell Claude how to get the rest.
  while (rows.length > 1 && JSON.stringify(rows).length > MAX_RESULT_CHARS) {
    rows = rows.slice(0, Math.floor(rows.length / 2));
    truncated = true;
  }
  const hasMore = result.hasMore || truncated;
  return json({
    returned: rows.length,
    ...(result.totalCount !== undefined ? { totalCount: result.totalCount } : {}),
    hasMore,
    ...(hasMore ? { nextSkip: skip + rows.length } : {}),
    ...(truncated ? { note: `Cut to ${rows.length} of ${limit} rows to fit; narrow select or lower limit.` } : {}),
    rows,
  });
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function json(value: unknown) {
  return text(JSON.stringify(value, null, 1));
}

async function run<T>(fn: () => T | Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof InsyteError ? err.message : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
}

try {
  await client.init();
} catch (err) {
  console.error(`Insyte MCP could not start: ${(err as Error).message}`);
  process.exit(1);
}
await server.connect(new StdioServerTransport());
console.error(`Insyte MCP ready: ${client.dataSets().length} data sets from ${client.base}/${client.version}`);
