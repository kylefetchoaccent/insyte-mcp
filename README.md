# Insyte MCP

An MCP server that lets Claude read an Insyte Web tenant through the Insyte API. Ask Claude things like
"which open jobs over $10k has Kerry got this month?" or "show me the job lines on job 48213" and it
queries Insyte directly.

It is **read-only**. It reads the API's `$metadata` at startup, so every data set the tenant exposes
(jobs, job lines, contacts, companies, opportunities, invoices, payments, supply jobs, commissions…)
is available without per-entity code, along with the field descriptions Insyte publishes. When the
tenant's API host offers v3 (Insyte 26.3.0.0+) it uses v3 automatically; until then it uses v2.

## Tools

| Tool | What it does |
|---|---|
| `insyte_list_datasets` | Every data set, with a description and what can be expanded or followed |
| `insyte_describe_dataset` | Fields (type and description), key, expandable navigations and related lists |
| `insyte_query` | OData query: `select`, `filter`, `orderby`, `expand`, `limit`, `skip`, `count` |
| `insyte_get_record` | One record by ID |
| `insyte_get_related` | A related list from one record, e.g. `Jobs(123)/JobLines` |

Results are capped at 1,000 rows per call (and trimmed to fit Claude's context), with `hasMore` and
`nextSkip` for paging.

## Requirements

- Node.js 20 or later.
- An Insyte tenant on the **Professional** edition with the API licensed (the API is in preview).
- A **READ** API key: in Insyte, your name → Settings → Integration → Api Integration → New. Pick a
  dedicated Rep for the key; Claude sees exactly what that user can see. Creating keys needs
  *Feature Allow Setup*.

## Install

```bash
git clone <this repo> insyte-mcp && cd insyte-mcp
npm install
npm run build
```

### Claude Desktop

Settings → Developer → Edit Config, then add (use the full path to `dist/index.js`):

```json
{
  "mcpServers": {
    "insyte": {
      "command": "node",
      "args": ["C:\\Tools\\insyte-mcp\\dist\\index.js"],
      "env": { "INSYTE_API_KEY": "paste-key-here" }
    }
  }
}
```

Restart Claude Desktop.

### Claude Code

```bash
claude mcp add insyte -e INSYTE_API_KEY=paste-key-here -- node /full/path/to/insyte-mcp/dist/index.js
```

### Several tenants

Add one entry per tenant with its own name and key (`insyte-acme`, `insyte-demo`, …). Claude sees
each as a separate set of tools.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `INSYTE_API_KEY` | (required) | READ key from Api Integration |
| `INSYTE_API_BASE` | `https://api.myinsyte.com.au` | The *API Endpoint* shown on the Api Integration page; a trailing `/v2` or `/v3` is fine |
| `INSYTE_API_VERSION` | `auto` | `v2`, `v3`, or `auto` (v3 when available) |

## Testing

```bash
INSYTE_API_KEY=... npm run smoke
```

`test/smoke.mjs` drives the server over stdio like Claude does and prints each tool's output.
`test/paging.mjs <metadata.xml>` runs it against a local mock to check paging.

## Data and safety

Insyte records include customers' names, addresses and phone numbers, and everything a tool returns
goes to Claude. Use a key whose Rep only sees what the people using it should see, and revoke the key
on the Api Integration page if a laptop is lost. The server only ever sends the key to the configured
API host.

## Not yet

- Write actions (v2 has `Import/*`, `Documents`, company hold/credit limit and Live Diary booking). These
  need a READ-WRITE key and confirmation prompts, so they are left out of this first version.
- A hosted version for claude.ai connectors (one install for the whole team).
