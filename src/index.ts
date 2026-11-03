#!/usr/bin/env node
// Insyte MCP server: read-only access to one or more Insyte Web tenants for Claude, over stdio.
//
// Systems come from two places (see systems.ts):
//   - the add command: `node index.mjs add <name>` stores a key in the OS credential store
//   - INSYTE_API_KEY, the Claude Desktop extension's setting, named by INSYTE_SYSTEM_NAME (default "main")
//
// Environment:
//   INSYTE_API_KEY      optional. A READ-scope key from Settings > Integration > Api Integration.
//   INSYTE_SYSTEM_NAME  optional. The name for that key's system (default main).
//   INSYTE_API_BASE     optional. The API Endpoint for that key, or auto (default: try each
//                       Insyte region and use the one that accepts the key).
//   INSYTE_API_VERSION  optional. v2, v3 or auto (default auto: v3 when the host offers it).
//   INSYTE_MCP_HOME     optional. Folder for the systems registry (default ~/.insyte-mcp).
//   INSYTE_MCP_PROFILE  optional. public (default) or support, which adds Accent-staff tools.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { COMMANDS, runCli } from "./cli.js";
import { Connections } from "./connections.js";
import { Profile, createServer } from "./server.js";
import { loadSystems } from "./systems.js";

if (COMMANDS.has(process.argv[2] ?? "")) process.exit(await runCli(process.argv.slice(2)));

let loaded: Awaited<ReturnType<typeof loadSystems>>;
try {
  loaded = await loadSystems(process.env);
} catch (err) {
  console.error(`Insyte MCP could not start: ${(err as Error).message}`);
  process.exit(1);
}
if (!loaded.systems.length) {
  console.error(
    "No Insyte system is set up. Set INSYTE_API_KEY, or run this file with: add <name>. " +
      "Create a READ key under Settings > Integration > Api Integration in Insyte.",
  );
  process.exit(1);
}
for (const w of loaded.warnings) console.error(`Insyte MCP warning: ${w}`);

const profileSetting = (process.env.INSYTE_MCP_PROFILE?.trim() || "public").toLowerCase();
if (profileSetting !== "public" && profileSetting !== "support") {
  console.error(`Insyte MCP could not start: INSYTE_MCP_PROFILE must be public or support, not "${profileSetting}".`);
  process.exit(1);
}

const version = (process.env.INSYTE_API_VERSION?.trim() || "auto").toLowerCase();
const conns = new Connections(loaded.systems, version);
const server = createServer(conns, { profile: profileSetting as Profile, warnings: loaded.warnings });

await server.connect(new StdioServerTransport());
console.error(`Insyte MCP ready: ${conns.names.length} system${conns.multi ? "s" : ""} (${conns.names.join(", ")})`);
// Warm up the first system so the first question is quick; failures surface on use.
conns.warm().catch(() => undefined);
