# Insyte MCP: technical design

Version 0.2.1. For setup steps, see the [README](../README.md). This document covers how the server
works, the contract its tools keep, how it stores credentials, and the plan for a hosted connector
that people add from claude.ai's connector settings.

Labels used below: **[VERIFIED]** means tested against a live tenant or read from code;
**[UNVERIFIED]** means stated from documentation or belief and not yet checked;
**[DECISION]** means someone at Accent has to choose.

## Contents

1. [Architecture](#architecture)
2. [Tool contract](#tool-contract)
3. [Named systems](#named-systems)
4. [Security model](#security-model)
5. [Insyte API faults the server handles](#insyte-api-faults-the-server-handles)
6. [Testing](#testing)
7. [Hosted connector plan](#hosted-connector-plan)

## Architecture

The server speaks MCP over stdio. Claude Desktop or Claude Code starts it as a child process.

| Module | Job |
|---|---|
| `src/index.ts` | MCP server: registers the tools, picks the system for each call, formats results. Hands `add`, `list`, `test` and `remove` to the CLI. |
| `src/insyte.ts` | Insyte API client for one system: region detection, `$metadata` parsing, OData queries, paging, fault workarounds. No Node-only APIs, so it can run in a Worker. |
| `src/systems.ts` | Builds the list of systems from the registry file, the credential store and `INSYTE_API_KEY`. |
| `src/keystore.ts` | Reads and writes keys in Windows Credential Manager, the macOS Keychain or libsecret. |
| `src/cli.ts` | The `add`, `list`, `test` and `remove` commands. |

**Startup.** The server loads the system list, then reads every registered key from the credential
store in one call. On Windows that call runs a PowerShell script, which took under half a second in
review testing. The server then connects MCP and warms up the first system
in the background. Other systems connect on first use, so a support person with dozens of systems
never sends dozens of `$metadata` requests at once. Accent's Acceptable Use Policy (4.4) rules out
traffic patterns that could disrupt Insyte.

**Connecting a system.** For each candidate host, `InsyteClient.init()`:

1. Checks for API v3 (`/v3/$metadata`). Only a 404 means "use v2"; any other failure counts as the
   host failing.
2. Reads `/{version}/$metadata`, sending no key; Insyte serves it publicly.
3. Makes one authenticated request (`$top=1`). This is the only request in `init` that carries the
   key. A 2xx accepts the key, a 401 or 403 rejects it, and anything else counts as the host failing.
4. For the accepting host only, reads the OpenAPI document (close to 1 MB) for related-list routes.

With the endpoint set to `auto`, the candidates are each known regional host, tried in order until
one accepts the key. If a host fails (network, 5xx), `init` throws instead of settling on a host that
rejected the key, and the next tool call tries again. Only when every host rejects the key does the
server keep the first one, so the metadata tools still work, and report the rejection.
`test/region.mjs` covers each of these paths against a mocked `fetch`. **[VERIFIED]** live on the US
host; **[UNVERIFIED]** live on the Australian host (no AU key available during testing).

An explicit endpoint must be https; plain http is refused except for localhost, which the paging
test's mock server uses. An endpoint typed without a scheme gets `https://`.

**Metadata-driven tools.** The tools carry no per-entity code. Data sets, fields, keys, navigation
properties and descriptions all come from `$metadata`; related-list routes come from the OpenAPI
document. A tenant gets whatever its API version exposes: 32 data sets on the Australian host's v2
and 37 on the US host's v2 at the time of writing. **[VERIFIED]**

## Tool contract

The hosted connector must keep these names, parameters and behaviours, so prompts, skills and habits
carry over unchanged.

| Tool | Parameters | Returns |
|---|---|---|
| `insyte_list_systems` | none | Each system's name, where it came from, and connection state. Makes no Insyte calls. |
| `insyte_list_datasets` | `system?` | Data sets with descriptions, expandable navigations and related lists. |
| `insyte_describe_dataset` | `dataset`, `system?` | Fields with types and descriptions, key, navigations, related lists, and the codes seen in the 300 newest records for code-valued fields. |
| `insyte_query` | `dataset`, `select?`, `filter?`, `orderby?`, `expand?`, `limit` (1-1000, default 50), `skip?`, `count?`, `system?` | `{ system?, returned, totalCount?, hasMore, nextSkip?, note?, skipped?, rows }` |
| `insyte_get_record` | `dataset`, `id`, `select?`, `expand?`, `system?` | The record, or `{ system?, note?, record }` when there is a system or a note to report. |
| `insyte_get_related` | `dataset`, `id`, `relation`, plus the query options, `system?` | Same shape as `insyte_query`. |

Rules every implementation keeps:

- **System choice.** With one system, `system` can be left out. With several, leaving it out is an
  error that lists the names, and an unknown name is an error that lists the real ones. The server
  never picks a default between clients. Names match regardless of case.
- **Tagging.** With several systems, every data result carries `system`, so Claude can't mix up
  which client a row came from.
- **Read-only.** Every tool carries `readOnlyHint: true`. No tool writes to Insyte.
- **Bounded output.** Results stop at 1,000 rows. The server emits compact JSON and keeps the most
  rows whose complete output fits in 80,000 characters, measured on the exact text returned, with
  `hasMore`, `nextSkip` and a note saying what was cut. The cap sits under Claude Code's default MCP
  output limit (25,000 tokens), so the client never cuts rows that `nextSkip` counted as seen.
- **Honest gaps.** Fields Insyte can't read come back listed in `skipped`, not silently dropped.

## Named systems

**Where things live.**

| Data | Location | Format |
|---|---|---|
| System names, detected host, date added | `~/.insyte-mcp/systems.json` (or `INSYTE_MCP_HOME`) | Plain JSON. Holds no secrets. |
| API keys added with `add` | Windows Credential Manager (generic credential `insyte-mcp:<name>`), macOS Keychain (service `insyte-mcp`, account `<name>`), or libsecret (attributes `service=insyte-mcp account=<name>`) | Encrypted by the OS |
| The Claude Desktop extension's key | Claude Desktop's own storage for `sensitive` settings, passed in as `INSYTE_API_KEY` | **[UNVERIFIED]** that Claude Desktop encrypts it; the MCPB format marks the field sensitive |

**Names** are 1-40 characters of lowercase letters, digits, `-` and `_`, starting with a letter or
digit. The server lowercases what people type. Names never reach Insyte; they only label the system.

**Precedence.** If the extension's setting and the registry both use a name, the extension's key
wins and the server logs a warning. A registered name with no key in the credential store is skipped
with a warning that says to run `add` again.

**The `add` command** reads the key without echoing it, or from stdin when piped. It connects with
the key before storing anything. A rejected key or a bad name changes nothing. It records the host
that accepted the key, so later startups skip region detection for that system.

**Rotating a key.** Create the new key in Insyte, run `add <name>` again with it (this replaces the
stored key), then delete the old key in Insyte.

**Offboarding.** Delete the person's keys on Insyte's Api Integration page; that stops access no
matter what is on their laptop. Then run `remove` for each system, or delete the `insyte-mcp:*`
entries from the credential store.

## Security model

How the local design meets Accent's Password Policy v1.0 and Acceptable Use Policy v1.0:

| Policy requirement | How the server meets it |
|---|---|
| "Do not store passwords in a file on ANY computer system without encryption." | Keys go to the OS credential store. The registry holds names and hosts only. The README tells people not to put `INSYTE_API_KEY` in a config file's `env` block. Version 0.1.x told Claude Code users to do exactly that; 0.2.0 removes those instructions. |
| Individual authentication; never share credentials | Each key acts as one Insyte user (the Rep chosen when the key was made). The README suggests one key per person. |
| "Passwords must not be inserted into unencrypted email messages or other forms of electronic communication." | The key never passes through chat. No tool accepts a key, and `add` reads it from the terminal. |
| No disruption of service (AUP 4.4) | Systems connect on first use; `test` checks systems one at a time; paging follows Insyte's `nextLink` with a row cap. |

**Process-level details.** Keys reach the credential store over stdin, never as command-line
arguments, because other users on a shared machine can read command lines in the process list. On
Windows the PowerShell helper writes keys back to the server over a pipe, and nothing touches disk.
The key travels only over https (plain http only to localhost), and never on `$metadata` or OpenAPI
requests. In `auto` mode each candidate host's single authentication probe carries it, in order,
until one host accepts; after that it goes only to that host. The server refuses to follow a paging
link to any other host. Tool output never contains the key: `test/live.mjs` and `test/systems.mjs`
scan every output for it. **[VERIFIED]** on Windows. **[UNVERIFIED]** on macOS (the `security -i` path) and
Linux (`secret-tool`): written, not run.

**Residual risks.**

- Any program running as the same OS user can read that user's credential-store entries. That is
  the standard trade-off of OS credential stores.
- **[DECISION]** The Password Policy says "All client passwords must only be stored in RDM." If
  Accent treats a client's Insyte API key as a client password, support staff need either an RDM
  integration (read the key from RDM at startup) or a policy ruling that the OS credential store is
  acceptable for API keys. This design assumes the second until someone rules otherwise.
- Query results contain customer personal details and go to Claude. The key's Rep limits what
  Claude can see.

## Insyte API faults the server handles

Found while testing against a US tenant on 2026-10-30. **[VERIFIED]** Insyte's error text points to
a .NET API over SQL Server **[INFERRED]**, so these belong in an Accent bug ticket.

| Fault | Seen on | Server behaviour |
|---|---|---|
| The API maps columns the tenant's database lacks; any request reading them fails | `SupplyJobLines.ProductBaseUnit`, `ProductBaseUnitFormat` | When a request names no fields, finds the bad columns once (a full single-record read names them), leaves them out, and lists them in `skipped` |
| That column fault shows up three ways: a 500 naming `Invalid column name` (single record), a 500 saying "Exception has been thrown by the target of an invocation" (lists, expands), or a 200 cut off mid-JSON (relation routes) | `SupplyJobLines` by every route; `SupplyJobs(id)/SupplyJobLines` truncated | All three trigger the column search above. An `$expand` of the affected set still fails; the error tells Claude to give that expand a nested `$select` |
| A missing single related record returns 404, not an empty result | `JobLines(id)/JobLineService`, `Opportunities(id)/ExternalLead` (one call also came back truncated) | Fetches it by expanding the parent, `Parent(id)?$expand=Rel`, and returns zero rows |
| Status, Stage and Type hold codes (`stage_job_quote`), while descriptions say "quote, order or lost" | Every data set with such fields | Instructions say so; `insyte_describe_dataset` lists the codes it finds |
| `$metadata` answers without a key on every regional host | Both hosts | Region detection uses an authenticated request |

## Testing

| Test | What it proves | Needs |
|---|---|---|
| `npm run test:live` (`test/live.mjs`) | Every data set with and without `select`, every related list, codes, paging, the output cap, error messages, and that no output contains the key. 148 checks on the US tenant; prints SKIP where a tenant lacks the data for a check. Prints IDs and counts only. | `INSYTE_API_KEY` |
| `npm run test:systems` (`test/systems.mjs`) | `add`/`list`/`test`/`remove`, the credential store round trip, system choice and tagging over MCP, a natural extension name, refusal to start with no systems, that removed keys are really gone, and that no output contains the key. 21 checks. Uses an isolated store service and registry, and cleans up even when a check throws. | `INSYTE_API_KEY` |
| `npm run test:region` (`test/region.mjs`) | Region detection with hosts up, down, rejecting or failing; that the key goes only on authentication probes; https enforcement. 13 checks against a mocked `fetch`. | Nothing |
| `node test/paging.mjs <metadata.xml>` | Paging, `nextLink` handling, annotation stripping, and refusing a foreign `nextLink`, against a local mock. 5 checks. | A saved `$metadata` file |
| `npm run smoke` | Prints each tool's output for a human to read | `INSYTE_API_KEY` |

Not covered yet: the macOS and Linux credential stores, installing the `.mcpb` in Claude Desktop, an
Australian tenant, and the Shipments relations (the test tenant has no shipments).

## Hosted connector plan

### Goal

Someone opens claude.ai's connector settings, adds Insyte, signs in, and manages their Insyte systems
on a page the connector serves. Nothing to download, no terminal, and it works in Claude on the web
and on phones, which the local server can't reach.

### How claude.ai connectors work

**[UNVERIFIED]** Check this against Anthropic's current documentation before building:

- A custom connector is a remote MCP server reached over HTTPS using the Streamable HTTP transport.
- On Team and Enterprise plans, an owner adds the connector once for the organisation; each member
  then connects it and signs in. On individual plans, each person adds it.
- Sign-in uses OAuth. The connector runs (or delegates to) an authorization server; Claude stores
  the resulting token per user and sends it with each MCP request.
- The connector's settings in claude.ai offer connect, disconnect and reconnect. Anything richer,
  such as managing Insyte systems, happens on pages the connector itself serves, reached during
  sign-in or from a link.

### What the hosted service needs

| Component | Job |
|---|---|
| MCP endpoint | Streamable HTTP. Serves the [tool contract](#tool-contract) unchanged. Reuses `src/insyte.ts` as is. |
| Authorization server | OAuth 2.1 with PKCE. Issues tokens tied to one person. |
| Identity | Who that person is. See the options below. |
| Systems page | Add, rename, test and remove Insyte systems. Keys are typed here and never shown again. |
| Key vault | Encrypted storage for each person's Insyte keys (envelope encryption: a data key per record, wrapped by a master key held in a secrets service). |
| Audit log | Who connected, which system each call used, which data set, row counts. Never record contents or keys. |
| Rate limits | A per-system cap on concurrent Insyte requests, to keep within AUP 4.4. |

`src/systems.ts`, `src/keystore.ts` and `src/cli.ts` are local-only. The hosted service replaces
them with the systems page and the key vault.

### Identity options

| Option | Who it suits | Notes |
|---|---|---|
| Accent staff SSO (Cloudflare Access or Accent's identity provider) | Support staff | Meets "individual auth" directly. Dealers can't use it. |
| Email magic link, held by the connector | Dealers | No passwords to manage. The connector becomes an identity provider of its own, which Accent's standards discourage. |
| **Insyte as the identity provider** | Everyone | People sign in with their Insyte login. The connector needs no stored API keys at all, because Insyte issues tokens scoped to that user's tenant. Needs Insyte product work: an OAuth authorization endpoint. This is the best end state. |

**[DECISION]** Which identity option, or which order. A sensible path: staff SSO first for a support
pilot, Insyte sign-in later for dealers.

### Where it runs

| | Cloudflare Workers | Accent infrastructure |
|---|---|---|
| Fit | Same stack as Canopy: Workers, Cloudflare Access, `wrangler secret`. Anthropic's MCP guidance and Cloudflare's OAuth provider library target it. **[UNVERIFIED]** | Next to Insyte. Can grow into the Insyte-native option, where Insyte itself serves MCP and handles sign-in. |
| Key storage | Keys encrypted in D1 or KV; master key in Worker secrets | Accent's existing secret store (stack to confirm) |
| Identity | Cloudflare Access for staff; any OIDC provider | Insyte's own login, if Insyte gains OAuth |
| Time to pilot | Short: Kyle has shipped this stack | Depends on Insyte team capacity |
| Data path | Customer data passes through Cloudflare, a third party Accent already uses for Canopy | Customer data stays within Accent's systems |
| Ownership | Whoever owns the Cloudflare account | Accent, by default |

**[DECISION]** Where it runs. Both options keep the same tool contract, so a Cloudflare pilot can
move to Accent infrastructure later without changing how anyone uses it.

### Multiple systems when hosted

Each person's systems belong to their own connector account, the same as on a laptop. A person adds
a system by name and key (or, with Insyte sign-in, by picking from the tenants their Insyte login
can reach). Team-shared systems would mean several people using one key, which breaks "never share
credentials", so the hosted design doesn't offer them.

Moving from local to hosted: people re-add their systems on the systems page. Names carry over, so
"In acme, how many open jobs?" keeps working.

### Phases

1. **Decide:** hosting, identity, and the RDM question above. Owner: Accent (Kerry signs off on
   security policy).
2. **Prototype:** MCP endpoint plus staff SSO plus systems page on one test tenant. Done when
   `test/live.mjs` and a ported `test/systems.mjs` pass against the hosted endpoint.
3. **Security review:** walk the audit log, key vault and rate limits through Accent's Application
   Development Standards 4.3 checklist.
4. **Support pilot:** a few support staff on real client systems. Track failed calls and wrong-system
   mistakes.
5. **Dealers:** needs the dealer identity option chosen in phase 1.

### Risks and open questions

- **[UNVERIFIED]** Whether Insyte's API accepts calls from cloud IP ranges, or limits callers by IP.
- A hosted service processes customer personal data for Accent's clients. **[DECISION]** whether
  that needs a data processing addendum or client notice.
- Claude's own data handling applies to tool results in either design. The hosted design adds one
  more processor in the path: the host.
- If Insyte gains OAuth, API keys disappear from the design entirely, and most of the key vault work
  above is no longer needed. Worth asking the Insyte team before building the vault.
