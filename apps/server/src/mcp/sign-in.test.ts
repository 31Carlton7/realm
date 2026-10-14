import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isSealed, newSecretKey } from "@realm/contracts/src/secret-box";
import { openDatabase, type Db } from "../db/database";
import { McpServersStore, type McpServerRow } from "../store/mcp";
import { RpcError } from "../store/rows";
import { McpHub } from "./hub";
import { McpOauth, oauthSecretBox, readOauthState } from "./oauth";
import { McpService, oauthStatusOf } from "./service";
import { SettingsStore } from "../store/settings";
import { ghCandidates, readGhToken, type GhToken } from "./gh-cli";
import { DeviceFlowError, pollDeviceToken, type DeviceCode } from "./device-flow";
import { KNOWN_PROVIDERS, providerFor, type KnownProvider } from "./providers";
import { makeStubAuthServer, type StubAuthServer } from "./fixtures/stub-auth-server";
import { makeStubServer } from "./fixtures/stub-server";

const GH_TOKEN = "gho_cli_token_1234567890abcdef";
const GH_TOKEN_2 = "gho_cli_token_rotated_0987654321";

async function rejection(fn: () => Promise<unknown>): Promise<RpcError> {
  try { await fn(); } catch (e) { if (e instanceof RpcError) return e; throw e; }
  throw new Error("expected a rejection");
}

describe("providerFor — which servers are GitHub", () => {
  it("matches GitHub's MCP server by its host, whatever the row is called", () => {
    expect(providerFor("https://api.githubcopilot.com/mcp/")?.id).toBe("github");
    // The mutant: matching on the name the user typed. A row called realm-github elsewhere is not GitHub.
    expect(providerFor("https://mcp.example.com/realm-github")).toBeNull();
  });

  it("matches a server on another host by the authorization server discovery found", () => {
    expect(providerFor("https://mcp.example.com/mcp", "https://github.com/login/oauth")?.id).toBe("github");
    expect(providerFor("https://mcp.example.com/mcp", "https://auth.example.com/")).toBeNull();
  });

  it("ships with no device-flow client id, so that route stays hidden until one is registered", () => {
    expect(KNOWN_PROVIDERS.find((p) => p.id === "github")?.device?.clientId).toBe(process.env.REALM_GITHUB_CLIENT_ID ?? "");
  });
});

describe("readGhToken — the GitHub CLI's existing sign-in", () => {
  it("is missing when no gh binary exists in any candidate location", async () => {
    let ran = false;
    const got = await readGhToken({ candidates: ["/nope/gh", "/also/nope/gh"], exists: () => false, run: async () => { ran = true; return GH_TOKEN; } });
    expect(got).toEqual({ ok: false, reason: "missing" });
    expect(ran).toBe(false);
  });

  it("runs the first gh that exists, asking for github.com's token", async () => {
    const calls: [string, string[]][] = [];
    const got = await readGhToken({
      candidates: ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"],
      exists: (p) => p === "/usr/local/bin/gh",
      run: async (bin, args) => { calls.push([bin, args]); return `${GH_TOKEN}\n`; },
    });
    expect(got).toEqual({ ok: true, token: GH_TOKEN });
    expect(calls).toEqual([["/usr/local/bin/gh", ["auth", "token", "--hostname", "github.com"]]]);
  });

  it("asks a gh on PATH before the usual install locations, which still follow for a Dock launch", () => {
    if (process.platform === "win32") return;
    const list = ghCandidates({ PATH: "/custom/bin:/usr/bin" });
    expect(list[0]).toBe("/custom/bin/gh");
    expect(list).toContain("/opt/homebrew/bin/gh");
    expect(ghCandidates({ PATH: "/usr/bin:/bin" })).toContain("/opt/homebrew/bin/gh");
  });

  it("is signed out when gh exits non-zero, or prints nothing", async () => {
    const fails = await readGhToken({ candidates: ["/gh"], exists: () => true, run: async () => { throw new Error("no oauth token found for github.com"); } });
    expect(fails).toEqual({ ok: false, reason: "signed-out" });
    const empty = await readGhToken({ candidates: ["/gh"], exists: () => true, run: async () => "  \n" });
    expect(empty).toEqual({ ok: false, reason: "signed-out" });
  });
});

/** A fetch that answers each device-flow POST from a script, recording the bodies it was sent. */
function scriptedFetch(answers: Record<string, unknown>[]): FetchLike & { bodies: string[] } {
  const bodies: string[] = [];
  const f = (async (_url: string | URL, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    const next = answers.shift();
    if (!next) throw new Error("fetch called more often than scripted");
    return new Response(JSON.stringify(next), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as FetchLike & { bodies: string[] };
  f.bodies = bodies;
  return f;
}

const EP = { codeUrl: "https://gh.test/login/device/code", tokenUrl: "https://gh.test/login/oauth/access_token", clientId: "Iv1.test", scope: "repo read:org" };
const CODE: DeviceCode = { deviceCode: "dev-123", userCode: "ABCD-1234", verificationUri: "https://gh.test/login/device", expiresIn: 900, interval: 5 };

describe("pollDeviceToken — the device flow's polling states", () => {
  it("waits through authorization_pending at the interval, then returns the token", async () => {
    const sleeps: number[] = [];
    const fetchFn = scriptedFetch([{ error: "authorization_pending" }, { error: "authorization_pending" }, { access_token: "gho_device", token_type: "bearer", scope: "repo" }]);
    const got = await pollDeviceToken(EP, CODE, { fetchFn, sleep: async (ms) => { sleeps.push(ms); } });
    expect(got.accessToken).toBe("gho_device");
    expect(sleeps).toEqual([5000, 5000, 5000]);
    expect(fetchFn.bodies[0]).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
    expect(fetchFn.bodies[0]).toContain("device_code=dev-123");
  });

  it("slow_down adds five seconds for good, or takes the interval the server sent", async () => {
    const sleeps: number[] = [];
    const fetchFn = scriptedFetch([{ error: "slow_down" }, { error: "authorization_pending" }, { error: "slow_down", interval: 20 }, { access_token: "gho_device" }]);
    await pollDeviceToken(EP, CODE, { fetchFn, sleep: async (ms) => { sleeps.push(ms); } });
    expect(sleeps).toEqual([5000, 10000, 10000, 20000]);
  });

  it("expired_token and access_denied end the wait with what happened", async () => {
    const expired = await pollDeviceToken(EP, CODE, { fetchFn: scriptedFetch([{ error: "expired_token" }]), sleep: async () => {} }).catch((e) => e);
    expect(expired).toBeInstanceOf(DeviceFlowError);
    expect(expired.reason).toBe("expired");
    const denied = await pollDeviceToken(EP, CODE, { fetchFn: scriptedFetch([{ error: "access_denied" }]), sleep: async () => {} }).catch((e) => e);
    expect(denied.reason).toBe("denied");
  });

  it("stops at the code's own expiry even if the server keeps saying pending", async () => {
    let t = 0;
    const fetchFn = scriptedFetch(Array.from({ length: 10 }, () => ({ error: "authorization_pending" })));
    const err = await pollDeviceToken(EP, { ...CODE, expiresIn: 12 }, { fetchFn, now: () => t, sleep: async (ms) => { t += ms; } }).catch((e) => e);
    expect(err.reason).toBe("expired");
    expect(fetchFn.bodies).toHaveLength(2); // at 5s and 10s; 15s is past the 12s code
  });
});

type Harness = { db: Db; servers: McpServersStore; as: StubAuthServer; row: McpServerRow; oauth: McpOauth; statusEvents: string[]; ghCalls: () => number; reload(): McpServerRow };

const open: { db: Db; as: StubAuthServer }[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) { await h.as.close(); h.db.close(); }
  oauthSecretBox.setKey(null);
});

/** A stub authorization server with no registration endpoint (GitHub's shape), and a provider table
 *  that calls its loopback host GitHub, so nothing here reaches the real api.githubcopilot.com. */
async function setup(opts: { gh?: () => GhToken; provider?: Partial<KnownProvider> | null; fetchFn?: FetchLike } = {}): Promise<Harness> {
  const as = await makeStubAuthServer({ dynamicRegistration: false });
  const db = openDatabase(join(tempDir("realm-mcp-signin-"), "realm.db"));
  open.push({ db, as });
  const servers = new McpServersStore(db);
  const row = servers.create({ name: "realm-github", transport: "http", command: "", args: [], url: `${as.url}/mcp`, secrets: {} });
  const github = KNOWN_PROVIDERS.find((p) => p.id === "github")!;
  const providers = opts.provider === null ? [] : [{ ...github, hosts: ["127.0.0.1"], ...opts.provider }];
  const statusEvents: string[] = [];
  let ghCalls = 0;
  const gh = opts.gh ?? (() => ({ ok: true, token: GH_TOKEN }) as GhToken);
  const oauth = new McpOauth({
    servers, gatewayPort: () => 45678, onStatus: (id) => statusEvents.push(id), providers, fetchFn: opts.fetchFn,
    ghToken: async () => { ghCalls += 1; return gh(); }, sleep: async () => {},
  });
  return { db, servers, as, row, oauth, statusEvents, ghCalls: () => ghCalls, reload: () => servers.get(row.id)! };
}

describe("Connect on a GitHub server — the CLI first", () => {
  it("connects with gh's token and no browser: authUrl is null, the token is the bearer", async () => {
    const h = await setup();
    const { authUrl } = await h.oauth.start(h.row.id);
    expect(authUrl).toBeNull();
    expect(oauthStatusOf(h.reload())).toBe("connected");
    expect(readOauthState(h.reload().oauthJson).via).toBe("cli");
    expect(await h.oauth.headers(h.reload())).toEqual({ Authorization: `Bearer ${GH_TOKEN}` });
    expect(h.statusEvents).toEqual([h.row.id]);
  });

  it("with gh missing, refuses with a sentence naming the CLI, a token and an app of your own", async () => {
    const h = await setup({ gh: () => ({ ok: false, reason: "missing" }) });
    const err = await rejection(() => h.oauth.start(h.row.id));
    expect(err.code).toBe("MCP_OAUTH_NO_REGISTRATION");
    expect(err.message).toContain("Sign in with the GitHub CLI");
    expect(err.message).toContain("personal access token");
    expect(err.message).toContain("not installed");
    expect(oauthStatusOf(h.reload())).toBe("unconfigured");
  });

  it("with gh signed out, says to run gh auth login", async () => {
    const h = await setup({ gh: () => ({ ok: false, reason: "signed-out" }) });
    const err = await rejection(() => h.oauth.start(h.row.id));
    expect(err.message).toContain("gh auth login");
    expect(h.ghCalls()).toBe(1);
  });

  it("refuses a known provider without a discovery round-trip — the table already says it has no registration", async () => {
    let fetched = 0;
    const counting = ((url: string | URL, init?: RequestInit) => { fetched += 1; return fetch(url, init); }) as FetchLike;
    const h = await setup({ gh: () => ({ ok: false, reason: "signed-out" }), fetchFn: counting });
    await rejection(() => h.oauth.start(h.row.id));
    expect(fetched).toBe(0);
  });

  it("a server on another host whose authorization server is GitHub's still gets the CLI", async () => {
    // The stub's own loopback host is not in this table; its AS is matched by `authHosts` instead.
    const h = await setup({ provider: { hosts: [], authHosts: ["127.0.0.1"] } });
    expect((await h.oauth.start(h.row.id)).authUrl).toBeNull();
    expect(readOauthState(h.reload().oauthJson).via).toBe("cli");
  });

  it("a server Realm does not know is offered a token or an app, never the CLI", async () => {
    const h = await setup({ provider: null });
    const err = await rejection(() => h.oauth.start(h.row.id));
    expect(err.code).toBe("MCP_OAUTH_NO_REGISTRATION");
    expect(err.message).not.toContain("CLI");
    expect(h.ghCalls()).toBe(0);
    expect(await h.oauth.options(h.row.id)).toEqual({ provider: null, cli: null, device: false, token: null });
  });

  it("a client the user registered goes to the browser; gh is not consulted", async () => {
    const h = await setup();
    h.oauth.setClient(h.row.id, { clientId: "app-1", relay: false });
    const { authUrl } = await h.oauth.start(h.row.id);
    expect(authUrl).toContain("client_id=app-1");
    expect(h.ghCalls()).toBe(0);
  });
});

describe("the sign-in sheet's routes", () => {
  it("options reports the CLI's state, and the device flow only once a client id is set", async () => {
    const h = await setup({ gh: () => ({ ok: false, reason: "signed-out" }) });
    const o = await h.oauth.options(h.row.id);
    expect(o).toMatchObject({ provider: "GitHub", cli: { name: "GitHub CLI", state: "signed-out" }, device: false });
    expect(o.token?.url).toContain("github.com/settings/tokens");
    const withApp = await setup({ provider: { device: { ...EP } } });
    expect((await withApp.oauth.options(withApp.row.id)).device).toBe(true);
  });

  it("useCli fails with what to do when gh is signed out, and connects once it is not", async () => {
    let signedIn = false;
    const h = await setup({ gh: () => (signedIn ? { ok: true, token: GH_TOKEN } : { ok: false, reason: "signed-out" }) });
    const err = await rejection(() => h.oauth.useCli(h.row.id));
    expect(err.code).toBe("MCP_OAUTH_CLI");
    expect(err.message).toContain("gh auth login");
    signedIn = true;
    await h.oauth.useCli(h.row.id);
    expect(oauthStatusOf(h.reload())).toBe("connected");
  });

  it("a pasted token is the bearer, sealed at rest, and never in the listed server", async () => {
    oauthSecretBox.setKey(newSecretKey().toString("base64"));
    const h = await setup();
    const pat = "github_pat_11ABCDEFG_pasted_secret_value";
    h.oauth.setToken(h.row.id, `  ${pat}\n`);
    const stored = h.reload().oauthJson;
    expect(isSealed(stored)).toBe(true);
    expect(stored).not.toContain(pat);
    expect(await h.oauth.headers(h.reload())).toEqual({ Authorization: `Bearer ${pat}` });
    const service = new McpService({ servers: h.servers, settings: new SettingsStore(h.db) });
    const listed = service.list("any").servers.find((s) => s.id === h.row.id)!;
    expect(listed).toMatchObject({ authKind: "oauth", oauthStatus: "connected", oauthVia: "token" });
    expect(JSON.stringify(listed)).not.toContain(pat);
  });

  it("the device flow shows a code, polls, and connects", async () => {
    const fetchFn = scriptedFetch([
      { device_code: "dev-1", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 },
      { error: "authorization_pending" },
      { access_token: "gho_from_device", token_type: "bearer" },
    ]);
    const h = await setup({ provider: { device: { ...EP } }, fetchFn });
    const code = await h.oauth.startDevice(h.row.id);
    expect(code).toEqual({ userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresIn: 900 });
    await h.oauth.waitDevice(h.row.id);
    expect(readOauthState(h.reload().oauthJson)).toMatchObject({ via: "device", tokens: { access_token: "gho_from_device" } });
    expect(fetchFn.bodies[0]).toContain("client_id=Iv1.test");
  });

  it("a declined device sign-in rejects the wait with its own code and stores nothing", async () => {
    const fetchFn = scriptedFetch([
      { device_code: "dev-1", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 },
      { error: "access_denied" },
    ]);
    const h = await setup({ provider: { device: { ...EP } }, fetchFn });
    await h.oauth.startDevice(h.row.id);
    const err = await rejection(() => h.oauth.waitDevice(h.row.id));
    expect(err.code).toBe("MCP_OAUTH_DENIED");
    expect(oauthStatusOf(h.reload())).toBe("unconfigured");
  });

  it("refuses a device sign-in while Realm has no client id for it", async () => {
    const h = await setup();
    const err = await rejection(() => h.oauth.startDevice(h.row.id));
    expect(err.code).toBe("MCP_OAUTH_UNSUPPORTED");
  });
});

describe("401 → read the CLI again", () => {
  /** The app.ts wiring in miniature, with a transport that answers 401 to any bearer but `valid`. */
  function wire(h: Harness, valid: () => string) {
    const stub = makeStubServer();
    const captured: (string | undefined)[] = [];
    const hub = new McpHub({
      servers: h.servers,
      onStatus: () => {},
      authHeaders: (row) => h.oauth.headers(row),
      reauthorize: (row) => h.oauth.reauthorize(row),
      makeTransport: async (_row, headers): Promise<Transport> => {
        captured.push(headers.Authorization);
        if (headers.Authorization === `Bearer ${valid()}`) return stub.connectInMemory();
        return {
          start: async () => { throw Object.assign(new Error(`Error POSTing to endpoint: bad credentials for ${headers.Authorization}`), { code: 401 }); },
          send: async () => {}, close: async () => {},
        };
      },
    });
    return { hub, captured };
  }

  it("a refreshed gh token is read on the 401 and the connect goes through with it", async () => {
    let current = GH_TOKEN;
    const h = await setup({ gh: () => ({ ok: true, token: current }) });
    await h.oauth.start(h.row.id);
    current = GH_TOKEN_2; // `gh auth refresh` happened; the stored copy is stale
    const { hub, captured } = wire(h, () => GH_TOKEN_2);
    const tools = await hub.tools(h.row.id);
    expect(tools.length).toBeGreaterThan(0);
    expect(captured).toEqual([`Bearer ${GH_TOKEN}`, `Bearer ${GH_TOKEN_2}`]);
    expect(readOauthState(h.reload().oauthJson).tokens?.access_token).toBe(GH_TOKEN_2);
    expect(oauthStatusOf(h.reload())).toBe("connected");
    await hub.close();
  });

  it("gh still holding the rejected token flags the row instead of retrying, and the error carries no token", async () => {
    const h = await setup();
    await h.oauth.start(h.row.id);
    const { hub, captured } = wire(h, () => "something-else-entirely");
    const err = await rejection(() => hub.tools(h.row.id));
    expect(captured).toHaveLength(1);
    expect(err.message).not.toContain(GH_TOKEN);
    expect(oauthStatusOf(h.reload())).toBe("reconnect_needed");
    await hub.close();
  });

  it("a pasted token that stops working is flagged for the user, gh untouched", async () => {
    const h = await setup();
    h.oauth.setToken(h.row.id, "github_pat_revoked_1234567890");
    const { hub } = wire(h, () => "nope");
    await rejection(() => hub.tools(h.row.id));
    expect(h.ghCalls()).toBe(0);
    expect(oauthStatusOf(h.reload())).toBe("reconnect_needed");
    await hub.close();
  });
});
