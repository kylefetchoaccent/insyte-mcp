# Hosting Insyte MCP for Accent: decisions and work

Prepared 2026-11-02 for Accent leadership and operations. Companion to [technical.md](technical.md).

**[UNVERIFIED]**: no primary source confirmed it. **[INFERRED]**: drawn from the sources, not stated in them. Bracketed numbers point to section 8; [T] is technical.md; [M] is Accent's Insyte data-model notes.

## 1. Summary

Insyte MCP runs on one person's computer today and reads Insyte with that person's API key [T]. To reach Claude on the web, desktop and phone, Accent must host it as a remote connector. Claude's cloud calls it over the internet from Anthropic's published IP ranges, not from the user's device [8][10]. Accent has five decisions to make first: how people sign in, how support staff reach a dealer's data, whether the dealer connector is included or paid, whether keys may live outside RDM, and what to tell dealers about customer data reaching Anthropic. The cleanest design makes Insyte itself the sign-in service (an OAuth authorization server), so the connector stores no API keys. That needs Insyte product work against the current MCP authorization specification, revision 2026-07-28 [1], plus API fixes Accent already knows about [T][M].

## 2. Decisions for Accent

### 2.1 Identity: how people sign in

| Option | What it means | Consequence |
|---|---|---|
| A. Insyte as OAuth server | People sign in with their Insyte login; Insyte issues a token tied to that user and tenant. | No stored keys. Insyte permissions apply. Largest Insyte build (3.1). |
| B. Staff SSO | Accent's identity provider signs staff in. Claude supports SSO sign-in without a consent screen [6]. | Staff only. Still needs A or C behind it to reach Insyte. |
| C. Vault of API keys | People sign in, then paste Insyte keys into a page; the service stores them encrypted [T]. | Fastest pilot. Accent holds everyone's keys, which raises breach impact and keeps 2.4 open. |

Ruled out: Claude's beta "request headers" mode, where an Owner enters one key that every member shares [6][8]. It breaks "never share credentials" [T].

**Suggested:** A as the end state; B plus C only as a time-boxed staff pilot. **Owner:** Accent leadership with the Insyte integration lead.

The spec forbids the connector from passing Claude's token on to another API [4]. So either Insyte serves the MCP endpoint itself, or the connector gets a separate token for the Insyte API [INFERRED].

### 2.2 Support access to a dealer's tenant without shared keys

- **Delegated support grant (suggested).** A dealer admin turns on "Accent support access" in Insyte for a set period. Staff sign in as themselves; the token names the staff member and tenant; every call is logged. Needs option A and an Insyte support role [INFERRED].
- **Per-person keys in the vault.** Works today, but needs one key per staff member per tenant, and offboarding means deleting keys in every tenant [T].
- **Shared support key per tenant.** Rejected: breaks individual authentication [T].

**Owner:** Insyte integration lead (design), support lead (process), security policy owner (sign-off).

### 2.3 Dealer connector: included, paid, or later

Including it in the subscription drives adoption, and Accent carries the hosting cost. A paid add-on needs an entitlement check at sign-in, which Insyte can do [INFERRED]. Staff-only for v1 carries the least risk. Directory listing is a separate choice: anyone can add a connector by URL without review [7]. **Owner:** Accent leadership.

### 2.4 Does the OS credential store satisfy the RDM rule?

The Password Policy says client passwords live only in RDM [T]. Options: rule that API keys are not client passwords; build an RDM lookup at startup; or make it moot for hosted users with option A. **Owner:** security policy owner.

### 2.5 Data processing notice to dealers

Options: update dealer terms or the data processing addendum; show a notice at first connection; let each tenant admin switch the connector off. Suggested: all three before dealer launch (section 5). **Owner:** Accent leadership with the dealer-contracts owner.

## 3. Insyte product work

Route asks through the client liaison to the Insyte integration lead, framed as read-only exposure [M].

### 3.1 OAuth 2.1 authorization server

Requirements come from MCP revision 2026-07-28 [1][2][3][4]; Claude's behaviour from Anthropic's docs [6][7].

**Insyte's authorization server must:**
- Implement OAuth 2.1 for public and confidential clients [1].
- Publish RFC 8414 or OpenID Connect discovery metadata whose `issuer` matches exactly [1][2].
- Support PKCE S256 and advertise `code_challenge_methods_supported`; clients refuse to continue without it [4]. Claude always sends S256 [6].
- Accept the `resource` parameter (RFC 8707) and bind the token's audience to the MCP server [1][4].
- Match redirect URIs exactly; serve all endpoints over HTTPS [4].
- Rotate refresh tokens for public clients [4], return `invalid_grant` for a dead one, and accept form-encoded token requests [6].
- Show the redirect hostname on the consent screen [4]. Short-lived tokens and the RFC 9207 `iss` parameter are SHOULDs today [1][4].

**Support both CIMD and DCR.** The 2026-07-28 spec prefers Client ID Metadata Documents (CIMD) and deprecates Dynamic Client Registration (DCR) [1][3]. Claude, though, follows the 2025-03-26, 2025-06-18 and 2025-11-25 revisions [7]. It uses CIMD only when metadata advertises `client_id_metadata_document_supported: true` and `none` in `token_endpoint_auth_methods_supported`, otherwise DCR [6]. Copilot Studio's automatic option uses DCR [20]; ChatGPT prefers CIMD and supports DCR [19].

**Redirect URIs:** `https://claude.ai/api/mcp/auth_callback` for claude.ai, Desktop, mobile and Cowork; any-port `http://localhost/callback` and `http://127.0.0.1/callback` for Claude Code [6]; ChatGPT's published redirects if dealers use it [19].

**Timing:** Claude waits 10 seconds for discovery, registration and token calls, 30 for refresh [6].

**The MCP endpoint must:**
- Serve RFC 9728 protected resource metadata naming the authorization server [1][2], with `resource` equal to the exact URL users enter. Claude reads only the first authorization server listed [6].
- Answer unauthenticated calls with `401` and `WWW-Authenticate: Bearer resource_metadata="..."`; Claude ignores that header on a `200` [6]. Include `scope` (SHOULD); use `403 insufficient_scope` for missing scopes [1].
- Validate every token's audience and reject tokens in the query string [1][4].

### 3.2 Picklist label endpoint

Eight fields return bare numbers: `OutcomeReasonID`, `CommitmentReasonID`, `PL_ActivityCancelReasonID`, `CustomStatusID`, `PaymentMethodID`, `JobCategoryID`, `OrganisationTypeID`, `ConfidenceLevelID`. The label routes return 404 [M]. Ask for a read-only endpoint giving ID, label and active flag per picklist per tenant.

### 3.3 Documented timezone handling

Nothing documents whether Insyte dates are UTC, tenant-local or server-local, how bare `YYYY-MM-DD` filters are read, or which zone `Activities.Start`/`End` use [M]. Month-to-date answers can be wrong as a result. Ask Accent to document all three and return datetimes with an offset [INFERRED].

### 3.4 Fixes for the faults in technical.md

| Fault [T] | Fix to ask for |
|---|---|
| API maps columns some tenant databases lack (`SupplyJobLines.ProductBaseUnit`, `ProductBaseUnitFormat`) | Align every tenant schema with `$metadata`, or drop missing columns per tenant |
| That fault surfaces as a 500 naming the column, a generic 500, or a 200 with JSON cut off | One clear error; never a 200 with a truncated body |
| A missing single related record returns 404 | Return empty (OData convention is 204) [INFERRED] |
| Status, Stage and Type hold codes while descriptions say "quote, order or lost" | Correct descriptions; serve label maps (3.2) |
| `$metadata` answers without a key on every host | Confirm intended; if not, require authentication [INFERRED] |

Also confirm whether Insyte filters API callers by IP [T] [UNVERIFIED].

### 3.5 Outstanding field requests

All **OPEN**; no Accent response recorded as of 2026-07-15 [M].

| Tier | # | Ask | Status |
|---|---|---|---|
| 1 | 0 | Serve `Representative` and `Team` sets on v2 (declared, currently 404) | OPEN |
| 1 | 1 | Fault reason on service and repair jobs, plus its label map | OPEN |
| 1 | 2 | Proofing outcome after check measure | OPEN |
| 2 | 3 | Install-complete date | OPEN |
| 2 | 4 | Who moved a job to each stage, and when | OPEN |
| 2 | 5 | Commission fields | OPEN |
| 3 | 6 | `CompanyID` on `Contacts` | OPEN |
| 3 | 7 | Manufacture start and complete dates on supply lines | OPEN |
| 3 | 8 | Shipping cost separate from install charges | OPEN |
| Older | 29b | Expose the UI's "Parent Order" field | Open, no answer [M] |

## 4. Infrastructure

**Owner:** Accent operations; security policy owner reviews.

- **Runtime.** A stateless container serving Streamable HTTP, reusing `src/insyte.ts` [T]. Claude still accepts legacy SSE, which is being deprecated [7]; Copilot Studio has dropped it [20].
- **TLS.** HTTPS on the MCP endpoint and every authorization endpoint [4], with a public-authority certificate [INFERRED].
- **Ingress and IP allowlisting.** Anthropic's IP page lists outbound ranges `160.79.104.0/21` and `153.61.208.0/20`, promises notice before changes, and lists retired `34.162.x.x` addresses [10]. The connector auth page names only `160.79.104.0/21` [6]. Allow both, on the MCP endpoint and on Insyte's discovery, registration and token endpoints, which Claude calls from the same ranges [6]. The sign-in page opens in the user's browser and stays public [1]. Tokens still do the authenticating [INFERRED].
- **Secrets.** Signing keys, and vault master keys under option C, live in a secrets service, never in images or config. Option C uses envelope encryption [T].
- **Audit logging without contents.** Log user, tenant, tool, data set, row count, duration and outcome [T]. Never log tokens, keys or rows. Drop or hash filter values, which can contain customer names [INFERRED].
- **Per-tenant rate limits.** Acceptable Use Policy 4.4 rules out traffic that could disrupt Insyte [T], and the MCP spec says servers MUST rate-limit tool calls [5]. Cap concurrent Insyte requests per tenant and per user.
- **Monitoring.** Track Insyte errors by fault class, token failures and latency. Claude allows 240 seconds per tool call and about 150,000 characters per result on claude.ai and Desktop [7], so the 60,000-character cap fits. Fit within Claude Code's 25,000-token default remains [UNVERIFIED] [T][7].
- **Staging tenant.** Non-production, synthetic data. It doubles as the directory reviewers' account, so it holds no real customer data [INFERRED].
- **Release and versioning.** Keep tool names and parameters stable [T]; change additively; publish a changelog; run the live tests on staging first [T]. Fix the URL early: changing a custom connector means removing and re-adding it [8], and a directory slug is permanent [11].
- **Interactive UI.** MCP Apps is a final extension with a stable 2026-01-26 spec [13][14], and Claude renders it on the web, in Desktop and on iOS [9][15][16]. Leave it out of v1.

## 5. Legal and privacy

**Owner:** Accent leadership with the dealer-contracts owner.

- **Personal data to Anthropic.** Tool results enter the Claude conversation through Claude's backend [16]. They include dealers' customers' names, phones, emails and addresses [M][T], limited by the Insyte user's permissions [T]. Anthropic's retention depends on the dealer's Claude plan [UNVERIFIED: not researched].
- **Roles.** The dealer controls its customer data and chose Claude; Accent processes it through the connector; the host adds one more processor [T]. This split needs legal review [INFERRED].
- **Privacy policy page.** The directory listing requires a privacy policy URL [11]. Anthropic's content list for local connectors makes a sound outline: collection, use and storage, sharing, retention, contact [11].
- **Dealer notice.** Say what leaves Insyte, where it goes, what Accent logs (metadata only), and how to switch off or revoke access.

## 6. Directory listing checklist

For the dealer "Insyte" connector only. An Owner adds "Insyte Support" as a custom connector under Organization settings > Connectors [8].

- [ ] Remote server on `https://`, OAuth for authenticated services [11], working with Claude's client (3.1) [6]
- [ ] Every tool has `title` and `readOnlyHint: true` [11][12]. Both are set on every tool in `src/server.ts` today; check new tools before submitting
- [ ] Tool names of 64 characters or fewer; descriptions say what the tool does, never how Claude should behave [12]
- [ ] `insyte_query` description names the Insyte OData v2 API, since callers build its filters [12] [INFERRED]
- [ ] Actionable errors, not bare "Bad Request" [12]
- [ ] Tested as a custom connector and in MCP Inspector [11][12]
- [ ] Documentation URL, privacy policy URL, support contact, icon [11]
- [ ] Reviewer credentials for a fully populated account (staging tenant) [11][12]
- [ ] One universal URL; per-customer URLs need the Verified label [6][11]
- [ ] Submitted by an Owner on a paid plan at claude.ai/directory/manage [7][11]; listings start as Community after an automatic scan [11]

## 7. Phased rollout

1. **Decide** 2.1 to 2.5.
   *Done when* each decision is written down with its owner's sign-off.
2. **Prototype** the endpoint and sign-in on the staging tenant. Without Insyte OAuth, use staff SSO plus the vault, labelled temporary.
   *Done when* `test/live.mjs` and a ported `test/systems.mjs` pass against the hosted URL [T] and Claude connects from web, Desktop and mobile.
3. **Security review** of audit log, tokens, rate limits and allowlist against Application Development Standards 4.3 [T].
   *Done when* the security policy owner signs off with no open high findings.
4. **Staff pilot** of "Insyte Support" on real tenants under the delegated grant.
   *Done when* two weeks of failed-call and wrong-tenant rates are measured and reviewed, and the audit log holds no contents.
5. **Dealer launch** with option A, the notice and the privacy page, then directory submission.
   *Done when* the listing is live (or Accent chooses custom-only) and first dealers connect unaided.

## 8. Sources

All accessed 2026-11-02.

1. MCP spec 2026-07-28, Authorization. https://modelcontextprotocol.io/specification/latest/basic/authorization
2. MCP, Authorization Server Discovery. https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery
3. MCP, Client Registration. https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration
4. MCP, Authorization Security Considerations. https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations
5. MCP, Tools. https://modelcontextprotocol.io/specification/latest/server/tools
6. Claude docs, Authentication for connectors. https://claude.com/docs/connectors/building/authentication
7. Claude docs, Build an MCP server for Claude. https://claude.com/docs/connectors/building/index.md
8. Claude Help Center, Get started with custom connectors using remote MCP. https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
9. Claude docs, Get started with connectors. https://claude.com/docs/connectors/overview.md
10. Claude Platform docs, IP addresses. https://platform.claude.com/docs/en/api/ip-addresses
11. Claude docs, Submit a connector to the directory. https://claude.com/docs/connectors/building/submission
12. Claude docs, Connector pre-submission checklist. https://claude.com/docs/connectors/building/review-criteria.md
13. SEP-1865, MCP Apps. https://modelcontextprotocol.io/community/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp
14. ext-apps repository. https://github.com/modelcontextprotocol/ext-apps
15. Claude docs, Get started with MCP Apps. https://claude.com/docs/connectors/building/mcp-apps/getting-started.md
16. Claude docs, Troubleshoot MCP Apps. https://claude.com/docs/connectors/building/mcp-apps/troubleshooting.md
17. anthropics/claude-code issue 55677. https://github.com/anthropics/claude-code/issues/55677
18. Cursor forum, structuredContent test (third party, 2026-08-03). https://forum.cursor.com/t/mcp-tool-results-containing-only-structuredcontent-are-silently-dropped/167346
19. OpenAI Apps SDK, Authentication. https://developers.openai.com/apps-sdk/build/auth
20. Microsoft Learn, Connect your agent to an existing MCP server (dated 2026-10-30). https://learn.microsoft.com/microsoft-copilot-studio/mcp-add-existing-server-to-agent

**Not verified.** Failed fetches: support.claude.com article 11503834 (404), help.openai.com article 12584461 (403), OpenAI developer-mode guide (404), claudeissues.com (DNS). A possible move of Claude's callback to `claude.com`, and ChatGPT's plans and transports, stay [UNVERIFIED]. No Anthropic page says whether the model sees `structuredContent` or the text block when both are present, and reports conflict [17][18]. Until Anthropic documents it, put the same data in both [5].
