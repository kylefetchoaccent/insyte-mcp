// Builds release/insyte-<version>.mcpb. Plain Node, so it runs the same under cmd.exe,
// PowerShell and POSIX shells (npm scripts use cmd.exe on Windows).
import { execSync } from "node:child_process";
import fs from "node:fs";

const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
execSync("npm run bundle", { stdio: "inherit" });
fs.copyFileSync("mcpb/manifest.json", "build/mcpb/manifest.json");
fs.mkdirSync("release", { recursive: true });
execSync(`npx -y @anthropic-ai/mcpb@2.1.2 pack build/mcpb release/insyte-${version}.mcpb`, { stdio: "inherit" });
