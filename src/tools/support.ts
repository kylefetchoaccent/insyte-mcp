// Tools for Accent support staff: search a local docs folder, compare two systems'
// schemas, and health-check a system. Support profile only.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import { z } from "zod";
import { InsyteError } from "../insyte.js";
import { MAX_RESULT_CHARS, ToolContext, ToolModule, json, readOnly, run, systemShape, text } from "../server.js";
import { indexFor, search } from "../support/docs.js";
import { diffSchemas } from "../support/schema.js";

const DEFAULT_BUDGET_SECONDS = 60;
const MAX_DETAIL_LINES = 150;
const MAX_ERROR_CHARS = 300;
// server.ts imports this file, so its exports cannot be read at load time. Leave room under
// the shared cap for the header lines.
const detailCharBudget = () => MAX_RESULT_CHARS - 5_000;

const short = (s: string, max = MAX_ERROR_CHARS) => (s.length > max ? `${s.slice(0, max)}...` : s);

function register(server: McpServer, ctx: ToolContext): void {
  const { conns } = ctx;

  server.registerTool(
    "insyte_docs_search",
    {
      title: "Search the support docs",
      description:
        "Keyword search over the Markdown support documents in the folder named by INSYTE_DOCS_DIR. Returns the best-matching sections, each with file, heading and a short snippet. Makes no calls to Insyte.",
      inputSchema: {
        query: z.string().min(1).describe("Words to look for, e.g. 'import price list csv'."),
        limit: z.number().int().min(1).max(10).default(5).describe("Maximum sections to return (1-10, default 5)."),
      },
      annotations: { ...readOnly, openWorldHint: false },
    },
    async ({ query, limit }) =>
      run(() => {
        const dir = process.env.INSYTE_DOCS_DIR?.trim();
        if (!dir) return text("No docs folder is set up. Set INSYTE_DOCS_DIR to a folder of Markdown files and restart the server.");
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
          return text(`The docs folder set in INSYTE_DOCS_DIR was not found: ${dir}`);
        }
        const idx = indexFor(dir);
        if (!idx.sections.length) return text(`No Markdown files found in ${dir}.`);
        const hits = search(idx, query, limit);
        return json({
          query,
          searched: `${idx.files} files, ${idx.sections.length} sections`,
          returned: hits.length,
          hits: hits.map(({ file, heading, snippet }) => ({ file, heading, snippet })),
        });
      }),
  );

  server.registerTool(
    "insyte_compare_schemas",
    {
      title: "Compare two systems' schemas",
      description:
        "Compare the data sets, fields (name and type), keys and navigations that two connected Insyte systems expose. Counts first, then details. Reads only each system's $metadata, no customer data.",
      inputSchema: {
        systemA: z.string().describe(`First system: ${conns.names.join(", ")}.`),
        systemB: z.string().describe(`Second system: ${conns.names.join(", ")}.`),
      },
      annotations: readOnly,
    },
    async ({ systemA, systemB }) =>
      run(async () => {
        // One at a time, so two systems never connect at once.
        const a = await conns.connect(systemA);
        const b = await conns.connect(systemB);
        if (a.name === b.name) throw new InsyteError(`systemA and systemB are both "${a.name}". Name two different systems.`);
        const d = diffSchemas(a.client.dataSets(), b.client.dataSets(), a.name, b.name);
        const out = [
          `Schema comparison of ${a.name} (API ${a.client.version}, ${new URL(a.client.base).host}) and ${b.name} (API ${b.client.version}, ${new URL(b.client.base).host}).`,
          "",
          "Summary",
          `- Data sets: ${a.name} ${a.client.dataSets().length}, ${b.name} ${b.client.dataSets().length}`,
          `- Only in ${a.name}: ${d.onlyInA.length}`,
          `- Only in ${b.name}: ${d.onlyInB.length}`,
          `- In both: ${d.common} (${d.identical} identical, ${d.changed.length} differ)`,
        ];
        const detail: string[] = [];
        if (d.onlyInA.length) detail.push(`Only in ${a.name}: ${d.onlyInA.join(", ")}`);
        if (d.onlyInB.length) detail.push(`Only in ${b.name}: ${d.onlyInB.join(", ")}`);
        if (d.changed.length) detail.push("Differences in shared data sets:", ...d.changed.map((c) => short(c.line, 3000)));
        let used = 0;
        const shown: string[] = [];
        for (const line of detail) {
          if (shown.length >= MAX_DETAIL_LINES || used + line.length > detailCharBudget()) break;
          shown.push(line);
          used += line.length;
        }
        out.push("", ...(detail.length ? ["Details", ...shown] : ["No differences."]));
        if (shown.length < detail.length) out.push("", `Cut: ${detail.length - shown.length} more detail lines did not fit. Ask about one data set at a time.`);
        return text(out.join("\n"));
      }),
  );

  server.registerTool(
    "insyte_check_system",
    {
      title: "Check an Insyte system",
      description:
        "Health check for one system. Shallow (default): host, API version, data set count, key warning, connect error. Deep: reads one row from every data set in turn, with no select, and reports data sets that fail or have unreadable fields. Deep sends one or more requests per data set, sequentially, and stops at the time budget.",
      inputSchema: {
        ...systemShape(conns),
        deep: z.boolean().default(false).describe("Read one row from every data set. Slower and sends many requests; use only when asked."),
        budgetSeconds: z.number().int().min(5).max(600).default(DEFAULT_BUDGET_SECONDS).describe("Deep only: stop after this many seconds (default 60)."),
      },
      annotations: readOnly,
    },
    async ({ system, deep, budgetSeconds }) =>
      run(async () => {
        let conn: Awaited<ReturnType<typeof conns.connect>>;
        try {
          conn = await conns.connect(system);
        } catch (err) {
          // Name errors (wrong or missing system) are the caller's to fix; connect failures are the finding.
          if (err instanceof InsyteError && /^(No Insyte system named|Several Insyte systems)/.test(err.message)) throw err;
          return json({ system: system?.trim().toLowerCase() || conns.names[0], connected: false, connectError: short((err as Error).message) });
        }
        const { name, client } = conn;
        const sets = client.dataSets();
        const shallow = {
          system: name,
          connected: true,
          host: new URL(client.base).host,
          apiVersion: client.version,
          dataSets: sets.length,
          ...(client.authWarning ? { authWarning: client.authWarning } : {}),
        };
        if (!deep) return json(shallow);
        if (client.authWarning) return json({ ...shallow, deep: "Not run: the key is rejected, so every read would fail. Fix the key first." });

        const budgetMs = (budgetSeconds ?? DEFAULT_BUDGET_SECONDS) * 1000;
        const started = Date.now();
        const skipped: { dataset: string; fields: string[] }[] = [];
        const errors: { dataset: string; error: string }[] = [];
        let ok = 0;
        let checked = 0;
        let stopped: string | undefined;
        for (const set of sets) {
          if (Date.now() - started >= budgetMs) {
            stopped = `Stopped after ${budgetSeconds} seconds with ${sets.length - checked} of ${sets.length} data sets unchecked (starting at ${set.name}). Run again with a larger budgetSeconds to finish.`;
            break;
          }
          checked++;
          try {
            const r = await client.query(set.name, { limit: 1 });
            if (r.skipped?.length) skipped.push({ dataset: set.name, fields: r.skipped });
            else ok++;
          } catch (err) {
            errors.push({ dataset: set.name, error: short((err as Error).message) });
          }
        }
        return json({
          ...shallow,
          deep: {
            checked,
            ok,
            withSkippedFields: skipped.length,
            failed: errors.length,
            seconds: Math.round((Date.now() - started) / 100) / 10,
            ...(stopped ? { note: stopped } : {}),
            skipped,
            errors,
          },
        });
      }),
  );
}

export const supportModule: ToolModule = {
  name: "support",
  profiles: ["support"],
  instructions:
    "These are Accent staff tools. Never paste one dealer's data into an answer about another dealer, and say which system every finding came from.",
  register,
};
