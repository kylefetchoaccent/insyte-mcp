# Structured output for insyte_query, insyte_get_related, insyte_get_record

Status: not implemented. The question is not settled, and the evidence needed to settle it was not available when this was written.

## Evidence

SDK 1.32.2, read from `node_modules/@modelcontextprotocol/sdk/dist/esm`. (An earlier draft was written while node_modules was empty; those recalled claims are now replaced by the lines below.)

(a) Does it break the text output the contract promises? No, as far as the SDK goes. `CallToolResultSchema` keeps `content` and adds `structuredContent` as a separate optional field (`types.js:1296-1302`). Nothing rewrites `content`. The page() text block can stay byte-identical. Settled.

(b) Does it fail validation on error results? No. `validateToolOutput` returns early when `result.isError` is true (`server/mcp.js:247-249`). It is called from the tools/call handler (`server/mcp.js:182`). `run()` in `src/server.ts` returns `isError: true` with text only, so error results pass. The reverse risk is real: a success result with an `outputSchema` and no `structuredContent` throws `InvalidParams` (`server/mcp.js:250-252`), and a mismatch throws too (`server/mcp.js:254-259`). Every success path of the three tools would need to supply it. `structuredContent` must be a JSON object (`z.record`, `types.js:1302`), so rows need a wrapper object. Settled.

(c) Does it double what reaches the model? Not settled by the SDK. The SDK only validates and forwards both fields. Whether a client puts `structuredContent` in the model's context, in addition to `content`, is client behaviour and is not in this package. `MAX_RESULT_CHARS` is measured on the text only (`src/server.ts` `page()`), so if a client forwards both, the model could see about 2x the cap. Keeping text plus structured content under 60,000 together would roughly halve rows per page and change `returned` and `nextSkip`. The spec comment at `types.js:1290-1294` also notes `content` is always present, so the text block already carries the full JSON.

## Decision

Not implemented. (a) and (b) are clear. (c) is not: it depends on client behaviour the SDK does not show, and the cost is real (smaller pages) with no demonstrated benefit, since the text block already carries the full JSON.

## What would settle it

1. Find out which clients (Claude Desktop, Claude Code, claude.ai) pass `structuredContent` to the model, and whether they then drop `content`. If none forward it to the model, the benefit is zero. If any forward both, the cap must cover both.
2. If a client benefits, build it with a mock-server test in the style of `test/paging.mjs`: text block unchanged, an error result still passes, text plus structured content under 60,000 characters.
