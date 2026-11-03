#!/usr/bin/env node
// Insyte MCP server over HTTP: the hosted connector's MCP endpoint. Stateless: every POST
// /mcp authenticates the caller, builds that person's Connections, serves the request and
// tears everything down. Nothing about a person survives between requests except the shared
// public schema cache. Read docs/hosted.md before deploying.
//
// Environment:
//   INSYTE_HTTP_AUTH           required. dev (static tokens, loopback only, testing) or oauth.
//   INSYTE_HTTP_HOST           optional. Address to listen on (default 127.0.0.1). A container sets 0.0.0.0.
//   INSYTE_HTTP_PORT           optional. Port (default 8080).
//   INSYTE_HTTP_RESOURCE_URL   oauth: required. Public https URL of /mcp, e.g. https://mcp.example.com/mcp.
//                              A token's aud must equal it exactly. dev: defaults to the local URL.
//   INSYTE_HTTP_DEV_TOKENS     dev: required. Path to the JSON file mapping tokens to systems. Holds real keys.
//   INSYTE_HTTP_ISSUER         oauth: required. The OAuth issuer URL. Signing keys come from its metadata.
//   INSYTE_HTTP_SUPPORT_SCOPE  oauth: optional. Scope that selects the support profile (default insyte:support).
//   INSYTE_HTTP_PROFILE_CLAIM  oauth: optional. Claim holding public or support. Wins over the scope.
//   INSYTE_HTTP_SCOPES         optional. Comma list advertised as scopes_supported (default insyte:read,insyte:support).
//   INSYTE_HTTP_JWKS_TTL       optional. Seconds to trust fetched signing keys (default 600).
//   INSYTE_HTTP_MAX_BODY       optional. Largest request body in bytes (default 1048576).
//   INSYTE_HTTP_TIMEOUT_MS     optional. Longest a request may run (default 120000).
//   INSYTE_HTTP_PER_HOST       optional. Concurrent Insyte requests per person per Insyte host (default 4).
//   INSYTE_HTTP_SCHEMA_TTL     optional. Seconds to share downloaded $metadata and OpenAPI; 0 turns it off (default 3600).
//   INSYTE_HTTP_ORIGINS        optional. Comma list of allowed Origin headers. Unset: Origin is not checked.
//   INSYTE_API_VERSION         optional. v2, v3 or auto (default auto).
//
// Stdout carries only the audit log, one JSON line per tool call. Everything else goes to stderr.

import http from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  AuthError,
  Authenticator,
  Principal,
  StubCredentialResolver,
  challenge,
  createDevAuthenticator,
  createOAuthAuthenticator,
  isLoopbackHost,
  metadataPath,
  protectedResourceMetadata,
} from "./auth.js";
import { Connections } from "./connections.js";
import { SchemaCache } from "./insyte.js";
import { createServer } from "./server.js";

export interface HttpConfig {
  auth: Authenticator;
  host: string;
  port: number;
  // Public URL of /mcp. Used in the 401 challenge and the protected resource metadata.
  resource?: string;
  authorizationServers?: string[];
  scopes?: string[];
  apiVersion?: string;
  maxBodyBytes?: number;
  timeoutMs?: number;
  perHostLimit?: number;
  // Seconds; 0 turns the shared schema cache off.
  schemaTtlSeconds?: number;
  origins?: string[];
  // Receives one object per tool call. Defaults to a JSON line on stdout.
  audit?: (entry: AuditEntry) => void;
}

export interface AuditEntry {
  time: string;
  subject: string;
  system: string | null;
  tool: string;
  dataset: string | null;
  rows: number | null;
  durationMs: number;
  isError: boolean;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

export async function startHttpServer(cfg: HttpConfig): Promise<RunningServer> {
  const maxBody = cfg.maxBodyBytes ?? 1_048_576;
  const timeoutMs = cfg.timeoutMs ?? 120_000;
  const cache = (cfg.schemaTtlSeconds ?? 3600) > 0 ? new SchemaCache((cfg.schemaTtlSeconds ?? 3600) * 1000) : undefined;
  const gates = new Gates(cfg.perHostLimit ?? 4);
  const audit = cfg.audit ?? ((e) => process.stdout.write(`${JSON.stringify(e)}\n`));
  let resource = cfg.resource;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      // The message can hold request detail, so log only the type.
      console.error(`Insyte MCP request failed: ${(err as Error).name}`);
      if (!res.headersSent) send(res, 500, { error: "Internal error." });
      else res.destroy();
    });
  });
  server.requestTimeout = timeoutMs;
  server.headersTimeout = Math.min(timeoutMs, 30_000);

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (path === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Use GET." }, { Allow: "GET, HEAD" });
      return send(res, 200, { status: "ok" });
    }
    if (resource && (path === "/.well-known/oauth-protected-resource" || path === metadataPath(resource))) {
      if (req.method !== "GET") return send(res, 405, { error: "Use GET." }, { Allow: "GET" });
      return send(res, 200, protectedResourceMetadata(resource, cfg.authorizationServers ?? [], cfg.scopes ?? []));
    }
    if (path !== "/mcp") return send(res, 404, { error: "Not found." });
    // Stateless: no session to resume (GET) or end (DELETE).
    if (req.method !== "POST") return send(res, 405, { error: "This server is stateless. Use POST /mcp." }, { Allow: "POST" });
    const origin = req.headers.origin;
    // [VERIFY against current MCP authorization spec] that servers must validate Origin.
    if (origin && cfg.origins?.length && !cfg.origins.includes(origin)) return send(res, 403, { error: "Origin not allowed." });

    let principal: Principal;
    try {
      principal = await cfg.auth.authenticate(req);
    } catch (err) {
      // Fail closed: anything that is not a clean AuthError is still a refusal.
      const e = err instanceof AuthError ? err : new AuthError("Authentication is unavailable.", 503);
      console.error(`Insyte MCP auth refused: ${e.status}${e.reason ? ` (${e.reason})` : ""}`);
      const headers: Record<string, string> = e.status === 401 ? { "WWW-Authenticate": challenge(resource ?? "http://localhost/mcp", e) } : {};
      return send(res, e.status, { error: e.message }, headers);
    }
    if (!principal.systems.length) return send(res, 403, { error: "No Insyte system is set up for this account." });

    // The body is read only after authentication, so strangers cannot make us buffer data.
    const declared = Number(req.headers["content-length"]);
    if (declared > maxBody) return send(res, 413, { error: `Request body over ${maxBody} bytes.` });
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, maxBody));
    } catch (err) {
      if (err instanceof TooLarge) return send(res, 413, { error: `Request body over ${maxBody} bytes.` });
      return send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }

    // One abort covers the deadline and a caller who hangs up; it also cancels Insyte requests.
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort();
      if (!res.headersSent) send(res, 504, { error: "The request took too long." });
      else res.destroy();
    }, timeoutMs);
    res.on("close", () => {
      clearTimeout(timer);
      abort.abort();
    });

    const conns = new Connections(principal.systems, cfg.apiVersion ?? "auto");
    for (const c of conns.all()) {
      c.client.configure({
        schemaCache: cache,
        signal: abort.signal,
        gate: (url, run) => gates.run(`${principal.subject}|${new URL(url).host.toLowerCase()}`, abort.signal, run),
      });
    }
    const mcp = createServer(conns, { profile: principal.profile });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcp.connect(transport);
    const flush = watch(transport, conns, principal.subject, audit);
    res.on("close", () => {
      // Calls that never produced a result (timeout, caller hung up) still get an audit line.
      flush();
      void mcp.close().catch(() => undefined);
    });
    await transport.handleRequest(req, res, body);
  }

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(cfg.port, cfg.host, ok);
  });
  const addr = server.address() as { port: number };
  const shown = cfg.host.includes(":") ? `[${cfg.host}]` : cfg.host;
  const url = `http://${shown}:${addr.port}`;
  resource ??= `${url}/mcp`;
  return {
    url,
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

class TooLarge extends Error {}

function readBody(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        fail(new TooLarge());
        req.pause();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

// Caps concurrent Insyte requests per key (person and host). Extra requests wait their turn.
// Waiting is bounded by the request's abort signal, and the queue itself is bounded.
class Gates {
  private readonly slots = new Map<string, { active: number; waiting: (() => void)[] }>();
  constructor(private readonly limit: number, private readonly maxQueue = 64) {}

  async run<T>(key: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    const slot = this.slots.get(key) ?? this.slots.set(key, { active: 0, waiting: [] }).get(key)!;
    if (slot.active >= this.limit) {
      if (slot.waiting.length >= this.maxQueue) throw new Error("Too many queued Insyte requests for this account.");
      await new Promise<void>((ok, fail) => {
        const turn = () => {
          signal.removeEventListener("abort", onAbort);
          ok();
        };
        const onAbort = () => {
          slot.waiting.splice(slot.waiting.indexOf(turn), 1);
          fail(new Error("The request was cancelled while waiting for a free Insyte slot."));
        };
        slot.waiting.push(turn);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    } else {
      slot.active++;
    }
    // A waiter inherits the slot from the request that finished, so active stays accurate.
    try {
      return await fn();
    } finally {
      const next = slot.waiting.shift();
      if (next) next();
      else if (--slot.active === 0) this.slots.delete(key);
    }
  }
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

// Writes one audit line per tool call by watching the JSON-RPC messages. It records names and
// counts only. Argument values (filters hold customer names) and results are never logged:
// dataset and system are logged only when they match a real one, and rows comes from the
// result's own "returned" count.
function watch(transport: StreamableHTTPServerTransport, conns: Connections, subject: string, audit: (e: AuditEntry) => void): () => void {
  const pending = new Map<string | number, { start: number; tool: string; args: Record<string, unknown> }>();
  const onmessage = transport.onmessage;
  transport.onmessage = (msg, extra) => {
    const m = msg as { id?: string | number; method?: string; params?: { name?: unknown; arguments?: unknown } };
    if (m.method === "tools/call" && m.id !== undefined) {
      const args = m.params?.arguments;
      pending.set(m.id, {
        start: Date.now(),
        tool: typeof m.params?.name === "string" && TOOL_NAME.test(m.params.name) ? m.params.name : "unknown",
        args: args && typeof args === "object" ? (args as Record<string, unknown>) : {},
      });
    }
    onmessage?.(msg, extra);
  };
  const sendMsg = transport.send.bind(transport);
  transport.send = async (msg, options) => {
    const r = msg as { id?: string | number; result?: { isError?: boolean; content?: { type?: string; text?: string }[] }; error?: unknown };
    const call = r.id !== undefined ? pending.get(r.id) : undefined;
    if (call && (r.result || r.error)) {
      pending.delete(r.id!);
      try {
        audit(auditEntry(call, r, conns, subject));
      } catch {
        // Auditing must never break a request.
      }
    }
    return sendMsg(msg, options);
  };
  return () => {
    for (const call of pending.values()) {
      try {
        audit(auditEntry(call, { error: true }, conns, subject));
      } catch {
        // Auditing must never break a request.
      }
    }
    pending.clear();
  };
}

function auditEntry(
  call: { start: number; tool: string; args: Record<string, unknown> },
  r: { result?: { isError?: boolean; content?: { type?: string; text?: string }[] }; error?: unknown },
  conns: Connections,
  subject: string,
): AuditEntry {
  const isError = !!r.error || !!r.result?.isError;
  const asked = typeof call.args.system === "string" ? call.args.system.trim().toLowerCase() : "";
  const conn = asked ? conns.all().find((c) => c.config.name === asked) : conns.multi ? undefined : conns.all()[0];
  let dataset: string | null = null;
  if (conn && typeof call.args.dataset === "string") {
    try {
      dataset = conn.client.dataSet(call.args.dataset).name;
    } catch {
      dataset = "unknown";
    }
  }
  let rows: number | null = null;
  if (!isError) {
    if (call.tool === "insyte_get_record") rows = 1;
    else if (call.tool === "insyte_query" || call.tool === "insyte_get_related") {
      try {
        const returned = (JSON.parse(r.result?.content?.[0]?.text ?? "") as { returned?: unknown }).returned;
        if (typeof returned === "number") rows = returned;
      } catch {
        // not a data result
      }
    }
  }
  return { time: new Date().toISOString(), subject, system: conn?.config.name ?? null, tool: call.tool, dataset, rows, durationMs: Date.now() - call.start, isError };
}

// ---------------------------------------------------------------------------------------
// entry point

function fail(message: string): never {
  console.error(`Insyte MCP could not start: ${message}`);
  process.exit(1);
}

export function configFromEnv(env: NodeJS.ProcessEnv): HttpConfig {
  const get = (k: string) => env[k]?.trim() || undefined;
  const num = (k: string, fallback: number) => {
    const v = get(k);
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a non-negative number, not "${v}".`);
    return n;
  };
  // Zero would abort every request at once, so these must be positive.
  const pos = (k: string, fallback: number) => {
    const n = num(k, fallback);
    if (n <= 0) throw new Error(`${k} must be above zero.`);
    return n;
  };
  const host = get("INSYTE_HTTP_HOST") ?? "127.0.0.1";
  const mode = get("INSYTE_HTTP_AUTH");
  const list = (k: string, fallback: string[]) => (get(k)?.split(",").map((s) => s.trim()).filter(Boolean) ?? fallback);
  const scopes = list("INSYTE_HTTP_SCOPES", ["insyte:read", "insyte:support"]);
  const common = {
    host,
    port: num("INSYTE_HTTP_PORT", 8080),
    resource: get("INSYTE_HTTP_RESOURCE_URL"),
    scopes,
    apiVersion: (get("INSYTE_API_VERSION") ?? "auto").toLowerCase(),
    maxBodyBytes: pos("INSYTE_HTTP_MAX_BODY", 1_048_576),
    // Claude gives up on a tool call after 240 s, so a longer limit only wastes work.
    timeoutMs: Math.min(pos("INSYTE_HTTP_TIMEOUT_MS", 120_000), 230_000),
    perHostLimit: Math.max(1, num("INSYTE_HTTP_PER_HOST", 4)),
    schemaTtlSeconds: num("INSYTE_HTTP_SCHEMA_TTL", 3600),
    origins: list("INSYTE_HTTP_ORIGINS", []),
  };
  if (mode === "dev") {
    const file = get("INSYTE_HTTP_DEV_TOKENS");
    if (!file) throw new Error("INSYTE_HTTP_DEV_TOKENS must name the dev tokens file.");
    return { ...common, auth: createDevAuthenticator(file, host), authorizationServers: [] };
  }
  if (mode === "oauth") {
    const issuer = get("INSYTE_HTTP_ISSUER");
    const resource = get("INSYTE_HTTP_RESOURCE_URL");
    if (!issuer || !resource) throw new Error("oauth mode needs INSYTE_HTTP_ISSUER and INSYTE_HTTP_RESOURCE_URL.");
    if (new URL(resource).protocol !== "https:" && !isLoopbackHost(new URL(resource).hostname)) throw new Error("INSYTE_HTTP_RESOURCE_URL must be https.");
    const auth = createOAuthAuthenticator({
      issuer,
      resource,
      supportScope: get("INSYTE_HTTP_SUPPORT_SCOPE") ?? "insyte:support",
      profileClaim: get("INSYTE_HTTP_PROFILE_CLAIM"),
      jwksTtlSeconds: pos("INSYTE_HTTP_JWKS_TTL", 600),
      // [DECISION] Replace with the resolver for whichever identity option Accent picks.
      resolver: new StubCredentialResolver(),
    });
    return { ...common, auth, authorizationServers: [issuer] };
  }
  throw new Error('INSYTE_HTTP_AUTH must be "dev" or "oauth".');
}

// Run only when started directly, not when a test imports this file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let cfg: HttpConfig;
  try {
    cfg = configFromEnv(process.env);
  } catch (err) {
    fail((err as Error).message);
  }
  const running = await startHttpServer(cfg).catch((err) => fail((err as Error).message));
  if (process.env.INSYTE_HTTP_AUTH?.trim() === "dev") {
    console.error("!! DEV AUTH IS ON: static bearer tokens, loopback only. For testing on one machine. Never use it for real users. !!");
  }
  console.error(`Insyte MCP (HTTP) ready at ${running.url}/mcp, auth ${process.env.INSYTE_HTTP_AUTH?.trim()}`);
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => void running.close().then(() => process.exit(0)));
}
