// Local mock of the Insyte OData host to exercise paging, nextLink handling and counts.
import http from "node:http";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const metadata = fs.readFileSync(process.argv[2], "utf8");
const ALL = Array.from({ length: 7 }, (_, i) => ({ ID: i + 1, Status: "open", "@odata.etag": "x" }));
let evil = false;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.headers.authorization !== "X-ApiKey testkey") { res.writeHead(401).end(); return; }
  if (u.pathname === "/v2/$metadata") { res.writeHead(200, { "content-type": "application/xml" }).end(metadata); return; }
  if (u.pathname === "/v2/Jobs") {
    const top = +u.searchParams.get("$top"), skip = +(u.searchParams.get("$skip") ?? 0);
    const pageSize = 2, take = Math.min(top, pageSize);
    const value = ALL.slice(skip, skip + take);
    const body = { value };
    if (u.searchParams.get("$count")) body["@odata.count"] = ALL.length;
    if (skip + take < Math.min(ALL.length, skip + top) || (top > take && skip + take < ALL.length)) {
      const next = new URL(req.url, `http://${req.headers.host}`);
      next.searchParams.set("$skip", String(skip + take)); next.searchParams.set("$top", String(top - take));
      next.searchParams.delete("$count");
      body["@odata.nextLink"] = evil ? "http://evil.example/v2/Jobs" : next.toString();
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body)); return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => srv.listen(0, r));
const base = `http://127.0.0.1:${srv.address().port}`;
const client = new Client({ name: "paging", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], stderr: "inherit",
  env: { ...process.env, INSYTE_API_KEY: "testkey", INSYTE_API_BASE: base + "/v2", INSYTE_API_VERSION: "auto" } }));
const call = async (args) => { const r = await client.callTool({ name: "insyte_query", arguments: args }); return r.isError ? r.content[0].text : JSON.parse(r.content[0].text); };
const brief = (r) => typeof r === "string" ? r : { ...r, rows: r.rows.map((x) => x.ID) };
console.log("limit 5:", brief(await call({ dataset: "job", limit: 5, count: true })));
console.log("limit 5 skip 5:", brief(await call({ dataset: "Jobs", limit: 5, skip: 5 })));
console.log("limit 7:", brief(await call({ dataset: "Jobs", limit: 7 })));
evil = true;
console.log("foreign nextLink:", brief(await call({ dataset: "Jobs", limit: 5 })));
await client.close(); srv.close();
