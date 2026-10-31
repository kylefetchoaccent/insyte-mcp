// Asserting check of named systems, end to end: the add/list/test/remove commands, the OS
// credential store, and the server choosing between systems. Uses an isolated keystore
// service and registry folder, adds INSYTE_API_KEY under two names, and removes both after.
//   INSYTE_API_KEY=... node test/systems.mjs [server entry, default dist/index.js]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = process.argv[2] ?? "dist/index.js";
const key = process.env.INSYTE_API_KEY?.trim();
if (!key) { console.error("Set INSYTE_API_KEY to a working READ key."); process.exit(2); }
const home = fs.mkdtempSync(path.join(os.tmpdir(), "insyte-mcp-test-"));
const env = { ...process.env, INSYTE_MCP_HOME: home, INSYTE_MCP_KEYSTORE_SERVICE: "insyte-mcp-selftest" };
delete env.INSYTE_API_KEY;

const fails = [];
const check = (label, ok, info = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${info ? `  ${info}` : ""}`);
  if (!ok) fails.push(label);
};
// Everything the commands and tools print, to check the key never shows up.
const seen = [];
// The key goes in on stdin, never on the command line.
const cli = (args, input = "") => {
  const out = spawnSync("node", [entry, ...args], { env, input, encoding: "utf8" });
  seen.push(out.stdout, out.stderr);
  return out;
};
const short = (s) => s.replace(/\s+/g, " ").trim().slice(0, 200);
// Even if a check throws, leave no test keys in the credential store.
let cleanedUp = false;
process.on("exit", () => {
  if (cleanedUp) return;
  for (const name of ["alpha", "beta"]) spawnSync("node", [entry, "remove", name], { env });
  fs.rmSync(home, { recursive: true, force: true });
});

let r = cli(["add", "nope"], "not-a-key\n");
check("add refuses a bad key", r.status === 1 && /rejected the API key/.test(r.stderr), short(r.stderr));
r = cli(["add", "alpha"], `${key}\n`);
check("add alpha", r.status === 0, short(r.stdout + r.stderr));
r = cli(["add", "Beta"], `${key}\n`);
check("add Beta (stored lowercase)", r.status === 0 && /Added beta/.test(r.stdout), short(r.stdout + r.stderr));
const registry = fs.readFileSync(path.join(home, "systems.json"), "utf8");
check("registry holds names, not keys", /"alpha"/.test(registry) && !registry.includes(key));
r = cli(["list"]);
check("list shows both", /alpha/.test(r.stdout) && /beta/.test(r.stdout) && !/nope/.test(r.stdout));
r = cli(["test"]);
check("test passes for both", r.status === 0 && (r.stdout.match(/^OK/gm) ?? []).length === 2, short(r.stdout));

const client = new Client({ name: "systems", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: [entry], env, stderr: "inherit" }));
const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  const body = res.content.map((c) => c.text).join("\n");
  seen.push(body);
  let parsed;
  try { parsed = JSON.parse(body); } catch {}
  return { err: !!res.isError, body, parsed };
};
let t = await call("insyte_list_systems", {});
check("list_systems names both", /alpha/.test(t.body) && /beta/.test(t.body), short(t.body));
t = await call("insyte_query", { dataset: "Jobs", select: "ID", limit: 1 });
check("no system with two set up -> error", t.err && /Pass system/.test(t.body), short(t.body));
t = await call("insyte_query", { dataset: "Jobs", select: "ID", limit: 1, system: "nobody" });
check("unknown system -> error naming the real ones", t.err && /alpha, beta/.test(t.body), short(t.body));
t = await call("insyte_query", { dataset: "Jobs", select: "ID", limit: 1, count: true, system: "alpha" });
check("query alpha tags the system", !t.err && t.parsed?.system === "alpha" && t.parsed.returned === 1, short(t.body));
const totalAlpha = t.parsed?.totalCount;
const jobId = t.parsed?.rows?.[0]?.ID;
t = await call("insyte_query", { dataset: "Jobs", select: "ID", limit: 1, count: true, system: "BETA" });
check("query beta (any case)", !t.err && t.parsed?.system === "beta" && t.parsed.totalCount === totalAlpha, short(t.body));
t = await call("insyte_get_record", { dataset: "Jobs", id: jobId, select: "ID", system: "beta" });
check("get_record tags the system", !t.err && t.parsed?.system === "beta" && t.parsed.record?.ID === jobId, short(t.body));
t = await call("insyte_list_datasets", { system: "alpha" });
check("list_datasets labels the system", !t.err && /^System alpha:/.test(t.body), short(t.body));
t = await call("insyte_list_systems", {});
check("list_systems shows connected", /alpha[^\n]*connected/.test(t.body) && /beta[^\n]*connected/.test(t.body), short(t.body));
await client.close();

// The extension's name field takes whatever people type; the server must still start.
const ext = new Client({ name: "systems-ext", version: "0" });
await ext.connect(new StdioClientTransport({ command: "node", args: [entry], env: { ...env, INSYTE_API_KEY: key, INSYTE_SYSTEM_NAME: "Acme Blinds" }, stderr: "ignore" }));
const extList = await ext.callTool({ name: "insyte_list_systems", arguments: {} });
const extBody = extList.content.map((c) => c.text).join("\n");
seen.push(extBody);
check("extension name 'Acme Blinds' becomes acme-blinds", /acme-blinds \(extension setting\)/.test(extBody) && /used as "acme-blinds"/.test(extBody), short(extBody));
await ext.close();

r = cli(["remove", "alpha"]);
check("remove alpha", r.status === 0, short(r.stdout + r.stderr));
r = cli(["remove", "beta"]);
check("remove beta", r.status === 0, short(r.stdout + r.stderr));
r = cli(["list"]);
check("list empty after remove", /No systems added yet/.test(r.stdout));
// With the registry empty and no INSYTE_API_KEY, the server must refuse to start.
r = spawnSync("node", [entry], { env, input: "", encoding: "utf8", timeout: 30_000 });
check("server refuses to start with no systems", r.status === 1 && /No Insyte system is set up/.test(r.stderr), short(r.stderr));
fs.writeFileSync(path.join(home, "systems.json"), JSON.stringify({ systems: [{ name: "alpha", base: "auto" }] }));
r = cli(["test"]);
check("keys really deleted from the store", r.status === 1 && /key missing/.test(r.stdout), short(r.stdout));
check("key never appears in any output", !seen.some((s) => s?.includes(key)), `${seen.length} outputs scanned`);
fs.rmSync(home, { recursive: true, force: true });
cleanedUp = true;

console.log(`\n${fails.length ? `${fails.length} FAILED:\n  ${fails.join("\n  ")}` : "all checks passed"}`);
process.exit(fails.length ? 1 : 0);
