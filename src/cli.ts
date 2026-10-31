// Command-line management of Insyte systems:
//   add <name> [--endpoint URL]   prompt for a key, check it with Insyte, store it
//   list                          show configured systems
//   test [name]                   check each system's key still works
//   remove <name>                 forget a system and delete its key

import { InsyteClient } from "./insyte.js";
import { deleteKey, getKeys, setKey, storeName } from "./keystore.js";
import { checkName, readRegistry, registryPath, writeRegistry } from "./systems.js";

export const COMMANDS = new Set(["add", "list", "test", "remove", "help", "--help", "-h"]);

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "add":
        return await add(rest);
      case "list":
        return list();
      case "test":
        return await test(rest[0]);
      case "remove":
        return await remove(rest[0]);
      default:
        console.log(HELP);
        return 0;
    }
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

const HELP = `Insyte MCP: manage the Insyte systems Claude can read.

  add <name> [--endpoint URL]  Add a system. Prompts for its READ API key, checks it
                               with Insyte, then stores it in the ${storeName()}.
  list                         Show the systems you have added.
  test [name]                  Check that each key (or one) still works.
  remove <name>                Remove a system and delete its key.

Names are what you call the system when you ask Claude, e.g. "acme" or "acme-nz".`;

async function add(args: string[]): Promise<number> {
  const name = checkName(args[0] ?? "");
  const at = args.indexOf("--endpoint");
  const endpoint = at >= 0 ? args[at + 1] : "auto";
  if (at >= 0 && !/^https:\/\/[^\s/]+/i.test(endpoint ?? "")) throw new Error("--endpoint needs an https:// address.");

  const key = await readSecret(`API key for ${name}: `);
  if (!key) throw new Error("No key entered; nothing changed.");

  const client = new InsyteClient(endpoint, key, "auto");
  await client.init();
  if (client.authWarning) throw new Error(`Not added: ${client.authWarning}`);

  await setKey(name, key);
  const systems = readRegistry().filter((s) => s.name !== name);
  systems.push({ name, base: client.base, addedAt: new Date().toISOString() });
  writeRegistry(systems);
  console.log(`Added ${name}: ${new URL(client.base).host}, API ${client.version}, ${client.dataSets().length} data sets. Key stored in the ${storeName()}.`);
  console.log("Start a new chat (or restart Claude Code) so Claude sees it.");
  return 0;
}

function list(): number {
  const systems = readRegistry();
  if (!systems.length) {
    console.log(`No systems added yet. Add one with: add <name>\n(registry: ${registryPath()})`);
    return 0;
  }
  for (const s of systems) console.log(`${s.name.padEnd(24)} ${s.base === "auto" ? "auto" : new URL(s.base).host}`);
  console.log(`\n${systems.length} system${systems.length === 1 ? "" : "s"}. Keys are in the ${storeName()}; names in ${registryPath()}.`);
  return 0;
}

async function test(only?: string): Promise<number> {
  const systems = readRegistry().filter((s) => !only || s.name === checkName(only));
  if (!systems.length) throw new Error(only ? `No system named "${only}".` : "No systems added yet.");
  const keys = await getKeys(systems.map((s) => s.name));
  let failed = 0;
  // One at a time, so a long list never hits Insyte in parallel.
  for (const s of systems) {
    const key = keys.get(s.name);
    if (!key) {
      console.log(`FAIL ${s.name}: key missing from the ${storeName()}`);
      failed++;
      continue;
    }
    const client = new InsyteClient(s.base, key, "auto");
    try {
      await client.init();
      if (client.authWarning) throw new Error(client.authWarning);
      console.log(`OK   ${s.name}: ${new URL(client.base).host}, ${client.dataSets().length} data sets`);
    } catch (err) {
      console.log(`FAIL ${s.name}: ${(err as Error).message}`);
      failed++;
    }
  }
  return failed ? 1 : 0;
}

async function remove(raw?: string): Promise<number> {
  const name = checkName(raw ?? "");
  const systems = readRegistry();
  if (!systems.some((s) => s.name === name)) throw new Error(`No system named "${name}".`);
  await deleteKey(name);
  writeRegistry(systems.filter((s) => s.name !== name));
  console.log(`Removed ${name} and deleted its key. Also delete the key in Insyte if nobody uses it.`);
  return 0;
}

// Reads a line without echoing it. Piped input (no terminal) is read as-is.
function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (d) => (data += d));
      stdin.on("end", () => resolve(data.split(/\r?\n/)[0].trim()));
    });
  }
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          done();
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003") {
          done();
          reject(new Error("Cancelled; nothing changed."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    stdin.on("data", onData);
  });
}
