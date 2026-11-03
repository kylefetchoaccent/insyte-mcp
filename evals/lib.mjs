// Shared by run.mjs, capture-golden.mjs and test/evals.offline.mjs: question schema,
// check evaluators, MCP server spawn, and the MCP tool to Anthropic tool conversion.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const AUDIENCES = ["dealer", "staff"];
export const CATEGORIES = ["lookup", "count", "revenue", "pipeline", "service", "trap", "ambiguity", "multi-system", "injection"];
export const CHECK_TYPES = ["number", "must_mention", "must_ask_clarification", "must_not_mention", "must_call", "must_not_call"];
// Client and staff names must never appear in the question file.
const FORBIDDEN = /\b(southwest|wilmington|swb|todd|nicole|kerry|madeleine|james)\b|@[\w-]+\.\w+|\b\d{3}[-. ]\d{3,4}[-. ]\d{4}\b/i;

export function loadQuestions(file = path.join(ROOT, "evals", "questions.jsonl")) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { throw new Error(`questions.jsonl line ${i + 1}: ${e.message}`); }
  });
}

// Returns a list of problems. Empty means valid.
export function validateQuestions(qs) {
  const errs = [];
  const seen = new Set();
  const strs = (a) => Array.isArray(a) && a.length > 0 && a.every((s) => typeof s === "string" && s);
  for (const q of qs) {
    const w = (m) => errs.push(`${q?.id ?? "?"}: ${m}`);
    if (typeof q.id !== "string" || !/^[a-z0-9-]+$/.test(q.id)) w("id must be lowercase letters, digits and hyphens");
    if (seen.has(q.id)) w("duplicate id");
    seen.add(q.id);
    if (typeof q.question !== "string" || q.question.length < 8) w("question missing");
    else if (FORBIDDEN.test(q.question)) w("question contains a client name, person name, email or phone");
    if (!AUDIENCES.includes(q.audience)) w(`audience must be one of ${AUDIENCES}`);
    if (!CATEGORIES.includes(q.category)) w(`category must be one of ${CATEGORIES}`);
    if (typeof q.source !== "string" || !q.source.trim()) w("source missing");
    if (!Number.isInteger(q.maxToolCalls) || q.maxToolCalls < 0 || q.maxToolCalls > 30) w("maxToolCalls must be an integer 0-30");
    if (!Array.isArray(q.checks) || q.checks.length === 0) { w("checks missing"); continue; }
    for (const c of q.checks) {
      if (!CHECK_TYPES.includes(c.type)) { w(`unknown check type ${c.type}`); continue; }
      if (c.type === "number") {
        if (c.golden !== null) w("number check: golden must be null; capture-golden.mjs fills the real value");
        const g = c.goldenQuery;
        if (!g || typeof g.tool !== "string" || typeof g.args !== "object" || g.args === null) w("number check: goldenQuery needs {tool, args}");
        else if (g.extract !== undefined && !/^(totalCount|returned|sum:\w+)$/.test(g.extract)) w(`number check: bad extract ${g.extract}`);
      } else if (c.type === "must_mention" || c.type === "must_not_mention" || c.type === "must_ask_clarification") {
        if (!strs(c.terms)) w(`${c.type}: terms must be a non-empty string array`);
        if (c.mode !== undefined && !["all", "any"].includes(c.mode)) w(`${c.type}: mode must be all or any`);
      } else if (!strs(c.tools)) w(`${c.type}: tools must be a non-empty string array`);
    }
    if (q.category === "injection") {
      if (!q.inject || !strs(q.inject.tools) || typeof q.inject.text !== "string") w("injection items need inject {tools, text}");
      if (!q.checks.some((c) => c.type === "must_not_call" || c.type === "must_not_mention")) w("injection items need must_not_call or must_not_mention");
    }
    if (q.category === "ambiguity" && !q.checks.some((c) => c.type === "must_ask_clarification")) w("ambiguity items need must_ask_clarification");
    if (q.requires !== undefined && !(Number.isInteger(q.requires.minSystems) && q.requires.minSystems >= 2)) w("requires.minSystems must be an integer >= 2");
  }
  return errs;
}

// ---- Check evaluation ------------------------------------------------------------
// run = { answer: string, calls: [{name, args, isError}] }; golden = { value } or undefined.
const has = (text, term) => text.toLowerCase().includes(term.toLowerCase());
const argsHit = (call, argsMatch) =>
  !argsMatch || Object.entries(argsMatch).every(([k, re]) => {
    const v = call.args?.[k];
    return v !== undefined && new RegExp(re, "i").test(typeof v === "string" ? v : JSON.stringify(v));
  });

export function numbersIn(text) {
  return [...text.matchAll(/-?\$?\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/[$,]/g, ""))).filter(Number.isFinite);
}

export function evalCheck(c, run, golden) {
  const answer = run.answer ?? "";
  const calls = run.calls ?? [];
  switch (c.type) {
    case "number": {
      if (golden?.value === undefined || golden.value === null) return { type: c.type, status: "skipped", detail: "no golden value captured" };
      const tol = c.tolerance ?? 0;
      const ok = numbersIn(answer).some((n) => Math.abs(n - golden.value) <= tol);
      return { type: c.type, status: ok ? "pass" : "fail", detail: ok ? `matched ${golden.value}` : `expected ${golden.value}, answer numbers: ${numbersIn(answer).slice(0, 8).join(", ") || "none"}` };
    }
    case "must_mention": {
      const hit = c.terms.filter((t) => has(answer, t));
      const ok = (c.mode ?? "all") === "any" ? hit.length > 0 : hit.length === c.terms.length;
      return { type: c.type, status: ok ? "pass" : "fail", detail: ok ? "" : `missing: ${c.terms.filter((t) => !hit.includes(t)).join(", ")}` };
    }
    case "must_not_mention": {
      const hit = c.terms.filter((t) => has(answer, t));
      return { type: c.type, status: hit.length ? "fail" : "pass", detail: hit.length ? `found: ${hit.join(", ")}` : "" };
    }
    case "must_ask_clarification": {
      const hit = c.terms.filter((t) => has(answer, t));
      const ok = answer.includes("?") && hit.length >= (c.min ?? 2);
      return { type: c.type, status: ok ? "pass" : "fail", detail: ok ? "" : `needs a question mark and ${c.min ?? 2} of the terms; had ${answer.includes("?") ? "a question mark" : "no question mark"}, ${hit.length} terms` };
    }
    case "must_call": {
      const missing = c.tools.filter((t) => !calls.some((k) => k.name === t && argsHit(k, c.argsMatch)));
      return { type: c.type, status: missing.length ? "fail" : "pass", detail: missing.length ? `not called: ${missing.join(", ")}` : "" };
    }
    case "must_not_call": {
      const bad = calls.filter((k) => c.tools.includes(k.name) && argsHit(k, c.argsMatch));
      return { type: c.type, status: bad.length ? "fail" : "pass", detail: bad.length ? `called: ${bad.map((k) => `${k.name}(${JSON.stringify(k.args).slice(0, 80)})`).join("; ")}` : "" };
    }
    default:
      return { type: c.type, status: "fail", detail: "unknown check type" };
  }
}

// ---- Tool conversion -------------------------------------------------------------
// MCP tools carry JSON Schema in inputSchema. Anthropic wants input_schema with type "object".
export function toAnthropicTools(mcpTools) {
  return mcpTools.map((t) => {
    const schema = { ...(t.inputSchema ?? {}) };
    delete schema.$schema; // [VERIFY] harmless either way; removed to keep the payload plain
    if (schema.type !== "object") schema.type = "object";
    if (!schema.properties) schema.properties = {};
    return { name: t.name, description: t.description ?? t.title ?? t.name, input_schema: schema };
  });
}

export function checkAnthropicTools(tools) {
  const errs = [];
  const names = new Set();
  for (const t of tools) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) errs.push(`${t.name}: name not allowed by the API`);
    if (names.has(t.name)) errs.push(`${t.name}: duplicate`);
    names.add(t.name);
    if (typeof t.description !== "string" || !t.description) errs.push(`${t.name}: no description`);
    if (t.input_schema?.type !== "object" || typeof t.input_schema.properties !== "object") errs.push(`${t.name}: input_schema must be an object schema with properties`);
  }
  return errs;
}

// ---- MCP server ------------------------------------------------------------------
// Spawns dist/index.js over stdio. env is merged over process.env. Real runs use the user's own registry.
export async function connectServer(extraEnv = {}) {
  const entry = path.join(ROOT, "dist", "index.js");
  if (!fs.existsSync(entry)) throw new Error("dist/index.js not found. Run `npm run build` first.");
  const env = { ...process.env, ...extraEnv };
  const client = new Client({ name: "insyte-evals", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], stderr: "inherit", env }));
  return client;
}

export const resultText = (r) => (r.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");

// Parse the "- name (source): state" lines of insyte_list_systems.
export function parseSystemNames(text) {
  return [...text.matchAll(/^- (\S+) \(/gm)].map((m) => m[1]);
}
