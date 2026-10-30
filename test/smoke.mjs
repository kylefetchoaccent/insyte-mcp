// Drives the built server over stdio the way Claude does. Needs INSYTE_API_KEY;
// with a dummy key the metadata tools still work and data calls show the auth error.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: process.env, stderr: "inherit" });
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const calls = [
  ["insyte_list_datasets", {}],
  ["insyte_describe_dataset", { dataset: "Jobs" }],
  ["insyte_describe_dataset", { dataset: "Job" }],
  ["insyte_query", { dataset: "Jobs", select: "ID,Status", limit: 3, count: true }],
  ["insyte_query", { dataset: "Jobs", select: "ID,NotAField" }],
  ["insyte_get_record", { dataset: "Jobs", id: "abc" }],
  ["insyte_get_related", { dataset: "Jobs", id: 1, relation: "Nope" }],
  ["insyte_get_related", { dataset: "Jobs", id: 1, relation: "JobLines", select: "ID", limit: 2 }],
];
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.join(", "));
for (const [name, args] of calls) {
  const res = await client.callTool({ name, arguments: args });
  const body = res.content.map((c) => c.text).join("\n");
  console.log(`\n### ${name} ${JSON.stringify(args)}${res.isError ? "  [isError]" : ""}\n${body.length > 1500 ? body.slice(0, 1500) + `\n… (${body.length} chars)` : body}`);
}
await client.close();
