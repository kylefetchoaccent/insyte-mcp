# Hosted Insyte MCP: runbook

For Accent's ops team. The server speaks MCP over HTTP so claude.ai can reach it. It is read-only. Design background is in [technical.md](technical.md#hosted-connector-plan).

**Status.** Not ready for real users. Sign-in verification works. Mapping a signed-in person to their Insyte systems does not exist yet (see "What oauth mode still needs"). Nothing has run against a real identity provider, Insyte tenant or built container.

## Run it

```
npm run build
INSYTE_HTTP_AUTH=oauth INSYTE_HTTP_ISSUER=... INSYTE_HTTP_RESOURCE_URL=... npm run start:http
```

Or build the container (`Dockerfile`: Node 24 LTS, unprivileged user, port 8080, host 0.0.0.0). Put TLS in front; the server speaks plain HTTP.

## Endpoints

| Path | Auth | Answer |
|---|---|---|
| `POST /mcp` | Bearer token | The MCP endpoint. Stateless: no sessions. |
| `GET`, `DELETE /mcp` | none | 405 |
| `GET /healthz` | none | 200 `{"status":"ok"}`. Checks only that the process answers. |
| `GET /.well-known/oauth-protected-resource` | none | Resource metadata. Also served at the same path plus `/mcp`. |

Without a valid token, `POST /mcp` returns 401 with `WWW-Authenticate: Bearer resource_metadata="..."`.

## Environment variables

| Variable | Meaning | Default |
|---|---|---|
| `INSYTE_HTTP_AUTH` | `dev` or `oauth`. Required. | none |
| `INSYTE_HTTP_HOST`, `INSYTE_HTTP_PORT` | Listen address and port | `127.0.0.1`, `8080` |
| `INSYTE_HTTP_RESOURCE_URL` | Public https URL of `/mcp`. Tokens must carry it as `aud`. Required for oauth. | local URL in dev |
| `INSYTE_HTTP_ISSUER` | OAuth issuer. Required for oauth. | none |
| `INSYTE_HTTP_SUPPORT_SCOPE` | Scope that grants the support profile | `insyte:support` |
| `INSYTE_HTTP_PROFILE_CLAIM` | Claim holding `public` or `support`; wins over the scope | unset |
| `INSYTE_HTTP_SCOPES` | Advertised `scopes_supported` | `insyte:read,insyte:support` |
| `INSYTE_HTTP_JWKS_TTL` | Seconds to trust fetched signing keys | `600` |
| `INSYTE_HTTP_MAX_BODY` | Largest request body, bytes | `1048576` |
| `INSYTE_HTTP_TIMEOUT_MS` | Longest a request may run. Capped at 230000 because Claude abandons a tool call after 240 s. | `120000` |
| `INSYTE_HTTP_PER_HOST` | Concurrent Insyte requests per person per Insyte host | `4` |
| `INSYTE_HTTP_SCHEMA_TTL` | Seconds to share downloaded `$metadata` and OpenAPI; `0` turns it off | `3600` |
| `INSYTE_HTTP_ORIGINS` | Comma list of allowed `Origin` values | unset (not checked) |
| `INSYTE_API_VERSION` | `v2`, `v3` or `auto` | `auto` |
| `INSYTE_HTTP_DEV_TOKENS` | Dev only: path to the tokens file | none |

## Dev mode

For testing on one machine. Static bearer tokens map to Insyte systems through a JSON file that holds real API keys. Format:

```
{ "a-long-test-token": { "subject": "kyle", "profile": "public",
    "systems": [ { "name": "acme", "base": "https://api.myinsyte.com", "apiKey": "..." } ] } }
```

It refuses to start unless the listen address is `127.0.0.1`, `localhost` or `::1`, and prints a warning at startup. Never use it in the container. Keep the file out of git.

## What oauth mode still needs

Oauth mode verifies RS256 and ES256 tokens against the issuer's published keys. It checks `iss`, `aud` (must equal the resource URL), `exp` and `nbf` (30 seconds of skew), and refuses `alg: none`, HMAC and every other algorithm. Any failure means 401.

Then a `CredentialResolver` has to turn the verified identity into Insyte systems. The shipped one is a stub. After a good sign-in it answers 503 and names the open decision.

**[DECISION]** Either Insyte gains an OAuth authorization server, this server validates a token issued for itself and then gets its own credential for Insyte's API for that user (token exchange or a server-side grant; the exact mechanism is undecided), and no keys are stored, or API keys live in an encrypted vault and the resolver reads them. The token Claude sends is never forwarded to Insyte: the MCP security guidance forbids token passthrough. Both options fit the `CredentialResolver` interface in `src/auth.ts`.

The authorization server must allow Claude's callback URL, `https://claude.ai/api/mcp/auth_callback`. Claude waits 10 s on discovery, registration and token calls, so keep those fast. Claude documents MCP authorization revisions 2025-03-26, 2025-06-18 and 2025-11-25; the newest is 2026-07-28.

Every spec detail (metadata paths, `aud` format, `Origin` checks, discovery order) is marked `[VERIFY against current MCP authorization spec]` in the code. Check them before launch.

## Network

Allow ingress from Anthropic's outbound ranges, `160.79.104.0/21` and `153.61.208.0/20` (source: platform.claude.com/docs/en/api/ip-addresses, read 2026-11-02; recheck before relying on it).

## Logs

Stdout carries only the audit log: one JSON line per tool call.

```
{"time":"...","subject":"...","system":"acme","tool":"insyte_query","dataset":"Jobs","rows":3,"durationMs":212,"isError":false}
```

A call that times out or loses its caller still gets a line, with `isError` true. It never holds argument values (filters can contain customer names), keys, tokens or results. `dataset` and `system` appear only when they match a real one. Stderr carries startup messages and refusal reasons, never token text. Subjects identify people, so restrict who reads the log.

## Limits

- **Concurrency:** at most `INSYTE_HTTP_PER_HOST` Insyte requests at once per person per Insyte host. Extra requests wait, up to 64 queued, (Acceptable Use Policy 4.4).
- **Body size:** over `INSYTE_HTTP_MAX_BODY` gets 413.
- **Time:** a request over `INSYTE_HTTP_TIMEOUT_MS` gets 504, and its Insyte requests are cancelled.
- **Schema cache:** `$metadata` and the OpenAPI document hold no keys or tenant data, so people share one download per host and version. Each replica keeps its own copy.

There is no per-person request rate limit yet. Put one at the proxy.

Tokens are not checked for revocation; ask for short lifetimes.
