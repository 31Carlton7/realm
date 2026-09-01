import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/database";
import { SettingsStore } from "../store/settings";
import { McpServersStore } from "../store/mcp";
import { McpService } from "./service";

const WORK = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SCHOOL = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
/** Never a real key, and never printed: every assertion below is about it NOT being somewhere. */
const KEY = "pat-do-not-leak-me";

let mcp: McpService;
let servers: McpServersStore;
let settings: SettingsStore;
beforeEach(() => {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "realm-mcp-")), "realm.db"));
  servers = new McpServersStore(db);
  settings = new SettingsStore(db);
  mcp = new McpService({ servers, settings });
});

const stdio = (name: string) => ({ name, transport: "stdio" as const, command: "/usr/bin/node", args: ["/abs/s.mjs"], env: { AIRTABLE_API_KEY: KEY } });
const http = (name: string) => ({ name, transport: "http" as const, url: "https://mcp.vercel.com", headers: { Authorization: `Bearer ${KEY}` } });
/** A completed OAuth connection, in the real `oauthJson` shape `McpOauthState` documents — writing the
 *  shape by hand here (rather than importing a builder) keeps these tests honest about what the column
 *  actually holds when `oauthStatus` says `connected`. */
const connectedOauthState = (accessToken: string) => JSON.stringify({ tokens: { access_token: accessToken, token_type: "Bearer" } });

describe("per-space scoping", () => {
  it("enables a new server ONLY in the space it was added from", () => {
    // The deliberate inversion of W1's disabled-set: an MCP server is a process to spawn or a URL to
    // send a key to, so it must not arm itself in a space the user never opened it in.
    const s = mcp.add(stdio("airtable"), WORK);
    expect(s.enabled).toBe(true);
    expect(mcp.list(WORK).servers.map((x) => [x.name, x.enabled])).toEqual([["airtable", true]]);
    expect(mcp.list(SCHOOL).servers.map((x) => [x.name, x.enabled])).toEqual([["airtable", false]]);
  });

  it("enables it nowhere when no space is named", () => {
    mcp.add(stdio("airtable"), null);
    expect(mcp.list(WORK).servers[0]!.enabled).toBe(false);
    expect(mcp.effectiveServerIds(WORK)).toEqual([]);
  });

  it("keeps one space's servers out of another's enabled set — the gateway's own scoping seam", () => {
    // The named mutant: key the enable set on anything but the space id and this leaks.
    const a = mcp.add(stdio("work_only"), WORK);
    const b = mcp.add(stdio("school_only"), SCHOOL);
    expect(mcp.effectiveServerIds(WORK)).toEqual([a.id]);
    expect(mcp.effectiveServerIds(SCHOOL)).toEqual([b.id]);
    mcp.setEnabled(SCHOOL, a.id, true);
    expect(mcp.effectiveServerIds(SCHOOL).sort()).toEqual([a.id, b.id].sort());
  });

  it("stops enabling a server the moment it is disabled", () => {
    // The named mutant: a disabled server still enabled.
    const s = mcp.add(stdio("airtable"), WORK);
    expect(mcp.effectiveServerIds(WORK)).toEqual([s.id]);
    mcp.setEnabled(WORK, s.id, false);
    expect(mcp.effectiveServerIds(WORK)).toEqual([]);
    expect(mcp.list(WORK).servers[0]!.enabled).toBe(false);
  });

  it("forgets every space's opt-in when the server is removed, so a re-add starts off", () => {
    const s = mcp.add(stdio("airtable"), WORK);
    mcp.setEnabled(SCHOOL, s.id, true);
    mcp.remove(s.id, [WORK, SCHOOL]);
    expect(mcp.list(WORK).servers).toEqual([]);
    // Same id would be impossible, but the stale entry must not linger to poison an unrelated one.
    expect(mcp.isEnabled(WORK, s.id)).toBe(false);
    expect(mcp.isEnabled(SCHOOL, s.id)).toBe(false);
  });
});

describe("secrets", () => {
  it("never returns a secret value from list()", () => {
    // The named mutant: put `env` on McpServerSchema (or stop projecting) and this fails.
    mcp.add(stdio("airtable"), WORK);
    mcp.add(http("vercel"), WORK);
    const listed = mcp.list(WORK);
    expect(JSON.stringify(listed)).not.toContain(KEY);
    expect(listed.servers.map((s) => [s.envKeys, s.headerKeys])).toEqual([[["AIRTABLE_API_KEY"], []], [[], ["Authorization"]]]);
  });

  it("never returns an oauth token from list() either", () => {
    // Same guarantee as secrets, for the other channel a credential can travel in: `oauthJson` on the
    // row never becomes a field on the wire, only the derived `oauthStatus`.
    const TOKEN = "oauth-token-do-not-leak-me";
    const s = mcp.add(http("linear"), WORK);
    servers.setOauth(s.id, connectedOauthState(TOKEN));
    const listed = mcp.list(WORK);
    expect(JSON.stringify(listed)).not.toContain(TOKEN);
    expect(listed.servers[0]).toMatchObject({ authKind: "oauth", oauthStatus: "connected" });
  });

  it("never returns one from add() or update() either", () => {
    const s = mcp.add(stdio("airtable"), WORK);
    expect(JSON.stringify(s)).not.toContain(KEY);
    expect(JSON.stringify(mcp.update(s.id, { name: "renamed" }, WORK))).not.toContain(KEY);
  });

  // W3: the passthrough is gone, and with it the one exit `McpService` used to have for a secret value
  // (`configFor`). `hub.ts` is now the only code that ever reads `McpServerRow.secrets` — so these
  // assertions read the STORE directly (the same thing `hub.ts` does), not `McpService`, which after W3
  // has no path to a secret value at all.
  it("keeps a stored key when an edit omits env, because a client was never given it to send back", () => {
    const s = mcp.add(stdio("airtable"), WORK);
    mcp.update(s.id, { name: "airtable2", args: ["/abs/other.mjs"] }, WORK);
    expect(servers.get(s.id)).toMatchObject({ name: "airtable2", args: ["/abs/other.mjs"], secrets: { AIRTABLE_API_KEY: KEY } });
  });

  it("replaces the whole map when env IS passed, which is how a key is removed", () => {
    const s = mcp.add(stdio("airtable"), WORK);
    mcp.update(s.id, { env: {} }, WORK);
    expect(servers.get(s.id)!.secrets).toEqual({});
    expect(mcp.list(WORK).servers[0]!.envKeys).toEqual([]);
  });
});

describe("definitions", () => {
  it("carries nothing across a transport switch", () => {
    const s = mcp.add(stdio("airtable"), WORK);
    const after = mcp.update(s.id, { transport: "http", url: "https://mcp.vercel.com" }, WORK);
    expect(after).toMatchObject({ transport: "http", command: "", args: [], url: "https://mcp.vercel.com" });
    // The old env keys would be meaningless as headers, and keeping them would silently ship an API key
    // to a host in a header nobody chose.
    expect(after.headerKeys).toEqual([]);
    expect(JSON.stringify(servers.get(s.id))).not.toContain(KEY);
  });

  it("refuses a definition that cannot connect to anything", () => {
    expect(() => mcp.add({ name: "empty", transport: "stdio" }, WORK)).toThrow(/needs a command/);
    expect(() => mcp.add({ name: "empty", transport: "http" }, WORK)).toThrow(/needs a url/);
    expect(() => mcp.add({ name: "empty", transport: "sse" }, WORK)).toThrow(/needs a url/);
    expect(mcp.list(WORK).servers).toEqual([]);
  });

  it("refuses to strand an existing server by editing its endpoint away", () => {
    const s = mcp.add(stdio("airtable"), WORK);
    expect(() => mcp.update(s.id, { command: "" }, WORK)).toThrow(/needs a command/);
    expect(servers.get(s.id)).toMatchObject({ command: "/usr/bin/node" });
  });

  it("refuses a duplicate name, because a name is the key every agent addresses it by", () => {
    mcp.add(stdio("airtable"), WORK);
    expect(() => mcp.add(stdio("airtable"), WORK)).toThrow(/already exists/);
    const other = mcp.add(stdio("other"), WORK);
    expect(() => mcp.update(other.id, { name: "airtable" }, WORK)).toThrow(/already exists/);
    // Renaming to its own name is not a clash.
    expect(mcp.update(other.id, { name: "other" }, WORK).name).toBe("other");
  });

  it("reports an unknown id rather than creating one", () => {
    expect(() => mcp.update("01ARZ3NDEKTSV4RRFFQ69G5FAZ", { name: "x" })).toThrow(/not found/);
  });
});

describe("gateway fields (Plan 9 W1 — schema and derivation only)", () => {
  it("derives authKind: none, then secrets once a key is set, oauth once a connection exists", () => {
    const bare = mcp.add({ name: "bare", transport: "http", url: "https://mcp.example.com" }, WORK);
    expect(bare.authKind).toBe("none");
    const withKey = mcp.add(http("airtable-with-key"), WORK);
    expect(withKey.authKind).toBe("secrets");
    servers.setOauth(bare.id, JSON.stringify({ accessToken: "t" }));
    expect(mcp.list(WORK).servers.find((s) => s.id === bare.id)!.authKind).toBe("oauth");
  });

  it("oauth beats secrets: a row with both a header key and a completed OAuth connection reports oauth", () => {
    const s = mcp.add(http("mixed"), WORK); // has a header key via the `http()` helper
    expect(s.authKind).toBe("secrets");
    servers.setOauth(s.id, JSON.stringify({ accessToken: "t" }));
    expect(mcp.list(WORK).servers[0]!.authKind).toBe("oauth");
  });

  it("oauthStatus is unconfigured until tokens are stored, then connected", () => {
    // The three-state derivation itself (including `reconnect_needed`, corruption, and a half-finished
    // flow) is `oauth.test.ts`'s `oauthStatusOf` block; this only pins that `list()` carries it through.
    const s = mcp.add(stdio("airtable"), WORK);
    expect(mcp.list(WORK).servers[0]).toMatchObject({ oauthStatus: "unconfigured" });
    servers.setOauth(s.id, connectedOauthState("t"));
    expect(mcp.list(WORK).servers[0]).toMatchObject({ oauthStatus: "connected" });
  });

  it("carries the row's cached tools through to the wire", () => {
    const s = mcp.add(stdio("airtable"), WORK);
    servers.setTools(s.id, [{ name: "search", description: "Search records" }]);
    expect(mcp.list(WORK).servers[0]!.tools).toEqual([{ name: "search", description: "Search records" }]);
  });

  it("allowedTools reads back what allowedTools() stores, and is null for a server nobody has narrowed", () => {
    const s = mcp.add(stdio("airtable"), WORK);
    expect(mcp.list(WORK).servers[0]!.allowedTools).toBeNull();
    expect(mcp.allowedTools(WORK, s.id)).toBeNull();
  });

  it("allowedTools is per-space: narrowing in one space does not leak into another's listing", () => {
    const s = mcp.add(stdio("airtable"), WORK);
    settings.set(`mcp.allowedTools:${WORK}:${s.id}`, ["search"]);
    expect(mcp.allowedTools(WORK, s.id)).toEqual(["search"]);
    expect(mcp.allowedTools(SCHOOL, s.id)).toBeNull();
  });
});

describe("status injection (Plan 9 W3)", () => {
  it("defaults every server to idle when no statusOf is wired — the pre-hub behavior", () => {
    mcp.add(stdio("airtable"), WORK);
    expect(mcp.list(WORK).servers[0]!.status).toBe("idle");
  });

  it("reports whatever the injected statusOf() says, per server id", () => {
    const a = mcp.add(stdio("airtable"), WORK);
    const b = mcp.add(stdio("vercel"), WORK);
    const withHub = new McpService({ servers, settings, statusOf: (id) => (id === a.id ? "connected" : "circuit_open") });
    const statuses = new Map(withHub.list(WORK).servers.map((s) => [s.id, s.status]));
    expect(statuses.get(a.id)).toBe("connected");
    expect(statuses.get(b.id)).toBe("circuit_open");
  });

  it("also flows through add() and update(), not just list()", () => {
    const withHub = new McpService({ servers, settings, statusOf: () => "circuit_open" });
    const added = withHub.add(stdio("airtable"), WORK);
    expect(added.status).toBe("circuit_open");
    expect(withHub.update(added.id, { name: "renamed" }, WORK).status).toBe("circuit_open");
  });
});

describe("setAllowedTools / effectiveServerIds (Plan 9 W3 — the gateway's own reads/writes)", () => {
  it("setAllowedTools writes what allowedTools reads back, scoped to the space it was set for", () => {
    const s = mcp.add(stdio("airtable"), WORK);
    mcp.setAllowedTools(WORK, s.id, ["search", "create"]);
    expect(mcp.allowedTools(WORK, s.id)).toEqual(["search", "create"]);
    expect(mcp.allowedTools(SCHOOL, s.id)).toBeNull(); // untouched
  });

  it("setAllowedTools(null) restores 'every tool allowed', same as a server nobody has narrowed", () => {
    const s = mcp.add(stdio("airtable"), WORK);
    mcp.setAllowedTools(WORK, s.id, ["search"]);
    expect(mcp.allowedTools(WORK, s.id)).toEqual(["search"]);
    mcp.setAllowedTools(WORK, s.id, null);
    expect(mcp.allowedTools(WORK, s.id)).toBeNull();
  });

  it("effectiveServerIds returns exactly this space's enabled ids, empty for a space that enabled nothing", () => {
    const a = mcp.add(stdio("airtable"), WORK);
    mcp.add(stdio("school_only"), SCHOOL);
    expect(mcp.effectiveServerIds(WORK)).toEqual([a.id]);
    expect(mcp.effectiveServerIds("01ARZ3NDEKTSV4RRFFQ69G5FAX")).toEqual([]);
  });
});
