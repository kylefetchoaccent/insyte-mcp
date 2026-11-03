// Who is calling the hosted server, and which Insyte systems they may reach.
//
// Two authenticators sit behind one interface:
//   dev    static bearer tokens from a JSON file. For testing on one machine only.
//   oauth  JWT bearer tokens checked against an OAuth issuer's signing keys.
// A CredentialResolver then turns the verified claims into Insyte systems. Whether Insyte
// itself acts as the OAuth provider (the server then gets its own credential for Insyte's API
// for that user) or keys live in a vault is still a [DECISION], so the shipped resolver is a
// stub that says so. The token Claude sends is never forwarded to Insyte (MCP security guidance
// forbids token passthrough).
//
// Anything about the MCP authorization flow below is marked [VERIFY against current MCP
// authorization spec]: it was written from memory of RFC 9728 (protected resource metadata),
// RFC 8414 (server metadata), RFC 8707 (resource indicators) and RFC 6750 (bearer errors).

import { createHash, webcrypto } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import type { SystemSpec } from "./connections.js";
import type { Profile } from "./server.js";

export interface Principal {
  subject: string;
  profile: Profile;
  systems: SystemSpec[];
}

export interface Authenticator {
  authenticate(req: IncomingMessage): Promise<Principal>;
}

// What a verified token says, handed to the CredentialResolver.
export interface VerifiedClaims {
  subject: string;
  issuer: string;
  scopes: string[];
  claims: Record<string, unknown>;
}

export interface CredentialResolver {
  resolve(claims: VerifiedClaims): Promise<SystemSpec[]>;
}

// status 401 gets a WWW-Authenticate challenge; 503 means the server itself is not set up.
export class AuthError extends Error {
  constructor(
    // Safe to send to the caller.
    message: string,
    readonly status: 401 | 403 | 503 = 401,
    // RFC 6750 error code; absent when no token was sent. [VERIFY against current MCP authorization spec]
    readonly code?: "invalid_request" | "invalid_token" | "insufficient_scope",
    // For the server's own log only; never sent. Holds no token text.
    readonly reason?: string,
  ) {
    super(message);
  }
}

const NO_TOKEN = "Send an access token as: Authorization: Bearer <token>.";
const BAD_TOKEN = "The access token is invalid or expired.";
const MAX_TOKEN_CHARS = 8192;

export function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (!header) throw new AuthError(NO_TOKEN, 401, undefined, "no Authorization header");
  const m = /^Bearer +([A-Za-z0-9._~+/=-]+)$/i.exec(header.trim());
  if (!m) throw new AuthError(BAD_TOKEN, 401, "invalid_request", "Authorization header is not a Bearer token");
  if (m[1].length > MAX_TOKEN_CHARS) throw new AuthError(BAD_TOKEN, 401, "invalid_token", "token too long");
  return m[1];
}

const PROFILES: Profile[] = ["public", "support"];

// ---------------------------------------------------------------------------------------
// dev mode

export function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.trim().toLowerCase());
}

interface DevEntry {
  subject?: string;
  profile?: string;
  systems?: { name?: string; base?: string; apiKey?: string }[];
}

// The file maps each token to a person and their systems:
//   { "dev-token-1": { "subject": "kyle", "profile": "public",
//                      "systems": [{ "name": "acme", "base": "https://api.myinsyte.com", "apiKey": "..." }] } }
// It holds real API keys, so keep it out of git and readable only by you.
export function createDevAuthenticator(file: string, listenHost: string): Authenticator {
  // A static token must never be reachable from another machine.
  if (!isLoopbackHost(listenHost)) {
    throw new Error(
      `Dev auth refuses to listen on "${listenHost}". It uses static tokens and is for testing on one machine only. ` +
        "Bind to 127.0.0.1, localhost or ::1, or use oauth mode.",
    );
  }
  let raw: Record<string, DevEntry>;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not read the dev tokens file ${file}: ${(err as Error).message}`);
  }
  // Keyed by token hash so a lookup never compares the token text itself.
  const byHash = new Map<string, Principal>();
  for (const [token, entry] of Object.entries(raw)) {
    if (token.length < 8) throw new Error("Dev tokens must be at least 8 characters.");
    const profile = (entry.profile ?? "public") as Profile;
    if (!PROFILES.includes(profile)) throw new Error(`Dev token profile must be public or support, not "${entry.profile}".`);
    const systems = (entry.systems ?? []).map((s) => {
      if (!s.name || !s.apiKey) throw new Error("Every dev system needs a name and an apiKey.");
      return { name: s.name.toLowerCase(), base: s.base ?? "auto", apiKey: s.apiKey, source: "hosted-dev" };
    });
    byHash.set(sha256(token), { subject: entry.subject ?? `dev-${sha256(token).slice(0, 8)}`, profile, systems });
  }
  if (!byHash.size) throw new Error("The dev tokens file has no tokens.");
  return {
    async authenticate(req) {
      const found = byHash.get(sha256(bearerToken(req)));
      if (!found) throw new AuthError(BAD_TOKEN, 401, "invalid_token", "unknown dev token");
      return found;
    },
  };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ---------------------------------------------------------------------------------------
// oauth mode

export interface OAuthConfig {
  // The authorization server's issuer identifier. Must be https (loopback http allowed for tests).
  issuer: string;
  // This server's public URL for /mcp. A token's aud must equal it exactly.
  // [VERIFY against current MCP authorization spec] that aud carries this canonical URL (RFC 8707).
  resource: string;
  // Scope that selects the support profile. Anyone without it gets public.
  supportScope?: string;
  // Alternatively, a claim whose value is "public" or "support". Wins over the scope when set.
  profileClaim?: string;
  // Allowed clock difference in seconds. Keep it small.
  skewSeconds?: number;
  // How long fetched signing keys are trusted, in seconds.
  jwksTtlSeconds?: number;
  resolver: CredentialResolver;
}

type Jwk = webcrypto.JsonWebKey & { kid?: string; use?: string; alg?: string };

const ALGS = {
  RS256: { kty: "RSA", import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  ES256: { kty: "EC", import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
} as const;

export function createOAuthAuthenticator(cfg: OAuthConfig): Authenticator {
  const issuer = cfg.issuer.replace(/\/+$/, "");
  const skew = cfg.skewSeconds ?? 30;
  const keys = new JwksCache(issuer, (cfg.jwksTtlSeconds ?? 600) * 1000);
  return {
    async authenticate(req) {
      const token = bearerToken(req);
      let claims: Record<string, unknown>;
      try {
        claims = await verifyJwt(token, keys, issuer, cfg.resource, skew);
      } catch (err) {
        // Fail closed: anything unexpected is a rejection, with the detail kept in the log only.
        if (err instanceof AuthError) throw err;
        throw new AuthError(BAD_TOKEN, 401, "invalid_token", `verification failed: ${(err as Error).message}`);
      }
      const scopes = scopesOf(claims);
      const verified: VerifiedClaims = { subject: claims.sub as string, issuer, scopes, claims };
      const systems = await cfg.resolver.resolve(verified);
      return { subject: verified.subject, profile: profileOf(cfg, claims, scopes), systems };
    },
  };
}

function scopesOf(claims: Record<string, unknown>): string[] {
  const s = claims.scope ?? claims.scp;
  return typeof s === "string" ? s.split(/\s+/).filter(Boolean) : Array.isArray(s) ? s.filter((x): x is string => typeof x === "string") : [];
}

// Least privilege: anything unclear is public.
function profileOf(cfg: OAuthConfig, claims: Record<string, unknown>, scopes: string[]): Profile {
  if (cfg.profileClaim) return claims[cfg.profileClaim] === "support" ? "support" : "public";
  return cfg.supportScope && scopes.includes(cfg.supportScope) ? "support" : "public";
}

async function verifyJwt(token: string, keys: JwksCache, issuer: string, resource: string, skew: number): Promise<Record<string, unknown>> {
  const bad = (reason: string) => new AuthError(BAD_TOKEN, 401, "invalid_token", reason);
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1]) throw bad("not a three-part JWT");
  const header = jsonPart(parts[0]);
  const alg = header.alg;
  // An allow-list, not a deny-list: "none", HS256 and everything else is refused.
  if (alg !== "RS256" && alg !== "ES256") throw bad(`algorithm ${typeof alg === "string" ? alg.slice(0, 20) : "missing"} not allowed`);
  const spec = ALGS[alg];
  const jwk = await keys.find(typeof header.kid === "string" ? header.kid : undefined, alg);
  if (!jwk) throw bad("no matching signing key");
  const key = await webcrypto.subtle.importKey("jwk", jwk, spec.import, false, ["verify"]);
  const signature = Buffer.from(parts[2], "base64url");
  if (!signature.length) throw bad("empty signature");
  const ok = await webcrypto.subtle.verify(spec.verify, key, signature, Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"));
  if (!ok) throw bad("bad signature");

  const claims = jsonPart(parts[1]);
  const now = Date.now() / 1000;
  // Some issuers (Auth0) put a trailing slash in iss; compare without it on both sides.
  if (typeof claims.iss !== "string" || claims.iss.replace(/\/+$/, "") !== issuer) throw bad("wrong issuer");
  const aud = claims.aud;
  if (!(aud === resource || (Array.isArray(aud) && aud.includes(resource)))) throw bad("wrong audience");
  if (typeof claims.exp !== "number") throw bad("no expiry");
  if (now > claims.exp + skew) throw bad("expired");
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || now + skew < claims.nbf)) throw bad("not valid yet");
  if (typeof claims.sub !== "string" || !claims.sub) throw bad("no subject");
  return claims;
}

function jsonPart(part: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    // Say nothing about the content: it is caller-supplied text.
    throw new Error("token part is not JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a JSON object");
  return v as Record<string, unknown>;
}

// Signing keys, found from the issuer's metadata and cached for a while. An unknown kid
// triggers one refresh (keys rotate), but never more than once every 30 seconds, so a
// flood of forged tokens cannot turn into a flood of requests to the issuer. Keys older
// than the TTL are never used: if the refresh fails, verification fails.
class JwksCache {
  private keys: Jwk[] = [];
  private fetchedAt = 0;
  private lastAttempt = 0;
  private uri?: string;
  private refreshing?: Promise<void>;
  constructor(private readonly issuer: string, private readonly ttlMs: number) {}

  async find(kid: string | undefined, alg: "RS256" | "ES256"): Promise<Jwk | undefined> {
    if (Date.now() - this.fetchedAt > this.ttlMs || !this.keys.length) await this.refresh(5_000);
    let found = this.pick(kid, alg);
    if (!found) {
      await this.refresh(30_000).catch(() => undefined);
      found = this.pick(kid, alg);
    }
    return found;
  }

  private pick(kid: string | undefined, alg: "RS256" | "ES256"): Jwk | undefined {
    const fits = this.keys.filter(
      (k) => k.kty === ALGS[alg].kty && (!k.use || k.use === "sig") && (!k.alg || k.alg === alg) && (alg !== "ES256" || k.crv === "P-256") && !(k.d || k.p || k.q),
    );
    // Without a kid, only a single candidate is unambiguous.
    const match = kid ? fits.find((k) => k.kid === kid) : fits.length === 1 ? fits[0] : undefined;
    // 2048-bit RSA minimum (n is base64url; 256 bytes).
    if (match && alg === "RS256" && Buffer.from(match.n ?? "", "base64url").length < 256) return undefined;
    return match;
  }

  // minGapMs: skip the fetch if one ran more recently than that.
  private async refresh(minGapMs: number): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (Date.now() - this.lastAttempt < minGapMs) {
      if (Date.now() - this.fetchedAt > this.ttlMs) throw new AuthError(BAD_TOKEN, 401, "invalid_token", "signing keys are stale and the last refresh failed");
      return;
    }
    this.lastAttempt = Date.now();
    this.refreshing = this.load().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async load(): Promise<void> {
    try {
      this.uri ??= await this.discover();
      const doc = (await getJson(this.uri)) as { keys?: Jwk[] };
      if (!Array.isArray(doc.keys)) throw new Error("JWKS has no keys array");
      this.keys = doc.keys;
    } catch (err) {
      throw new AuthError(BAD_TOKEN, 401, "invalid_token", `could not load signing keys: ${(err as Error).message}`);
    }
    this.fetchedAt = Date.now();
  }

  // RFC 8414 first, then OpenID Connect discovery. [VERIFY against current MCP authorization spec]
  private async discover(): Promise<string> {
    const u = new URL(this.issuer);
    const path = u.pathname === "/" ? "" : u.pathname;
    const urls = [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${this.issuer}/.well-known/openid-configuration`];
    let last = "no metadata document";
    for (const url of urls) {
      try {
        const meta = (await getJson(url)) as { issuer?: string; jwks_uri?: string };
        // The metadata must name the issuer we asked about (RFC 8414 section 3.3).
        if (meta.issuer?.replace(/\/+$/, "") !== this.issuer) throw new Error("metadata issuer differs from the configured issuer");
        if (!meta.jwks_uri) throw new Error("metadata has no jwks_uri");
        assertSecureUrl(meta.jwks_uri);
        return meta.jwks_uri;
      } catch (err) {
        last = (err as Error).message;
      }
    }
    throw new Error(last);
  }
}

// https only, except loopback http so tests can run a mock issuer.
export function assertSecureUrl(url: string): void {
  const u = new URL(url);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) throw new Error(`${u.origin} is not https`);
}

async function getJson(url: string): Promise<unknown> {
  assertSecureUrl(url);
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  const text = await res.text();
  if (text.length > 1_000_000) throw new Error("document too large");
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------------------
// credential resolver stub

export class NotConfiguredError extends AuthError {
  constructor() {
    super(
      "This server cannot look up Insyte credentials yet. Sign-in worked, but nothing maps your identity to an Insyte system. " +
        "Accent has to decide how: [DECISION] either this server validates a token issued for itself and then gets its own credential for Insyte's API for that user (token exchange or a server-side grant; the mechanism is undecided), or API keys live in a vault.",
      503,
      undefined,
      "CredentialResolver not configured",
    );
  }
}

export class StubCredentialResolver implements CredentialResolver {
  async resolve(): Promise<SystemSpec[]> {
    throw new NotConfiguredError();
  }
}

// ---------------------------------------------------------------------------------------
// protected resource metadata (RFC 9728). [VERIFY against current MCP authorization spec]

export function protectedResourceMetadata(resource: string, authorizationServers: string[], scopes: string[]) {
  return { resource, authorization_servers: authorizationServers, scopes_supported: scopes, bearer_methods_supported: ["header"] };
}

// Where clients find the metadata: the well-known path with the resource's own path appended.
export function metadataPath(resource: string): string {
  const p = new URL(resource).pathname;
  return `/.well-known/oauth-protected-resource${p === "/" ? "" : p.replace(/\/+$/, "")}`;
}

export function challenge(resource: string, err: AuthError): string {
  const metadata = `${new URL(resource).origin}${metadataPath(resource)}`;
  const parts = [`resource_metadata="${metadata}"`];
  if (err.code) parts.push(`error="${err.code}"`, `error_description="${err.message.replace(/"/g, "'")}"`);
  return `Bearer ${parts.join(", ")}`;
}
