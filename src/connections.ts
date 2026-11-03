// The Insyte systems one person can reach, each connected on first use, so a long list
// never hits Insyte all at once. Shared by the local stdio server and the hosted one.

import { InsyteClient, InsyteError } from "./insyte.js";

export interface SystemSpec {
  name: string;
  // Host found when the key was added; "auto" when unknown.
  base: string;
  apiKey: string;
  // Where the system came from: "keystore", "environment", or a hosted source.
  source: string;
}

export interface Connection {
  config: SystemSpec;
  client: InsyteClient;
  ready?: Promise<void>;
  error?: string;
  connecting?: boolean;
}

export class Connections {
  readonly names: string[];
  readonly multi: boolean;
  private readonly map: Map<string, Connection>;

  constructor(systems: SystemSpec[], version: string) {
    this.map = new Map(systems.map((s) => [s.name, { config: s, client: new InsyteClient(s.base, s.apiKey, version) }]));
    this.names = [...this.map.keys()];
    this.multi = this.names.length > 1;
  }

  all(): Connection[] {
    return [...this.map.values()];
  }

  async connect(system?: string): Promise<{ name: string; client: InsyteClient }> {
    let conn: Connection | undefined;
    if (system?.trim()) {
      conn = this.map.get(system.trim().toLowerCase());
      if (!conn) throw new InsyteError(`No Insyte system named "${system}". Set up: ${this.names.join(", ")}.`);
    } else if (this.multi) {
      throw new InsyteError(`Several Insyte systems are set up (${this.names.join(", ")}). Pass system to say which one.`);
    } else {
      conn = this.map.get(this.names[0])!;
    }
    await this.warm(conn);
    return { name: conn.config.name, client: conn.client };
  }

  async warm(conn: Connection = this.map.get(this.names[0])!): Promise<void> {
    conn.ready ??= conn.client.init();
    // While init runs, the client may hold a candidate host that has not accepted the key yet.
    conn.connecting = true;
    try {
      await conn.ready;
      conn.error = undefined;
    } catch (err) {
      conn.ready = undefined; // let the next call try again
      conn.error = (err as Error).message;
      throw err;
    } finally {
      conn.connecting = false;
    }
  }
}
