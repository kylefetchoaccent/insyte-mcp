// Local mock of the Insyte OData host to check paging, nextLink handling and counts.
// Exits 1 on any failure.   node test/paging.mjs <metadata.xml>
import http from "node:http";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const metadata = fs.readFileSync(process.argv[2], "utf8");
const ALL = Array.from({ length: 7 }, (_, i) => ({ ID: i + 1, Status: "open", "@odata.etag": "x" }));
let evil = false;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  // Like Insyte: $metadata is public, everything else needs the key.
  if (u.pathname === "/v2/$metadata") { res.writeHead(200, { "content-type": "application/xml" }).end(metadata); return; }
  if (!/^\/v2\/\w+(\(\d+\))?$/.test(u.pathname)) { res.writeHead(404).end(); return; }
  if (req.headers.authorization !== "X-ApiKey testkey") { res.writeHead(401).end(); return; }
  // One record bigger than the output cap on its own.
  const BIG = { ID: 999, Notes: "x".repeat(120_000) };
  if (u.pathname === "/v2/Jobs(999)") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(BIG)); return; }
  if (u.pathname === "/v2/Jobs" && u.searchParams.get("$filter") === "ID eq 999") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ value: [BIG] })); return; }
  if (u.pathname !== "/v2/Jobs") { res.writeHead(200, { "content-type": "application/json" }).end('{"value":[]}'); return; }
  const top = +u.searchParams.get("$top"), skip = +(u.searchParams.get("$skip") ?? 0);
  const pageSize = 2, take = Math.min(top, pageSize);
  const body = { value: ALL.slice(skip, skip + take) };
  if (u.searchParams.get("$count")) body["@odata.count"] = ALL.length;
  if (top > take && skip + take < ALL.length) {
    const next = new URL(req.url, `http://${req.headers.host}`);
    next.searchParams.set("$skip", String(skip + take)); next.searchParams.set("$top", String(top - take));
    next.searchParams.delete("$count");
    body["@odata.nextLink"] = evil ? "http://evil.example/v2/Jobs" : next.toString();
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
});
await new Promise((r) => srv.listen(0, r));
const base = `http://127.0.0.1:${srv.address().port}`;
const client = new Client({ name: "paging", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], stderr: "inherit",
  env: { ...process.env, INSYTE_API_KEY: "testkey", INSYTE_API_BASE: base + "/v2", INSYTE_API_VERSION: "auto", INSYTE_MCP_HOME: fs.mkdtempSync(`${process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"}/insyte-paging-`) } }));
const call = async (args) => { const r = await client.callTool({ name: "insyte_query", arguments: args }); return r.isError ? r.content[0].text : JSON.parse(r.content[0].text); };
const ids = (r) => r.rows?.map((x) => x.ID).join(",");
const fails = [];
const check = (label, ok, got) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  got ${JSON.stringify(got)}`}`); if (!ok) fails.push(label); };

let r = await call({ dataset: "job", limit: 5, count: true });
check("limit 5 follows nextLinks, counts, says more", ids(r) === "1,2,3,4,5" && r.totalCount === 7 && r.hasMore === true && r.nextSkip === 5, r);
check("@odata annotations stripped", r.rows && !("@odata.etag" in r.rows[0]), r.rows?.[0]);
r = await call({ dataset: "Jobs", limit: 5, skip: 5 });
check("skip 5 returns the rest, no more", ids(r) === "6,7" && r.hasMore === false && r.nextSkip === undefined, r);
r = await call({ dataset: "Jobs", limit: 7 });
check("limit equal to total: all rows, no more", ids(r) === "1,2,3,4,5,6,7" && r.hasMore === false, r);
r = await call({ dataset: "Jobs", filter: "ID eq 999", limit: 1 });
check("one oversized row: refused with a hint, not returned over the cap", typeof r === "string" && /over the 60000-character limit/.test(r) && /select/.test(r), typeof r === "string" ? r.slice(0, 120) : r.returned);
const rec = await client.callTool({ name: "insyte_get_record", arguments: { dataset: "Jobs", id: 999 } });
check("oversized get_record refused too", rec.isError && /over the 60000-character limit/.test(rec.content[0].text), rec.content[0].text.slice(0, 120));
evil = true;
r = await call({ dataset: "Jobs", limit: 5 });
check("foreign nextLink refused", typeof r === "string" && /Refusing to follow next page link to http:\/\/evil\.example/.test(r), r);
await client.close(); srv.close();
console.log(`\n${fails.length ? `${fails.length} FAILED` : "all checks passed"}`);
process.exit(fails.length ? 1 : 0);
