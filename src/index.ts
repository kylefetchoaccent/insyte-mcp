#!/usr/bin/env node
// Insyte MCP server: read-only access to one or more Insyte Web tenants for Claude, over stdio.
//
// Systems come from two places (see systems.ts):
//   - the add command: `node index.mjs add <name>` stores a key in the OS credential store
//   - INSYTE_API_KEY, the Claude Desktop extension's setting, named by INSYTE_SYSTEM_NAME (default "main")
//
// Environment:
//   INSYTE_API_KEY      optional. A READ-scope key from Settings > Integration > Api Integration.
//   INSYTE_SYSTEM_NAME  optional. The name for that key's system (default main).
//   INSYTE_API_BASE     optional. The API Endpoint for that key, or auto (default: try each
//                       Insyte region and use the one that accepts the key).
//   INSYTE_API_VERSION  optional. v2, v3 or auto (default auto: v3 when the host offers it).
//   INSYTE_MCP_HOME     optional. Folder for the systems registry (default ~/.insyte-mcp).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { COMMANDS, runCli } from "./cli.js";
import { DataSet, InsyteClient, InsyteError, QueryResult } from "./insyte.js";
import { SystemConfig, loadSystems } from "./systems.js";

if (COMMANDS.has(process.argv[2] ?? "")) process.exit(await runCli(process.argv.slice(2)));

const MAX_LIMIT = 1000;
// Keep a single tool result comfortably inside Claude's context.
const MAX_RESULT_CHARS = 120_000;

interface Connection {
  config: SystemConfig;
  client: InsyteClient;
  ready?: Promise<void>;
  error?: string;
}

let loaded: Awaited<ReturnType<typeof loadSystems>>;
try {
  loaded = await loadSystems(process.env);
} catch (err) {
  console.error(`Insyte MCP could not start: ${(err as Error).message}`);
  process.exit(1);
}
if (!loaded.systems.length) {
  console.error(
    "No Insyte system is set up. Set INSYTE_API_KEY, or run this file with: add <name>. " +
      "Create a READ key under Settings > Integration > Api Integration in Insyte.",
  );
  process.exit(1);
}
for (const w of loaded.warnings) console.error(`Insyte MCP warning: ${w}`);

const version = (process.env.INSYTE_API_VERSION?.trim() || "auto").toLowerCase();
const connections = new Map<string, Connection>(
  loaded.systems.map((s) => [s.name, { config: s, client: new InsyteClient(s.base, s.apiKey, version) }]),
);
const names = [...connections.keys()];
const multi = names.length > 1;

const multiNote = multi
  ? `\n\nSeveral Insyte systems are set up: ${names.join(", ")}. Each is a separate business. Pass system on every call, and ask the user which one they mean when it is unclear. Never combine or compare data across systems unless the user asks.`
  : "";

const instructions = `Read-only access to Insyte Web (CRM and job management for blinds, shutters and awnings businesses) through its OData API.

Workflow: call insyte_list_datasets to find the right data set, insyte_describe_dataset to learn its field names, then insyte_query. Never guess field names.

OData tips:
- Filter syntax: contains(LastName,'smith'), startswith(Email,'kerry'), JobDate ge 2026-07-01T00:00:00Z, and/or/not.
- Dates are ISO 8601 without quotes.
- Status, Stage, Type and similar fields hold codes such as stage_job_quote, status_job_open or status_invoice_sent, not the plain words in their descriptions. Filtering on the plain word (Stage eq 'quote') matches nothing and gives a wrong count of zero. insyte_describe_dataset lists the codes seen in recent records; filter on the exact code, e.g. Stage eq 'stage_job_quote'.
- Jobs and invoices carry no totals in API v2. Money is on the lines: expand JobLines or InvoiceLines with only the price fields you need and add them up.
- Always pass select with only the fields you need; rows are large.
- To count, use count=true with limit=1.
- expand pulls in related records (e.g. SalesRep), at most three levels deep.

Each API key acts as one Insyte user, so results are limited to what that user may see. Records contain customer personal details; only surface what the user asked for.${multiNote}`;

const server = new McpServer({ name: "insyte", version: "0.2.0" }, { instructions });

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

const systemShape = {
  system: z
    .string()
    .optional()
    .describe(multi ? `Which Insyte system to read: ${names.join(", ")}. Required, since several are set up.` : `Insyte system name (only "${names[0]}" is set up, so this can be left out).`),
};

const queryShape = {
  select: z.string().optional().describe("Comma-separated fields to return, e.g. 'ID,Reference,JobDate,Stage'. Strongly recommended."),
  filter: z.string().optional().describe("OData $filter expression, e.g. \"Stage eq 'stage_job_quote' and JobDate ge 2026-07-01T00:00:00Z\". Code fields take the codes insyte_describe_dataset lists."),
  orderby: z.string().optional().describe("OData $orderby, e.g. 'CreatedDate desc'."),
  expand: z.string().optional().describe("OData $expand of navigation properties, e.g. 'SalesRep($select=FirstName,LastName)'."),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(50).describe(`Maximum rows to return (1-${MAX_LIMIT}, default 50).`),
  skip: z.number().int().min(0).optional().describe("Rows to skip, for paging. Use the nextSkip value from a previous result."),
  count: z.boolean().optional().describe("Also return the total number of matching rows."),
};

server.registerTool(
  "insyte_list_systems",
  {
    title: "List Insyte systems",
    description: "List the Insyte systems (tenants) set up for this user, and whether each has connected yet. Makes no calls to Insyte.",
    annotations: readOnly,
  },
  async () => {
    const lines = [...connections.values()].map(({ config, client, ready, error }) => {
      const state = error
        ? `failed to connect: ${error}`
        : !ready
          ? "not used yet in this session"
          : client.dataSets().length
            ? `connected: ${new URL(client.base).host}, API ${client.version}, ${client.dataSets().length} data sets${client.authWarning ? `; WARNING: ${client.authWarning}` : ""}`
            : "connecting";
      return `- ${config.name} (${config.source === "environment" ? "extension setting" : "added with the add command"}): ${state}`;
    });
    const warnings = loaded.warnings.length ? `\n\nSetup warnings:\n${loaded.warnings.map((w) => `- ${w}`).join("\n")}` : "";
    return text(`${lines.join("\n")}${warnings}`);
  },
);

server.registerTool(
  "insyte_list_datasets",
  {
    title: "List Insyte data sets",
    description: "List every data set (table) the Insyte API exposes, with a short description and what can be expanded or followed from it.",
    inputSchema: systemShape,
    annotations: readOnly,
  },
  async ({ system }) =>
    run(async () => {
      const { name, client } = await connect(system);
      const lines = client.dataSets().map((s) => {
        const extras = [
          s.navigations.length ? `expand: ${s.navigations.map((n) => n.name).join(", ")}` : "",
          s.related.length ? `related: ${s.related.join(", ")}` : "",
        ].filter(Boolean);
        return `- ${s.name}${s.description ? ` — ${s.description}` : ""} (${s.fields.length} fields${extras.length ? `; ${extras.join("; ")}` : ""})`;
      });
      const warning = client.authWarning ? `\n\nWARNING: ${client.authWarning} Data queries will fail until this is fixed.` : "";
      const label = multi ? `System ${name}: ` : "";
      return text(`${label}Insyte API ${client.version} at ${client.base}${warning}\n\n${lines.join("\n")}`);
    }),
);

server.registerTool(
  "insyte_describe_dataset",
  {
    title: "Describe an Insyte data set",
    description:
      "Show the fields (name, type, description), key, navigation properties and related lists of one data set, plus the codes that Status, Stage and similar fields actually hold. Call before querying.",
    inputSchema: { dataset: z.string().describe("Data set name from insyte_list_datasets, e.g. 'Jobs'."), ...systemShape },
    annotations: readOnly,
  },
  async ({ dataset, system }) =>
    run(async () => {
      const { client } = await connect(system);
      const set = client.dataSet(dataset);
      // Codes come from live records; without them (e.g. a rejected key) the description still stands.
      const codes = await client.codeValues(set.name).catch(() => undefined);
      return text(describeSet(set, codes));
    }),
);

server.registerTool(
  "insyte_query",
  {
    title: "Query Insyte records",
    description: "Query a data set with OData options. Returns matching rows as JSON, plus whether more rows exist.",
    inputSchema: { dataset: z.string().describe("Data set name, e.g. 'Jobs'."), ...queryShape, ...systemShape },
    annotations: readOnly,
  },
  async ({ dataset, system, ...opts }) =>
    run(async () => {
      const { name, client } = await connect(system);
      return page(name, await client.query(dataset, opts), opts.skip ?? 0, opts.limit);
    }),
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
      ...systemShape,
    },
    annotations: readOnly,
  },
  async ({ dataset, id, select, expand, system }) =>
    run(async () => {
      const { name, client } = await connect(system);
      const { record, skipped } = await client.get(dataset, id, { select, expand });
      if (!multi && !skipped) return json(record);
      return json({ ...(multi ? { system: name } : {}), ...(skipped ? { note: skippedNote(skipped) } : {}), record });
    }),
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
      ...systemShape,
    },
    annotations: readOnly,
  },
  async ({ dataset, id, relation, system, ...opts }) =>
    run(async () => {
      const { name, client } = await connect(system);
      return page(name, await client.query(dataset, opts, { id, name: relation }), opts.skip ?? 0, opts.limit);
    }),
);

// Systems connect on first use, so a long list never hits Insyte all at once.
async function connect(system?: string): Promise<{ name: string; client: InsyteClient }> {
  let conn: Connection | undefined;
  if (system?.trim()) {
    conn = connections.get(system.trim().toLowerCase());
    if (!conn) throw new InsyteError(`No Insyte system named "${system}". Set up: ${names.join(", ")}.`);
  } else if (multi) {
    throw new InsyteError(`Several Insyte systems are set up (${names.join(", ")}). Pass system to say which one.`);
  } else {
    conn = connections.get(names[0])!;
  }
  await warm(conn);
  return { name: conn.config.name, client: conn.client };
}

async function warm(conn: Connection): Promise<void> {
  conn.ready ??= conn.client.init();
  try {
    await conn.ready;
    conn.error = undefined;
  } catch (err) {
    conn.ready = undefined; // let the next call try again
    conn.error = (err as Error).message;
    throw err;
  }
}

function describeSet(s: DataSet, codes?: Map<string, string[]>): string {
  const out = [`# ${s.name}`, s.description ?? "", `Key: ${s.key.join(", ")}`, "", "## Fields"];
  for (const f of s.fields) {
    const seen = codes?.get(f.name);
    out.push(
      `- ${f.name} (${f.type.replace(/^Edm\./, "")}${f.nullable ? "" : ", required"})${f.description ? ` — ${f.description}` : ""}` +
        (seen ? ` Codes seen in recent records (filter on these, not the words above): ${seen.join(", ")}.` : ""),
    );
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

function skippedNote(skipped: string[]) {
  return `Left out ${skipped.join(", ")}: Insyte cannot read these fields on this system.`;
}

function page(system: string, result: QueryResult, skip: number, limit: number) {
  let rows = result.rows;
  let truncated = false;
  // Drop rows from the end until the payload fits, and tell Claude how to get the rest.
  while (rows.length > 1 && JSON.stringify(rows).length > MAX_RESULT_CHARS) {
    rows = rows.slice(0, Math.floor(rows.length / 2));
    truncated = true;
  }
  const hasMore = result.hasMore || truncated;
  return json({
    ...(multi ? { system } : {}),
    returned: rows.length,
    ...(result.totalCount !== undefined ? { totalCount: result.totalCount } : {}),
    hasMore,
    ...(hasMore ? { nextSkip: skip + rows.length } : {}),
    ...(truncated ? { note: `Cut to ${rows.length} of ${limit} rows to fit; narrow select or lower limit.` } : {}),
    ...(result.skipped ? { skipped: skippedNote(result.skipped) } : {}),
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

await server.connect(new StdioServerTransport());
console.error(`Insyte MCP ready: ${names.length} system${multi ? "s" : ""} (${names.join(", ")})`);
// Warm up the first system so the first question is quick; failures surface on use.
warm(connections.get(names[0])!).catch(() => undefined);
