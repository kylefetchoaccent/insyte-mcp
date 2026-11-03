// Offline test of the hosted HTTP server (src/http.ts, src/auth.ts) against a mock Insyte and a
// mock OAuth issuer. Needs no key. Run after `npm run build`. Exits 1 on any failure.
//   node test/http.offline.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { configFromEnv, startHttpServer } from "../dist/http.js";
import { createDevAuthenticator, createOAuthAuthenticator, StubCredentialResolver } from "../dist/auth.js";

const fails = [];
const check = (label, ok, got) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  got ${JSON.stringify(got)}`}`);
  if (!ok) fails.push(label);
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "insyte-http-"));
const metadataXml = fs.readFileSync(new URL("./fixtures/us-v2-metadata.xml", import.meta.url), "utf8");
const openapi = fs.readFileSync(new URL("./fixtures/us-openapi-v2.json", import.meta.url), "utf8");
const KEY = "KEY-mock-insyte-0123456789";
const SECRET_FILTER = "Zebediah-Quillfeather";

// ---- mock Insyte ----------------------------------------------------------------------
const hits = { metadata: 0, openapi: 0 };
let inflight = 0;
let maxInflight = 0;
let delayMs = 0;
const insyte = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (status, body, type = "application/json") => res.writeHead(status, { "content-type": type }).end(body);
  if (u.pathname === "/v3/$metadata") return send(404, "");
  if (u.pathname === "/v2/$metadata") { hits.metadata++; return send(200, metadataXml, "application/xml"); }
  if (u.pathname === "/openapi.v2.json") { hits.openapi++; return send(200, openapi); }
  if (!/^\/v2\/\w+$/.test(u.pathname)) return send(404, "");
  if (req.headers.authorization !== `X-ApiKey ${KEY}`) return send(401, "");
  inflight++; maxInflight = Math.max(maxInflight, inflight);
  await new Promise((r) => setTimeout(r, delayMs));
  inflight--;
  send(200, JSON.stringify({ value: [1, 2, 3].map((ID) => ({ ID, Status: "open" })) }));
});
await new Promise((r) => insyte.listen(0, "127.0.0.1", r));
const INSYTE = `http://127.0.0.1:${insyte.address().port}`;
const mockSystem = { name: "acme", base: INSYTE, apiKey: KEY, source: "test" };
const reset = () => { hits.metadata = 0; hits.openapi = 0; inflight = 0; maxInflight = 0; delayMs = 0; };

// ---- helpers --------------------------------------------------------------------------
const tokensFile = path.join(tmp, "tokens.json");
const entry = (subject) => ({ subject, profile: "public", systems: [{ name: "acme", base: INSYTE, apiKey: KEY }] });
fs.writeFileSync(tokensFile, JSON.stringify({ "alice-token-0001": entry("alice"), "bob-token-00002": entry("bob") }));

const rpc = (base, token, body, extra = {}) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const callQuery = (base, token, id = 1) =>
  rpc(base, token, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "insyte_query", arguments: { dataset: "Jobs", select: "ID,Status", limit: 5 } } });
const sdkClient = async (base, token) => {
  const c = new Client({ name: "http-test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
};

// ---- dev mode, in process -------------------------------------------------------------
const audit = [];
const dev = await startHttpServer({
  auth: createDevAuthenticator(tokensFile, "127.0.0.1"), host: "127.0.0.1", port: 0, authorizationServers: [],
  maxBodyBytes: 4096, audit: (e) => audit.push(e),
});
console.log("== dev mode");

let r = await rpc(dev.url, undefined, { jsonrpc: "2.0", id: 1, method: "tools/list" });
const wa = r.headers.get("www-authenticate") ?? "";
check("no token: 401 with WWW-Authenticate Bearer and resource_metadata", r.status === 401 && /^Bearer /.test(wa) && /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/.test(wa), [r.status, wa]);
r = await rpc(dev.url, "not-a-real-token", { jsonrpc: "2.0", id: 1, method: "tools/list" });
check("unknown token: 401 invalid_token", r.status === 401 && /error="invalid_token"/.test(r.headers.get("www-authenticate") ?? ""), r.status);
r = await fetch(`${dev.url}/mcp`);
check("GET /mcp is 405 with Allow: POST", r.status === 405 && r.headers.get("allow") === "POST", r.status);
r = await fetch(`${dev.url}/mcp`, { method: "DELETE", headers: { authorization: "Bearer alice-token-0001" } });
check("DELETE /mcp is 405", r.status === 405, r.status);
r = await fetch(`${dev.url}/healthz`);
check("GET /healthz is 200 without a token", r.status === 200, r.status);
r = await fetch(`${dev.url}/.well-known/oauth-protected-resource`);
const devMeta = await r.json();
check("dev mode still serves protected resource metadata", r.status === 200 && /\/mcp$/.test(devMeta.resource) && Array.isArray(devMeta.authorization_servers), devMeta);

reset();
const alice = await sdkClient(dev.url, "alice-token-0001");
const tools = (await alice.listTools()).tools.map((t) => t.name);
check("SDK client lists the tools over HTTP", tools.includes("insyte_query") && tools.includes("insyte_list_datasets"), tools);
const q = await alice.callTool({ name: "insyte_query", arguments: { dataset: "Jobs", select: "ID,Status", filter: `contains(LastName,'${SECRET_FILTER}')`, limit: 5 } });
const qbody = q.isError ? null : JSON.parse(q.content[0].text);
check("insyte_query returns rows through the mock Insyte", qbody?.returned === 3 && qbody.rows[0].Status === "open", q.content?.[0]?.text);
const bob = await sdkClient(dev.url, "bob-token-00002");
await bob.callTool({ name: "insyte_query", arguments: { dataset: "Jobs", select: "ID", limit: 1 } });
check("two people share one $metadata and one OpenAPI download", hits.metadata === 1 && hits.openapi === 1, hits);
await alice.close(); await bob.close();

const aq = audit.find((e) => e.subject === "alice" && e.tool === "insyte_query");
check("audit line has subject, system, tool, dataset, rows, duration, isError", aq && aq.system === "acme" && aq.dataset === "Jobs" && aq.rows === 3 && aq.isError === false && typeof aq.durationMs === "number" && !Number.isNaN(Date.parse(aq.time)), aq);
check("audit entries have exactly the allowed fields", audit.every((e) => Object.keys(e).sort().join() === "dataset,durationMs,isError,rows,subject,system,time,tool"), audit[0]);
const dump = JSON.stringify(audit);
check("audit holds no filter value, key or token", !dump.includes(SECRET_FILTER) && !dump.includes(KEY) && !dump.includes("alice-token-0001") && !dump.includes("bob-token"), dump.slice(0, 200));

r = await rpc(dev.url, "alice-token-0001", "x".repeat(10_000));
check("body over the limit: 413", r.status === 413, r.status);
r = await rpc(dev.url, "alice-token-0001", "{not json");
check("invalid JSON: 400", r.status === 400, r.status);
await dev.close();

// Concurrency cap, with a sensitivity check: a higher cap lets requests overlap.
for (const [limit, label] of [[1, "cap of 1 never overlaps Insyte requests"], [4, "cap of 4 lets them overlap (the cap is what held them)"]]) {
  reset(); delayMs = 120;
  const s = await startHttpServer({ auth: createDevAuthenticator(tokensFile, "127.0.0.1"), host: "127.0.0.1", port: 0, perHostLimit: limit, audit: () => {} });
  const all = await Promise.all([1, 2, 3].map((i) => callQuery(s.url, "alice-token-0001", i)));
  check(`${label} (max in flight ${maxInflight})`, all.every((x) => x.status === 200) && (limit === 1 ? maxInflight === 1 : maxInflight > 1), maxInflight);
  await s.close();
}

reset(); delayMs = 1500;
const slowAudit = [];
const slow = await startHttpServer({ auth: createDevAuthenticator(tokensFile, "127.0.0.1"), host: "127.0.0.1", port: 0, timeoutMs: 400, audit: (e) => slowAudit.push(e) });
const t0 = Date.now();
r = await callQuery(slow.url, "alice-token-0001");
check("request timeout: 504 before Insyte answers", r.status === 504 && Date.now() - t0 < 1400, [r.status, Date.now() - t0]);
await new Promise((r) => setTimeout(r, 100));
check("a timed-out call still gets an audit line with isError", slowAudit.length === 1 && slowAudit[0].isError === true && slowAudit[0].tool === "insyte_query", slowAudit);
await slow.close();

// ---- dev mode refuses a non-loopback bind --------------------------------------------
console.log("== dev bind refusal");
for (const host of ["0.0.0.0", "192.168.1.20", "::", "example.com", ""]) {
  let msg = "";
  try { createDevAuthenticator(tokensFile, host); } catch (e) { msg = e.message; }
  check(`dev auth refuses host "${host}"`, /refuses to listen/.test(msg), msg);
}
for (const host of ["127.0.0.1", "localhost", "::1"]) {
  let ok = true;
  try { createDevAuthenticator(tokensFile, host); } catch { ok = false; }
  check(`dev auth accepts host "${host}"`, ok);
}
let cfgMsg = "";
try { configFromEnv({ INSYTE_HTTP_AUTH: "dev", INSYTE_HTTP_HOST: "0.0.0.0", INSYTE_HTTP_DEV_TOKENS: tokensFile }); } catch (e) { cfgMsg = e.message; }
check("configFromEnv refuses dev on 0.0.0.0", /refuses to listen/.test(cfgMsg), cfgMsg);
check("no auth mode set: refuses to start", (() => { try { configFromEnv({}); return false; } catch { return true; } })());

const run = (env) => spawn(process.execPath, ["dist/http.js"], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
const refused = run({ INSYTE_HTTP_AUTH: "dev", INSYTE_HTTP_HOST: "0.0.0.0", INSYTE_HTTP_DEV_TOKENS: tokensFile });
let refusedErr = "";
refused.stderr.on("data", (d) => (refusedErr += d));
const code = await new Promise((ok) => refused.on("exit", ok));
check("the process exits 1 and says why on a non-loopback dev bind", code === 1 && /refuses to listen/.test(refusedErr), [code, refusedErr.slice(0, 120)]);

// ---- real process: stdout is the audit log ---------------------------------------------
console.log("== dev mode as a process");
reset();
const child = run({ INSYTE_HTTP_AUTH: "dev", INSYTE_HTTP_DEV_TOKENS: tokensFile, INSYTE_HTTP_PORT: "0" });
let childOut = "", childErr = "";
child.stdout.on("data", (d) => (childOut += d));
child.stderr.on("data", (d) => (childErr += d));
const childUrl = await new Promise((ok, fail) => {
  const t = setTimeout(() => fail(new Error(`child did not start: ${childErr}`)), 15000);
  child.stderr.on("data", () => { const m = /ready at (http:\/\/\S+?)\/mcp/.exec(childErr); if (m) { clearTimeout(t); ok(m[1]); } });
});
check("dev startup warns loudly on stderr", /DEV AUTH IS ON/.test(childErr), childErr);
const cc = await sdkClient(childUrl, "alice-token-0001");
await cc.callTool({ name: "insyte_query", arguments: { dataset: "Jobs", select: "ID", filter: `contains(LastName,'${SECRET_FILTER}')`, limit: 2 } });
await cc.close();
await new Promise((r) => setTimeout(r, 200));
child.kill();
const lines = childOut.split("\n").filter(Boolean);
check("stdout holds one JSON audit line per tool call", lines.length === 1 && JSON.parse(lines[0]).tool === "insyte_query", lines);
check("real stdout and stderr hold no filter value, key or token", ![childOut, childErr].some((t) => t.includes(SECRET_FILTER) || t.includes(KEY) || t.includes("alice-token-0001")));

// ---- oauth mode -----------------------------------------------------------------------
console.log("== oauth mode");
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const otherRsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwkOf = (pair, kid, alg) => ({ ...pair.publicKey.export({ format: "jwk" }), kid, alg, use: "sig" });
const jwks = { keys: [jwkOf(rsa, "rsa-1", "RS256"), jwkOf(ec, "ec-1", "ES256")] };
let issuerHits = 0;
const issuerSrv = http.createServer((req, res) => {
  issuerHits++;
  const iss = `http://127.0.0.1:${issuerSrv.address().port}`;
  const j = (o) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
  if (req.url === "/.well-known/oauth-authorization-server") return j({ issuer: iss, jwks_uri: `${iss}/jwks` });
  if (req.url === "/jwks") return j(jwks);
  res.writeHead(404).end();
});
await new Promise((r) => issuerSrv.listen(0, "127.0.0.1", r));
const ISS = `http://127.0.0.1:${issuerSrv.address().port}`;
const RESOURCE = "https://mcp.example.test/mcp";
const now = () => Math.floor(Date.now() / 1000);
const sign = (claims, { alg = "RS256", kid = alg === "RS256" ? "rsa-1" : "ec-1", priv, header } = {}) => {
  const h = b64(header ?? { alg, typ: "JWT", kid });
  const body = `${h}.${b64(claims)}`;
  const key = priv ?? (alg === "RS256" ? rsa.privateKey : ec.privateKey);
  const sig = alg === "RS256" ? crypto.sign("sha256", Buffer.from(body), key) : crypto.sign("sha256", Buffer.from(body), { key, dsaEncoding: "ieee-p1363" });
  return `${body}.${sig.toString("base64url")}`;
};
const good = () => ({ iss: ISS, aud: RESOURCE, sub: "carol", exp: now() + 300, scope: "insyte:read" });
const resolver = { async resolve(c) { return c.subject === "carol" ? [mockSystem] : []; } };
const oauthCfg = { issuer: ISS, resource: RESOURCE, supportScope: "insyte:support", resolver };
const oaudit = [];
const oauth = await startHttpServer({
  auth: createOAuthAuthenticator(oauthCfg), host: "127.0.0.1", port: 0, resource: RESOURCE, authorizationServers: [ISS],
  scopes: ["insyte:read", "insyte:support"], audit: (e) => oaudit.push(e),
});
const list = (token) => rpc(oauth.url, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });

r = await fetch(`${oauth.url}/.well-known/oauth-protected-resource`);
const meta = await r.json();
check("protected resource metadata: resource, authorization_servers, scopes_supported", r.status === 200 && meta.resource === RESOURCE && meta.authorization_servers[0] === ISS && meta.scopes_supported.includes("insyte:read"), meta);
r = await fetch(`${oauth.url}/.well-known/oauth-protected-resource/mcp`);
check("path-suffixed metadata URL served too", r.status === 200, r.status);
r = await list(undefined);
check("oauth, no token: 401 pointing at the public metadata URL", r.status === 401 && r.headers.get("www-authenticate") === `Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"`, r.headers.get("www-authenticate"));

check("iss with a trailing slash accepted", (await list(sign({ ...good(), iss: ISS + "/" }))).status === 200);
check("good RS256 token accepted", (await list(sign(good()))).status === 200);
check("good ES256 token accepted", (await list(sign(good(), { alg: "ES256" }))).status === 200);
check("aud as an array that includes the resource accepted", (await list(sign({ ...good(), aud: ["other", RESOURCE] }))).status === 200);
check("token a few seconds past exp is within skew", (await list(sign({ ...good(), exp: now() - 5 }))).status === 200);
const goodClient = await sdkClient(oauth.url, sign(good()));
const oq = await goodClient.callTool({ name: "insyte_query", arguments: { dataset: "Jobs", select: "ID", limit: 2 } });
await goodClient.close();
check("SDK client with an oauth token runs insyte_query", !oq.isError && JSON.parse(oq.content[0].text).returned === 2, oq.content?.[0]?.text);
check("oauth audit line names the token's subject", oaudit.some((e) => e.subject === "carol" && e.tool === "insyte_query" && e.system === "acme"), oaudit);

const forged = sign(good(), { priv: otherRsa.privateKey });
const tampered = (() => { const [h, , s] = sign(good()).split("."); return `${h}.${b64({ ...good(), sub: "mallory", scope: "insyte:support" })}.${s}`; })();
const hmac = (() => { const h = b64({ alg: "HS256", typ: "JWT", kid: "rsa-1" }); const p = b64(good()); return `${h}.${p}.${crypto.createHmac("sha256", JSON.stringify(jwks.keys[0])).update(`${h}.${p}`).digest("base64url")}`; })();
const bad = {
  "wrong audience": sign({ ...good(), aud: "https://other.example/mcp" }),
  "missing audience": sign({ ...good(), aud: undefined }),
  "wrong issuer": sign({ ...good(), iss: "https://evil.example" }),
  "expired": sign({ ...good(), exp: now() - 3600 }),
  "no expiry": sign({ ...good(), exp: undefined }),
  "not yet valid (nbf)": sign({ ...good(), nbf: now() + 3600 }),
  "bad signature (other key, same kid)": forged,
  "payload tampered after signing": tampered,
  "alg none": `${b64({ alg: "none", typ: "JWT" })}.${b64(good())}.`,
  "alg none with a signature part": `${b64({ alg: "none", typ: "JWT" })}.${b64(good())}.AAAA`,
  "HS256 signed with the public key": hmac,
  "unknown kid": sign(good(), { kid: "nope" }),
  "garbage": "not.a.jwt",
  "two parts": "abc.def",
};
for (const [label, token] of Object.entries(bad)) {
  const res = await list(token);
  check(`rejects ${label}`, res.status === 401 && /error="invalid_token"/.test(res.headers.get("www-authenticate") ?? ""), res.status);
}
// Verified token but the resolver has nothing for this person: no systems, no access.
r = await list(sign({ ...good(), sub: "dave" }));
check("valid token with no systems: 403", r.status === 403, r.status);

check("signing keys are fetched once (discovery plus JWKS), not per token", issuerHits === 2, issuerHits);

// Profile selection, straight at the authenticator.
const reqWith = (token) => ({ headers: { authorization: `Bearer ${token}` } });
const profileOf = async (cfg, claims) => (await createOAuthAuthenticator({ ...oauthCfg, ...cfg }).authenticate(reqWith(sign({ ...good(), ...claims })))).profile;
check("support scope selects the support profile", (await profileOf({}, { scope: "insyte:read insyte:support" })) === "support");
check("no support scope: public", (await profileOf({}, {})) === "public");
check("profile claim: support", (await profileOf({ profileClaim: "insyte_profile" }, { insyte_profile: "support" })) === "support");
check("profile claim with an unknown value: public", (await profileOf({ profileClaim: "insyte_profile" }, { insyte_profile: "admin" })) === "public");


// The shipped resolver is a stub that names the decision.
const stub = await startHttpServer({ auth: createOAuthAuthenticator({ ...oauthCfg, resolver: new StubCredentialResolver() }), host: "127.0.0.1", port: 0, resource: RESOURCE, audit: () => {} });
r = await rpc(stub.url, sign(good()), { jsonrpc: "2.0", id: 1, method: "tools/list" });
const stubBody = await r.text();
check("stub resolver: 503 that names the [DECISION]", r.status === 503 && /\[DECISION\]/.test(stubBody), [r.status, stubBody.slice(0, 100)]);

// An unreachable issuer fails closed.
const lost = await startHttpServer({
  auth: createOAuthAuthenticator({ ...oauthCfg, issuer: "http://127.0.0.1:9" }), host: "127.0.0.1", port: 0, resource: RESOURCE, audit: () => {},
});
r = await rpc(lost.url, sign(good()), { jsonrpc: "2.0", id: 1, method: "tools/list" });
check("issuer unreachable: 401, not open", r.status === 401, r.status);
for (const s of [oauth, stub, lost]) await s.close();

issuerSrv.close(); insyte.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fails.length ? `${fails.length} FAILED: ${fails.join("; ")}` : "all checks passed"}`);
process.exit(fails.length ? 1 : 0);
