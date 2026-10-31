// Region detection and key exposure, against a mocked fetch: no network, no real key.
//   npm run build && node test/region.mjs
import { InsyteClient, KNOWN_HOSTS } from "../dist/insyte.js";

const [AU, US] = KNOWN_HOSTS;
const KEY = "region-test-key";
const METADATA = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices>
<Schema Namespace="T" xmlns="http://docs.oasis-open.org/odata/ns/edm">
<EntityType Name="Job"><Key><PropertyRef Name="ID"/></Key><Property Name="ID" Type="Edm.Int32" Nullable="false"/></EntityType>
<EntityContainer Name="C"><EntitySet Name="Jobs" EntityType="T.Job"/></EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`;

const fails = [];
const check = (label, ok, info = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${info ? `  ${info}` : ""}`);
  if (!ok) fails.push(label);
};

// hosts: { [origin]: "accept" | "reject" | "down" | "error500" | "v3error" }
function mock(hosts) {
  const log = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    const auth = init?.headers?.Authorization;
    log.push({ host: u.origin, path: u.pathname, auth: !!auth });
    const mode = hosts[u.origin];
    if (mode === "down") throw new TypeError("fetch failed");
    if (u.pathname === "/v3/$metadata") return new Response("", { status: mode === "v3error" ? 503 : 404 });
    if (u.pathname === "/v2/$metadata") return new Response(METADATA, { status: 200 });
    if (u.pathname.startsWith("/openapi")) return new Response(JSON.stringify({ paths: {} }), { status: 200 });
    if (auth !== `X-ApiKey ${KEY}`) return new Response("", { status: 401 });
    if (mode === "reject") return new Response("", { status: 401 });
    if (mode === "forbid") return new Response("", { status: 403 });
    if (mode === "nocontent") return new Response(null, { status: 204 });
    if (mode === "error500") return new Response('{"error":{"message":"boom"}}', { status: 500 });
    return new Response(JSON.stringify({ value: [{ ID: 1 }] }), { status: 200 });
  };
  return log;
}

let log = mock({ [AU]: "reject", [US]: "accept" });
let c = new InsyteClient("auto", KEY, "auto");
await c.init();
check("US key: picks the US host", c.base === US && !c.authWarning, c.base);
check("key sent only on authenticated probes", log.filter((r) => r.auth).every((r) => r.path === "/v2/Jobs"), JSON.stringify(log.filter((r) => r.auth).map((r) => r.path)));
check("no key on $metadata or OpenAPI", log.filter((r) => r.path.includes("metadata") || r.path.startsWith("/openapi")).every((r) => !r.auth));
check("rejecting host's OpenAPI never downloaded", !log.some((r) => r.host === AU && r.path.startsWith("/openapi")));

mock({ [AU]: "reject", [US]: "down" });
c = new InsyteClient("auto", KEY, "auto");
let err = await c.init().then(() => undefined, (e) => e);
check("right host down: init fails instead of pinning AU", err && /Could not check the API key/.test(err.message) && c.authWarning === undefined, err?.message);
mock({ [AU]: "reject", [US]: "accept" });
err = await c.init().then(() => undefined, (e) => e);
check("same client recovers on the next init", !err && c.base === US && !c.authWarning, err?.message ?? c.base);

mock({ [AU]: "error500", [US]: "accept" });
c = new InsyteClient("auto", KEY, "auto");
await c.init();
check("AU probe 500 is not acceptance; US still found", c.base === US);

mock({ [AU]: "error500", [US]: "reject" });
c = new InsyteClient("auto", KEY, "auto");
err = await c.init().then(() => undefined, (e) => e);
check("probe 500 plus a rejection: init fails, no false warning", err && /returned 500/.test(err.message) && !/Passing select/.test(err.message), err?.message);

mock({ [AU]: "forbid", [US]: "accept" });
c = new InsyteClient("auto", KEY, "auto");
await c.init();
check("403 counts as a rejection; next host tried", c.base === US && !c.authWarning, c.base);

mock({ [AU]: "nocontent", [US]: "accept" });
c = new InsyteClient("auto", KEY, "auto");
await c.init();
check("any 2xx accepts the key, even an empty 204", c.base === AU && !c.authWarning, c.base);

mock({ [US]: "reject" });
c = new InsyteClient("https://api.myinsyte.com/v2", KEY, "auto");
await c.init();
check("explicit endpoint rejected: warning names the other region", /wrong region \(the other Insyte endpoint is https:\/\/api\.myinsyte\.com\.au\)/.test(c.authWarning ?? ""), c.authWarning);

mock({ [AU]: "reject", [US]: "reject" });
c = new InsyteClient("auto", "wrong-key", "auto");
await c.init();
check("dead key: starts with a warning naming both hosts", /api\.myinsyte\.com\.au and api\.myinsyte\.com rejected/.test(c.authWarning ?? "") && c.base === AU, c.authWarning);

mock({ [AU]: "v3error", [US]: "v3error" });
c = new InsyteClient("auto", KEY, "auto");
err = await c.init().then(() => undefined, (e) => e);
check("v3 probe 503: no silent fallback to v2", err && /503/.test(err.message), err?.message);

mock({ [AU]: "accept", [US]: "accept" });
err = await new InsyteClient("http://evil.example", KEY, "auto").init().then(() => undefined, (e) => e);
check("plain http endpoint refused", err && /not https/.test(err.message), err?.message);
log = mock({ "http://127.0.0.1:9": "accept" });
err = await new InsyteClient("http://127.0.0.1:9/v2", KEY, "auto").init().then(() => undefined, (e) => e);
check("http to localhost allowed for test servers", !err, err?.message);
log = mock({ [US]: "accept" });
c = new InsyteClient("api.myinsyte.com", KEY, "auto");
await c.init();
check("endpoint without scheme gets https", c.base === US, c.base);

console.log(`\n${fails.length ? `${fails.length} FAILED:\n  ${fails.join("\n  ")}` : "all checks passed"}`);
process.exit(fails.length ? 1 : 0);
