<p align="center">
  <img src="docs/images/hero.png" alt="Insyte for Claude: you ask a question, Claude works out what to look up, the Insyte MCP on your computer reads it from the Insyte API" width="880">
</p>

<p align="center">
  <a href="#step-2-install-in-claude"><b>Download</b></a> ·
  <a href="#step-1-create-an-api-key-in-insyte">Setup guide</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="#for-developers">For developers</a>
</p>

Insyte MCP connects Claude to your Insyte Web system so you can ask questions about your business in
plain English and get answers from live data. It can only **read**: it never creates, changes or
deletes anything in Insyte.

**Things you can ask**

- "How many quotes did we raise last month, and how many became orders?"
- "Show me every open job for Smith Building Co with its stage, sales rep and ETA."
- "Which opportunities from the website came in this week, and who are they assigned to?"
- "List the job lines on job 48213 with product, size and price."
- "Which invoices are past their due date and still open?"

<p align="center">
  <img src="docs/images/overview.png" alt="Setup in three steps: 1 get an API key (Insyte admin, 2 minutes), 2 install in Claude (each person, 1 minute), 3 ask away" width="880">
</p>

## Before you start

Tick these off first. Most setup problems come from one of them.

| | You need | Why |
|---|---|---|
| ☐ | **Insyte Web, Professional edition**, with the API turned on | The Insyte API is only included in Professional. If **Api Integration** is missing under Settings → Integration, contact Accent Software support. |
| ☐ | Someone with the **Feature Allow Setup** permission | Only they can create API keys. |
| ☐ | **Claude Desktop** (Mac or Windows) **or Claude Code** | Claude on the web and on phones can't run this yet. |
| ☐ | For Claude Code only: **Node.js 20 or later** | Check with `node --version`. Get it from [nodejs.org](https://nodejs.org). Claude Desktop doesn't need it. |

> [!NOTE]
> On Claude Team and Enterprise plans, an organisation admin can turn off desktop extensions. If you
> can't find **Extensions** in Claude Desktop's settings, ask your Claude admin to allow them.

---

## Step 1: Create an API key in Insyte

*Done once by an Insyte admin. Each person can have their own key, or several people can share one.*

**1.1** Click your name in the top-right corner, then **Settings**.

<p align="center"><img src="docs/images/01-open-settings.png" alt="Insyte top bar: click your name, then Settings" width="480"></p>

**1.2** Scroll down, expand **Integration**, and click **Api Integration**.

<p align="center"><img src="docs/images/02-integration-api.png" alt="Insyte Settings: expand Integration, then click Api Integration" width="720"></p>

**1.3** Click **New** and fill in the form:

| Field | What to enter |
|---|---|
| **Description** | Something you'll recognise later, e.g. `Claude – Sales team` |
| **Rep** | The Insyte user the key acts as. **Claude can see exactly what this user can see**, nothing more. |
| **Scope** | **READ** |

Click **Save**. Insyte creates the key. You can't change the Rep or Scope afterwards; delete the key
and make a new one instead.

<p align="center"><img src="docs/images/03-new-key.png" alt="New API key form with Description, Rep, Scope set to READ, and the generated Key (blurred)" width="540"></p>

**1.4** Back on the Api Integration page, click the **copy** icon on your key's card.

<p align="center"><img src="docs/images/04-copy-key.png" alt="Api Integration page: click the copy icon on the key card" width="420"></p>

> [!IMPORTANT]
> Treat the key like a password. Don't email it or paste it into a chat; pass it on through a
> password manager. Anyone with the key can read everything its Rep can see.

> [!TIP]
> **Which Rep should I pick?** For one person, use their own user. To share across a team, create
> a dedicated Insyte user (for example "Claude Reports") with only the access the team should have,
> and use that.

---

## Step 2: Install in Claude

Pick the app you use. You only need one.

<table>
<tr>
<td width="50%" valign="top">

### 🖥️ Claude Desktop

The easy option: a file you double-click.

[Go to Claude Desktop setup ↓](#2a--claude-desktop)

</td>
<td width="50%" valign="top">

### ⌨️ Claude Code

One command in the terminal.

[Go to Claude Code setup ↓](#2b--claude-code)

</td>
</tr>
</table>

### 2A · Claude Desktop

<p align="center"><img src="docs/images/desktop.png" alt="Claude Desktop install: 1 download the .mcpb file, 2 double-click it or drag it onto Claude, 3 click Install and paste your key, 4 start a new chat and ask" width="880"></p>

1. Download **[`insyte-0.1.1.mcpb`](https://github.com/kylefetchoaccent/insyte-mcp/raw/main/downloads/insyte-0.1.1.mcpb)** (click the link; it downloads straight away).
2. **Double-click** the file. If that doesn't open Claude, drag the file onto the Claude Desktop window.
3. Claude shows the Insyte extension. Click **Install**.
4. Paste your API key into **Insyte API key**. Leave **API endpoint** and **API version** as they are.
5. Start a **new chat** and ask a question (see [Step 3](#step-3-try-it)).

<details>
<summary><b>Double-clicking didn't work? Install it from Settings instead</b></summary>

<br>

The menu names vary a little between Claude Desktop versions:

- **Newer versions:** Settings → **Desktop app** → next to **Extensions** click **Manage** →
  **Advanced settings** → **Install Extension…** → choose the `.mcpb` file.
- **Older versions:** Settings → **Extensions** → **Advanced settings** → **Install Extension…** →
  choose the `.mcpb` file.

Then continue from step 3 above.

</details>

<details>
<summary><b>When should I change the API endpoint?</b></summary>

<br>

You shouldn't need to. Left as `auto`, the extension tries each Insyte region and keeps the one that
accepts your key. If Claude reports that Insyte rejected a key you know is right, copy the
**API Endpoint** shown at the top of your Api Integration page with the copy icon and paste it into
**API endpoint**.

<p align="center"><img src="docs/images/05-endpoint.png" alt="Api Integration page: copy the API Endpoint with the copy icon" width="420"></p>

</details>

### 2B · Claude Code

1. Download **[`insyte-mcp-0.1.1.zip`](https://github.com/kylefetchoaccent/insyte-mcp/raw/main/downloads/insyte-mcp-0.1.1.zip)**
   and unzip it somewhere permanent, for example your home folder. You should end up with
   `insyte-mcp/server/index.mjs`.
2. In a terminal, run the command for your system with your own key in place of `your-api-key`:

**Mac / Linux**

```bash
claude mcp add insyte --scope user -e INSYTE_API_KEY=your-api-key -- node ~/insyte-mcp/server/index.mjs
```

**Windows (PowerShell)**

```powershell
claude mcp add insyte --scope user -e INSYTE_API_KEY=your-api-key -- node "$HOME\insyte-mcp\server\index.mjs"
```

3. Check it connected:

```bash
claude mcp list
```

You should see **✓ Connected** next to `insyte`:

<p align="center"><img src="docs/images/terminal.png" alt="Terminal: claude mcp add, then claude mcp list shows insyte Connected" width="880"></p>

`--scope user` makes Insyte available in every folder you open Claude Code in. Leave it out to add
it to the current project only.

---

## Step 3: Try it

Open a **new** chat (Claude Desktop) or session (Claude Code) and ask something like:

> **How many jobs did we raise this month? Break them down by stage.**

The first time, Claude asks for permission to use the Insyte tools. Choose **Allow** (or **Always
allow** so it stops asking).

Claude works in three moves, and you'll see them in the chat:

1. **List the data sets.** It finds which Insyte data holds the answer (Jobs, Contacts, Invoices…).
2. **Describe the fields.** It checks the exact field names, so it doesn't guess.
3. **Query.** It fetches only the rows and columns it needs, then answers.

**Good questions to start with**

| Area | Try asking |
|---|---|
| Sales | "What's our quote-to-order conversion rate for the last 90 days, by sales rep?" |
| Customers | "Find the contact Jane Citizen and show her jobs and their status." |
| Jobs | "Which orders are waiting on supplier goods with an ETA in the past?" |
| Money | "List open invoices more than 30 days past their due date, with customer and invoice number." |
| Leads | "How many new opportunities did each lead source bring in this quarter?" |

> [!TIP]
> Name the time period and the details you care about. "Quotes raised since 1 July with customer
> name, sales rep and expiry date" gets a better answer than "recent quotes".

---

## Troubleshooting

| What you see | What it means | Fix |
|---|---|---|
| `Insyte API returned 401` or `403`, or `rejected INSYTE_API_KEY` | The key is wrong, deleted, or its user isn't licensed. If you changed **API endpoint**, it may point at the wrong region. | Copy the key again from Api Integration (Step 1.4) and reinstall, or create a new key. Set **API endpoint** back to `auto`, or paste the endpoint from your Api Integration page. |
| `Could not reach` followed by an Insyte address | No internet, or a firewall or proxy blocks the API | Check you're online. On a work network, ask IT to allow the API Endpoint shown on your Api Integration page. |
| `Left out …: Insyte cannot read these fields on this system` | Your Insyte database lacks columns the API expects | You still get the rest of each record. Tell Accent Software support which fields it names. |
| Claude says it has no Insyte tools | The chat was open before you installed | Start a **new** chat. If that doesn't help, quit Claude completely and reopen it. |
| No **Extensions** in Claude Desktop settings | Your Claude admin has turned extensions off | Ask your Claude admin, or use Claude Code instead. |
| `node: command not found` (Claude Code) | Node.js isn't installed | Install Node.js 20+ from [nodejs.org](https://nodejs.org), open a new terminal, and rerun the command. |
| Results are missing records you expect | The key's Rep can't see them in Insyte | Check that user's permissions in Insyte, or use a key for a user with wider access. |
| `Insyte API returned 400` | Claude wrote a query Insyte didn't accept | Usually Claude retries on its own. If not, rephrase the question or name the fields you want. |
| **Api Integration** isn't under Settings → Integration | Your edition doesn't include the API | Contact Accent Software support. |

Still stuck? In Claude Code, run `claude mcp get insyte` and include the output when you ask for help.
Remove the key from it first.

---

## Using more than one Insyte system

Support staff who work across several clients can add one copy per system, each with its own name
and key:

```bash
claude mcp add insyte-acme --scope user -e INSYTE_API_KEY=acme-key -- node ~/insyte-mcp/server/index.mjs
```

```bash
claude mcp add insyte-demo --scope user -e INSYTE_API_KEY=demo-key -- node ~/insyte-mcp/server/index.mjs
```

Then say which one you mean: "Using insyte-acme, how many open jobs are there?"

In Claude Desktop you can install the extension only once, so add the extra systems through Claude Code
or a manual config (see [For developers](#for-developers)).

## Keeping data safe

- **Read-only.** The extension has no tools that create, change or delete anything.
- **Customer details go to Claude.** Results can include names, addresses and phone numbers. Pick
  the key's Rep so it only sees what the people using it should see.
- **The key stays on your computer.** Claude Desktop keeps it in the system's secure storage. The
  server only ever sends it to the configured Insyte address.
- **Lost laptop, or someone leaves?** Delete their key on the Api Integration page. It stops working
  within moments.

## Updating or removing

| | Claude Desktop | Claude Code |
|---|---|---|
| **Update** | Download the new `.mcpb` and install it over the old one | Unzip the new version over the old folder |
| **Remove** | Settings → Extensions → **Insyte** → Uninstall | `claude mcp remove insyte --scope user` |

Remember to delete the key in Insyte if it is no longer used.

---

## For developers

<details>
<summary><b>How it works</b></summary>

<br>

At startup the server reads the API's `$metadata`, so every data set the system exposes is available
with Insyte's own field descriptions and no per-entity code. API v2 exposes 32 to 37 data sets
depending on the region: Jobs, JobLines, Contacts, Companies, Opportunities, Invoices, Payments,
SupplyJobs, commissions and more. When the host offers API v3 (Insyte 26.3.0.0+) the server uses v3.

With `INSYTE_API_BASE` unset or `auto`, it tries each Insyte region at startup and keeps the one
that accepts the key. Insyte serves `$metadata` without a key, so only an authenticated request
shows which region holds the tenant.

Fields such as `Status` and `Stage` hold codes like `stage_job_quote`, while Insyte's descriptions
use plain words ("quote, order or lost"). `insyte_describe_dataset` samples the 300 newest records
and lists the codes it finds, so Claude filters on `Stage eq 'stage_job_quote'`.

Insyte has two faults the server works around. Some related-list routes return a cut-off body or a
404 for an empty single record; the server then fetches the same data by expanding the parent. Some
tenants' databases lack columns the API still maps (seen on `SupplyJobLines`); when a request names
no fields, the server finds those columns, leaves them out, and says so in the result.

| Tool | What it does |
|---|---|
| `insyte_list_datasets` | Every data set, with its description and what can be expanded or followed |
| `insyte_describe_dataset` | Fields (type and description), key, navigation properties and related lists |
| `insyte_query` | OData query: `select`, `filter`, `orderby`, `expand`, `limit`, `skip`, `count` |
| `insyte_get_record` | One record by ID |
| `insyte_get_related` | A related list from one record, e.g. `Jobs(123)/JobLines` |

Results are capped at 1,000 rows per call and trimmed to fit Claude's context, with `hasMore` and
`nextSkip` for paging. All tools are marked read-only.

</details>

<details>
<summary><b>Configuration</b></summary>

<br>

| Variable | Default | Notes |
|---|---|---|
| `INSYTE_API_KEY` | (required) | READ key from Api Integration |
| `INSYTE_API_BASE` | `auto` | `auto` tries each Insyte region. Or paste the *API Endpoint* from the Api Integration page; a trailing `/v1`, `/v2` or `/v3` is fine |
| `INSYTE_API_VERSION` | `auto` | `v2`, `v3`, or `auto` (v3 when available) |

Manual config for Claude Desktop (`claude_desktop_config.json`) or other MCP clients:

```json
{
  "mcpServers": {
    "insyte": {
      "command": "node",
      "args": ["C:\\Users\\you\\insyte-mcp\\server\\index.mjs"],
      "env": { "INSYTE_API_KEY": "your-api-key" }
    }
  }
}
```

</details>

<details>
<summary><b>Build, test and package</b></summary>

<br>

```bash
npm install
npm run build      # TypeScript → dist/
npm run package    # single-file bundle + release/insyte-<version>.mcpb (needs: npm i -g @anthropic-ai/mcpb)
```

```bash
INSYTE_API_KEY=... npm run smoke
```

`test/smoke.mjs` drives the server over stdio the way Claude does and prints each tool's output.
`node test/paging.mjs <metadata.xml>` runs it against a local mock API to check paging.

```bash
INSYTE_API_KEY=... npm run test:live
```

`test/live.mjs` asserts against a live tenant: every data set with and without `select`, every
related list, the codes in `insyte_describe_dataset`, paging, and error messages. It prints IDs and
counts, never record contents, and exits 1 on any failure.

</details>

<details>
<summary><b>Roadmap</b></summary>

<br>

- **Write actions:** create web leads, attach documents, Live Diary bookings. These need a READ-WRITE key
  and a confirmation step, so they are left out of this version.
- **Hosted connector:** one install for a whole team in claude.ai, with no per-person setup.
- **v3 field names:** check results once 26.3.0.0 reaches production, since v3 renames some fields.

</details>

<sub>Screenshots come from Insyte's own documentation. Names, API keys and endpoints are blurred.</sub>
