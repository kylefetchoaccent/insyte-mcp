// Prompts per profile. Spawns the built server with INSYTE_MCP_PROFILE=public and =support
// against a mock Insyte host (prompts make no Insyte calls, so the mock only serves $metadata).
// Structured output did not ship (docs/structured-output.md), so there is no outputSchema check.
//   node test/ux.offline.mjs        (run after npm run build)
import http from "node:http";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const metadata = fs.readFileSync("test/fixtures/us-v2-metadata.xml", "utf8");
const srv = http.createServer((req, res) => {
  if (new URL(req.url, "http://x").pathname === "/v2/$metadata") res.writeHead(200, { "content-type": "application/xml" }).end(metadata);
  else res.writeHead(404).end();
});
await new Promise((r) => srv.listen(0, r));
const base = `http://127.0.0.1:${srv.address().port}`;

const fails = [];
const check = (label, ok, got) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  got ${JSON.stringify(got)}`}`); if (!ok) fails.push(label); };

async function connect(profile) {
  const client = new Client({ name: "ux", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], stderr: "inherit",
    env: { ...process.env, INSYTE_MCP_PROFILE: profile, INSYTE_API_KEY: "testkey", INSYTE_API_BASE: base + "/v2", INSYTE_API_VERSION: "auto",
      INSYTE_MCP_HOME: fs.mkdtempSync(`${process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"}/insyte-ux-`) } }));
  return client;
}

const PUBLIC = ["deposits_outstanding", "explain_number", "job_lookup", "pipeline_review", "rep_scorecard"];
const SUPPORT = ["check_dealer_setup", "diagnose_figure_difference"];
const sample = { figure: "July sold revenue 100", query: "ABC123", rep: "Sam" };

for (const profile of ["public", "support"]) {
  const client = await connect(profile);
  const want = profile === "public" ? PUBLIC : [...PUBLIC, ...SUPPORT].sort();
  const { prompts } = await client.listPrompts();
  const names = prompts.map((p) => p.name).sort();
  check(`${profile}: lists exactly ${want.length} prompts`, JSON.stringify(names) === JSON.stringify(want), names);

  for (const p of prompts) {
    const args = Object.fromEntries((p.arguments ?? []).filter((a) => a.required).map((a) => [a.name, sample[a.name] ?? "x"]));
    const withOpt = { ...args, system: "demo", ...((p.arguments ?? []).some((a) => a.name === "period") ? { period: "2026-07" } : {}) };
    for (const [label, a] of [["required args", args], ["with system/period", withOpt]]) {
      const r = await client.getPrompt({ name: p.name, arguments: a });
      const t = r.messages?.[0]?.content?.text ?? "";
      check(`${profile}: ${p.name} (${label}) returns text`, r.messages.length === 1 && r.messages[0].role === "user" && t.length > 200, t.slice(0, 80));
      check(`${profile}: ${p.name} (${label}) has no em dash`, !t.includes("—"), t);
      if (label !== "required args") check(`${profile}: ${p.name} uses the system arg`, t.includes('"demo"'), t.slice(0, 120));
    }
  }
  const dep = await client.getPrompt({ name: "deposits_outstanding", arguments: { period: "2026-07" } });
  check(`${profile}: period argument reaches the text`, dep.messages[0].content.text.includes("Period: 2026-07."), dep.messages[0].content.text.slice(0, 120));
  const bad = await client.getPrompt({ name: "job_lookup", arguments: {} }).then(() => null, (e) => e);
  check(`${profile}: missing required arg is rejected`, bad !== null, "no error");
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check(`${profile}: core tools still registered`, ["insyte_query", "insyte_get_record", "insyte_get_related"].every((n) => tools.includes(n)), tools);
  await client.close();
}
srv.close();
console.log(`\n${fails.length ? `${fails.length} FAILED` : "all checks passed"}`);
process.exit(fails.length ? 1 : 0);
