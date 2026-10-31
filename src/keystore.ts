// API keys live in the operating system's credential store, never in a file:
// Windows Credential Manager, the macOS Keychain, or libsecret on Linux.
// Keys always travel over stdin to the helper process, never on a command line,
// where other users' process listings could see them.

import { spawn } from "node:child_process";

const SERVICE = process.env.INSYTE_MCP_KEYSTORE_SERVICE?.trim() || "insyte-mcp";

export class KeystoreError extends Error {}

export async function getKeys(names: string[]): Promise<Map<string, string>> {
  if (!names.length) return new Map();
  if (process.platform === "win32") {
    const out = await windows({ op: "get", names });
    return new Map(Object.entries(JSON.parse(out || "{}") as Record<string, string>));
  }
  const keys = new Map<string, string>();
  for (const name of names) {
    const key = await getOne(name);
    if (key) keys.set(name, key);
  }
  return keys;
}

export async function setKey(name: string, key: string): Promise<void> {
  if (process.platform === "win32") await windows({ op: "set", name, key });
  else if (process.platform === "darwin") {
    // security -i reads commands from stdin; -U replaces an existing entry.
    await exec("security", ["-i"], `add-generic-password -U -s ${SERVICE} -a ${name} -w ${quote(key)}\n`);
  } else {
    await exec("secret-tool", ["store", "--label", `Insyte MCP: ${name}`, "service", SERVICE, "account", name], key);
  }
}

export async function deleteKey(name: string): Promise<void> {
  if (process.platform === "win32") await windows({ op: "delete", name });
  else if (process.platform === "darwin") await exec("security", ["delete-generic-password", "-s", SERVICE, "-a", name]).catch(() => undefined);
  else await exec("secret-tool", ["clear", "service", SERVICE, "account", name]).catch(() => undefined);
}

export function storeName(): string {
  return process.platform === "win32" ? "Windows Credential Manager" : process.platform === "darwin" ? "macOS Keychain" : "libsecret keyring";
}

async function getOne(name: string): Promise<string | undefined> {
  const out =
    process.platform === "darwin"
      ? await exec("security", ["find-generic-password", "-s", SERVICE, "-a", name, "-w"]).catch(() => "")
      : await exec("secret-tool", ["lookup", "service", SERVICE, "account", name]).catch(() => "");
  return out.trim() || undefined;
}

function quote(value: string): string {
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

// Windows Credential Manager has no command-line reader, so a short PowerShell
// script calls the Win32 Cred* functions. Its input arrives as base64 JSON on stdin.
async function windows(request: Record<string, unknown>): Promise<string> {
  const input = Buffer.from(JSON.stringify({ service: SERVICE, ...request }), "utf8").toString("base64");
  return exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], `${WINDOWS_SCRIPT}\n$req = '${input}'\nRun $req\n`);
}

const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class InsyteCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr cred);
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
    } finally { CredFree(p); }
  }
  public static void Write(string target, string user, string secret) {
    byte[] blob = Encoding.Unicode.GetBytes(secret);
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2;
    c.CredentialBlobSize = blob.Length; c.CredentialBlob = Marshal.AllocHGlobal(blob.Length);
    try {
      Marshal.Copy(blob, 0, c.CredentialBlob, blob.Length);
      if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static void Delete(string target) { CredDeleteW(target, 1, 0); }
}
'@
function Run($b64) {
  $r = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) | ConvertFrom-Json
  switch ($r.op) {
    'get' {
      $found = @{}
      foreach ($n in $r.names) { $k = [InsyteCred]::Read("$($r.service):$n"); if ($k) { $found[$n] = $k } }
      [Console]::Out.Write(($found | ConvertTo-Json -Compress))
    }
    'set' { [InsyteCred]::Write("$($r.service):$($r.name)", $r.name, $r.key) }
    'delete' { [InsyteCred]::Delete("$($r.service):$($r.name)") }
  }
}
`;

function exec(command: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new KeystoreError(`Could not run ${command} for the ${storeName()}: ${e.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new KeystoreError(`${command} failed (${code}) using the ${storeName()}: ${err.trim().slice(0, 300)}`)),
    );
    child.stdin.end(stdin ?? "");
  });
}
