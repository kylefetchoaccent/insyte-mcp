// Runs every test that needs no Insyte key: region detection, paging against the saved US
// schema, and each test/*.offline.mjs. Run after `npm run build`. Exits 1 if any file fails.
//   node test/offline.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const runs = [
  ["test/region.mjs"],
  ["test/paging.mjs", "test/fixtures/us-v2-metadata.xml"],
  ...fs.readdirSync("test").filter((f) => f.endsWith(".offline.mjs")).sort().map((f) => [`test/${f}`]),
];
const failed = [];
for (const args of runs) {
  console.log(`\n== node ${args.join(" ")}`);
  const r = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (r.status !== 0) failed.push(`${args[0]} (exit ${r.status})`);
}
console.log(`\n${runs.length - failed.length}/${runs.length} offline test files passed${failed.length ? `. Failed: ${failed.join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
