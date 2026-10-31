// The Insyte systems this install can reach. Names and hosts live in a small JSON
// registry; keys live in the OS credential store (keystore.ts). A key passed in
// INSYTE_API_KEY (the Claude Desktop extension's setting) adds one more system.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getKeys } from "./keystore.js";

export interface SystemEntry {
  name: string;
  // Host found when the key was added; "auto" when unknown.
  base: string;
  addedAt?: string;
}

export interface SystemConfig extends SystemEntry {
  apiKey: string;
  source: "keystore" | "environment";
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function checkName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!NAME.test(name)) {
    throw new Error(`"${raw}" is not a usable system name. Use 1-40 letters, digits, - or _, starting with a letter or digit.`);
  }
  return name;
}

export function registryPath(): string {
  const home = process.env.INSYTE_MCP_HOME?.trim() || path.join(os.homedir(), ".insyte-mcp");
  return path.join(home, "systems.json");
}

export function readRegistry(): SystemEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(), "utf8")) as { systems?: SystemEntry[] };
    return (parsed.systems ?? []).filter((s) => NAME.test(s.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Could not read ${registryPath()}: ${(err as Error).message}`);
  }
}

export function writeRegistry(systems: SystemEntry[]): void {
  const file = registryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sorted = [...systems].sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(file, `${JSON.stringify({ note: "Names and hosts only. Keys are in the OS credential store.", systems: sorted }, null, 2)}\n`);
}

export async function loadSystems(env: NodeJS.ProcessEnv): Promise<{ systems: SystemConfig[]; warnings: string[] }> {
  const warnings: string[] = [];
  const systems: SystemConfig[] = [];
  const envKey = env.INSYTE_API_KEY?.trim();
  if (envKey) {
    systems.push({
      name: checkName(env.INSYTE_SYSTEM_NAME?.trim() || "main"),
      base: env.INSYTE_API_BASE?.trim() || "auto",
      apiKey: envKey,
      source: "environment",
    });
  }
  const registered = readRegistry();
  const keys = await getKeys(registered.map((s) => s.name));
  for (const entry of registered) {
    if (systems.some((s) => s.name === entry.name)) {
      warnings.push(`"${entry.name}" is set both in the extension settings and with the add command; using the extension's key.`);
      continue;
    }
    const apiKey = keys.get(entry.name);
    if (!apiKey) {
      warnings.push(`"${entry.name}" is registered but its key is missing from the credential store. Run the add command for it again.`);
      continue;
    }
    systems.push({ ...entry, apiKey, source: "keystore" });
  }
  return { systems, warnings };
}
