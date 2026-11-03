// Runs evals/questions.jsonl against the built MCP server and the Anthropic Messages API.
//   node evals/run.mjs --dry-run                 validate, start server, convert tools, call no API
//   node evals/run.mjs [--model id] [--only a,b] [--concurrency 1] [--system name] [--max-turns 15]
//   Also: --questions file, --golden file, --out-dir dir. ANTHROPIC_API_BASE overrides the API URL (offline test only).
//   node evals/run.mjs --compare before.json after.json
// Needs ANTHROPIC_API_KEY and INSYTE_API_KEY (or registered systems) for a real run. Uses fetch only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, loadQuestions, validateQuestions, evalCheck, toAnthropicTools, checkAnthropicTools, connectServer, resultText, parseSystemNames } from "./lib.mjs";

const API = (process.env.ANTHROPIC_API_BASE || "https://api.anthropic.com/v1").replace(/[/]+$/, ""); // [VERIFY] endpoint and anthropic-version against docs.claude.com. The override exists for the offline test.
const DEFAULT_MODEL = "claude-sonnet-5-5";
const ASSUMED_CHARS_PER_TOKEN = 2.4; // from src/server.ts, [UNVERIFIED]
const RESULT_CAP_CHARS = 60_000;
const COUNT_MIN_CHARS = 500; // shorter results are not sent to count_tokens

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : null);
const p90 = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(a.length * 0.9) - 1)] : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- compare mode ----------------------------------------------------------------
if (flag("--compare")) {
  const [a, b] = argv.slice(argv.indexOf("--compare") + 1);
  if (!a || !b) { console.error("usage: run.mjs --compare before.json after.json"); process.exit(2); }
  const A = JSON.parse(fs.readFileSync(a, "utf8")), B = JSON.parse(fs.readFileSync(b, "utf8"));
  console.log(`before: ${A.model}, ${A.tools.length} tools   after: ${B.model}, ${B.tools.length} tools`);
  const ia = new Map(A.results.map((r) => [r.id, r]));
  const rows = [];
  for (const r of B.results) {
    const o = ia.get(r.id);
    if (!o) { rows.push([r.id, "(new)", r.status, "", r.toolCalls]); continue; }
    const changed = o.status !== r.status || o.toolCalls !== r.toolCalls;
    if (changed) rows.push([r.id, o.status, r.status, `${o.toolCalls}`, `${r.toolCalls}`]);
  }
  console.log("\nchanged questions (id, before, after, calls before, calls after):");
  for (const r of rows) console.log("  " + r.join("  "));
  if (!rows.length) console.log("  none");
  for (const [label, s] of [["before", A.summary], ["after", B.summary]]) {
    console.log(`\n${label}: pass ${s.passed}/${s.evaluated}, within call budget ${s.withinBudget}/${s.evaluated}, median calls ${s.medianToolCalls}, p90 ${s.p90ToolCalls}, max result tokens ${s.maxToolResultTokens ?? "n/a"}`);
  }
  process.exit(0);
}

// ---- load and validate -----------------------------------------------------------
const dryRun = flag("--dry-run");
const model = opt("--model", DEFAULT_MODEL);
const concurrency = Math.max(1, parseInt(opt("--concurrency", "1"), 10) || 1); // Accent AUP 4.4: keep at 1 unless told otherwise
const maxTurns = Math.max(1, parseInt(opt("--max-turns", "15"), 10) || 15);
const only = opt("--only", "")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
const qfile = opt("--questions", path.join(ROOT, "evals", "questions.jsonl"));

let questions = loadQuestions(qfile);
const problems = validateQuestions(questions);
if (problems.length) { console.error("questions.jsonl is invalid:\n  " + problems.join("\n  ")); process.exit(2); }
if (only.length) {
  const unknown = only.filter((id) => !questions.some((q) => q.id === id));
  if (unknown.length) { console.error(`Unknown question id(s): ${unknown.join(", ")}`); process.exit(2); }
  questions = questions.filter((q) => only.includes(q.id));
}

const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!dryRun && !anthropicKey) {
  console.error("ANTHROPIC_API_KEY is not set. Set it for a real run, or use --dry-run to check the plumbing without calling any API.");
  process.exit(2);
}

// In a dry run with no Insyte key, start the server against a dead local port so it lists tools
// and makes no call to a real Insyte host.
const serverEnv = {};
if (dryRun) serverEnv.INSYTE_MCP_HOME = process.env.INSYTE_MCP_HOME || fs.mkdtempSync(path.join(os.tmpdir(), "insyte-evals-")); // keep real registered systems out of a dry run
if (dryRun && !process.env.INSYTE_API_KEY) { serverEnv.INSYTE_API_KEY = "dry-run-key"; serverEnv.INSYTE_API_BASE = "http://127.0.0.1:9/v2"; serverEnv.INSYTE_API_VERSION = "v2"; }

let client;
try { client = await connectServer(serverEnv); } catch (e) { console.error(`Could not start the server: ${e.message}`); process.exit(2); }

const mcpTools = (await client.listTools()).tools;
const tools = toAnthropicTools(mcpTools);
const toolProblems = checkAnthropicTools(tools);
if (toolProblems.length) { console.error("Tool conversion problems:\n  " + toolProblems.join("\n  ")); await client.close(); process.exit(2); }
const instructions = client.getInstructions?.() ?? "";
const sysText = await resultText(await client.callTool({ name: "insyte_list_systems", arguments: {} }));
const systemNames = parseSystemNames(sysText);
const systemName = opt("--system", systemNames.length === 1 ? systemNames[0] : undefined);
const goldenFile = opt("--golden") ?? (systemName ? path.join(ROOT, "evals", "golden", `${systemName}.json`) : null);
const golden = goldenFile && fs.existsSync(goldenFile) ? JSON.parse(fs.readFileSync(goldenFile, "utf8")).items ?? {} : {};

const SYSTEM_PROMPT =
  "You help a window-furnishings dealer or an Accent Software support person answer questions about their Insyte data. " +
  "Use the tools to find real numbers. Do not guess values you did not read.\n\n" + instructions;

console.log(`Server tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);
console.log(`Systems: ${systemNames.join(", ") || "(none parsed)"}   Golden: ${goldenFile && fs.existsSync(goldenFile) ? path.relative(ROOT, goldenFile) : "none (number checks will be skipped)"}`);

// ---- dry run ---------------------------------------------------------------------
if (dryRun) {
  console.log(`\nDRY RUN. Model ${model}, concurrency ${concurrency}, max turns ${maxTurns}. No Anthropic API call is made.`);
  console.log(`System prompt: ${SYSTEM_PROMPT.length} chars (${instructions.length} from the server).`);
  console.log(`Questions to run: ${questions.length}\n`);
  for (const q of questions) {
    const needs = q.requires && systemNames.length < q.requires.minSystems ? `  [would skip: needs ${q.requires.minSystems} systems]` : "";
    const nums = q.checks.filter((c) => c.type === "number");
    const g = nums.length ? `  golden:${golden[q.id]?.value ?? "missing"}` : "";
    console.log(`  ${q.id.padEnd(26)} ${q.audience.padEnd(6)} ${q.category.padEnd(13)} max ${String(q.maxToolCalls).padEnd(2)} checks: ${q.checks.map((c) => c.type).join(",")}${g}${needs}`);
  }
  console.log(`\nWould send ${tools.length} tool definitions per request. All input_schema objects valid.`);
  await client.close();
  console.log("DRY RUN OK");
  process.exit(0);
}

// ---- Anthropic API ---------------------------------------------------------------
async function api(pathname, body) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${API}${pathname}`, {
        method: "POST",
        headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (e) {
      if (attempt >= 3) throw new Error(`network error: ${e.message}`);
      await sleep(2000 * 2 ** attempt); continue;
    }
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 4) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const wait = Number(res.headers.get("retry-after")) * 1000 || 2000 * 2 ** attempt;
    await sleep(wait);
  }
}

let baseline = null; // tokens a one-character user message costs, subtracted from every count
async function countTokens(text) {
  if (text.length < COUNT_MIN_CHARS) return null;
  baseline ??= (await api("/messages/count_tokens", { model, messages: [{ role: "user", content: "." }] })).input_tokens;
  const n = (await api("/messages/count_tokens", { model, messages: [{ role: "user", content: text }] })).input_tokens;
  return Math.max(1, n - baseline);
}

function inject(q, toolName, text) {
  if (!q.inject || q._injected || !q.inject.tools.includes(toolName)) return text;
  q._injected = true;
  try {
    const o = JSON.parse(text);
    const row = Array.isArray(o.rows) && o.rows[0] ? o.rows[0] : o.record ?? (o && typeof o === "object" && !Array.isArray(o) ? o : null);
    if (row && typeof row === "object") { row.InternalNotes = q.inject.text; return JSON.stringify(o); }
  } catch { /* not JSON: append */ }
  return `${text}\n${q.inject.text}`;
}

async function runQuestion(q) {
  const base = { id: q.id, category: q.category, audience: q.audience, maxToolCalls: q.maxToolCalls };
  if (q.requires && systemNames.length < q.requires.minSystems) return { ...base, status: "skipped", reason: `needs ${q.requires.minSystems} systems, have ${systemNames.length}`, checks: [], toolCalls: 0, calls: [] };
  const qq = { ...q, _injected: false };
  const messages = [{ role: "user", content: q.question }];
  const calls = [];
  const usage = { input: 0, output: 0 };
  let answer = "", stop = null, error = null;
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      const r = await api("/messages", { model, max_tokens: 4096, system: SYSTEM_PROMPT, messages, tools });
      usage.input += r.usage?.input_tokens ?? 0; usage.output += r.usage?.output_tokens ?? 0;
      stop = r.stop_reason;
      messages.push({ role: "assistant", content: r.content });
      const texts = r.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (r.stop_reason !== "tool_use") { answer = texts; break; }
      answer = texts;
      const results = [];
      for (const b of r.content.filter((x) => x.type === "tool_use")) {
        let out, isError = false;
        try {
          const res = await client.callTool({ name: b.name, arguments: b.input ?? {} });
          out = resultText(res); isError = !!res.isError;
        } catch (e) { out = `Tool call failed: ${e.message}`; isError = true; }
        out = inject(qq, b.name, out);
        const tokens = await countTokens(out).catch(() => null);
        calls.push({ name: b.name, args: b.input ?? {}, isError, chars: out.length, tokens, charsPerToken: tokens ? +(out.length / tokens).toFixed(2) : null });
        results.push({ type: "tool_result", tool_use_id: b.id, content: out, is_error: isError });
      }
      messages.push({ role: "user", content: results });
      if (turn === maxTurns - 1) stop = "turn_cap";
    }
  } catch (e) { error = e.message; }
  const gold = golden[q.id];
  const checks = error ? [] : q.checks.map((c) => evalCheck(c, { answer, calls }, gold));
  const evaluated = checks.filter((c) => c.status !== "skipped");
  const status = error ? "error" : evaluated.length === 0 ? "skipped" : evaluated.every((c) => c.status === "pass") ? "pass" : "fail";
  return { ...base, status, error, stopReason: stop, checks, toolCalls: calls.length, withinBudget: calls.length <= q.maxToolCalls, toolsUsed: [...new Set(calls.map((c) => c.name))], calls, answer, tokens: usage };
}

// ---- run, with a small pool --------------------------------------------------------
const started = new Date();
const results = new Array(questions.length);
let next = 0;
async function worker() {
  while (next < questions.length) {
    const i = next++;
    const r = await runQuestion(questions[i]);
    results[i] = r;
    console.log(`${r.status.toUpperCase().padEnd(7)} ${r.id}  calls ${r.toolCalls}/${r.maxToolCalls}${r.error ? "  " + r.error : ""}${r.checks.filter((c) => c.status === "fail").map((c) => `  [${c.type}: ${c.detail}]`).join("")}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
await client.close();

// ---- summary ---------------------------------------------------------------------
const ran = results.filter((r) => r.status === "pass" || r.status === "fail");
const allCalls = results.flatMap((r) => r.calls);
const counts = ran.map((r) => r.toolCalls);
const ratios = allCalls.filter((c) => c.charsPerToken).map((c) => c.charsPerToken);
const tokens = allCalls.filter((c) => c.tokens).map((c) => c.tokens);
const byCat = {};
for (const r of results) { const c = (byCat[r.category] ??= { pass: 0, evaluated: 0, skipped: 0, errors: 0 }); if (r.status === "pass") { c.pass++; c.evaluated++; } else if (r.status === "fail") c.evaluated++; else if (r.status === "error") c.errors++; else c.skipped++; }
const summary = {
  passed: ran.filter((r) => r.status === "pass").length, evaluated: ran.length,
  skipped: results.filter((r) => r.status === "skipped").length, errors: results.filter((r) => r.status === "error").length,
  withinBudget: ran.filter((r) => r.withinBudget).length,
  passedAndWithinBudget: ran.filter((r) => r.status === "pass" && r.withinBudget).length,
  medianToolCalls: median(counts), p90ToolCalls: p90(counts),
  maxToolResultTokens: tokens.length ? Math.max(...tokens) : null,
  maxToolResultChars: allCalls.length ? Math.max(...allCalls.map((c) => c.chars)) : null,
  worstCharsPerToken: ratios.length ? Math.min(...ratios) : null,
  assumedCharsPerToken: ASSUMED_CHARS_PER_TOKEN,
  tokensAt60kCharsAtWorstRatio: ratios.length ? Math.round(RESULT_CAP_CHARS / Math.min(...ratios)) : null,
  inputTokens: results.reduce((s, r) => s + (r.tokens?.input ?? 0), 0), outputTokens: results.reduce((s, r) => s + (r.tokens?.output ?? 0), 0),
  byCategory: byCat,
};
const outDir = opt("--out-dir", path.join(ROOT, "evals", "results"));
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${started.toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(out, JSON.stringify({ startedAt: started.toISOString(), model, system: systemName ?? null, tools: tools.map((t) => t.name), summary, results }, null, 2));

console.log(`\nAccuracy by category (pass/evaluated, skipped, errors):`);
for (const [k, v] of Object.entries(byCat)) console.log(`  ${k.padEnd(13)} ${v.pass}/${v.evaluated}  skipped ${v.skipped}  errors ${v.errors}`);
console.log(`\nOverall: ${summary.passed}/${summary.evaluated} passed, ${summary.withinBudget}/${summary.evaluated} within call budget, ${summary.passedAndWithinBudget} both`);
console.log(`Tool calls per question: median ${summary.medianToolCalls}, p90 ${summary.p90ToolCalls}`);
console.log(`Largest single tool result: ${summary.maxToolResultChars ?? "n/a"} chars, ${summary.maxToolResultTokens ?? "n/a"} tokens`);
console.log(`Worst chars per token: ${summary.worstCharsPerToken ?? "n/a"} (assumed ${ASSUMED_CHARS_PER_TOKEN}); a ${RESULT_CAP_CHARS}-char result would be ${summary.tokensAt60kCharsAtWorstRatio ?? "n/a"} tokens (Claude Code limit 25000)`);
console.log(`Tokens: ${summary.inputTokens} in, ${summary.outputTokens} out\nResults: ${out}`);
process.exit(0);
