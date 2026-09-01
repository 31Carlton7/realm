import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { openDatabase, type Db } from "../db/database";
import { McpServersStore, type McpServerRow } from "../store/mcp";
import { RpcError } from "../store/rows";
import { McpHub } from "./hub";
import { McpOauth, readOauthState, type McpOauthState } from "./oauth";
import { oauthStatusOf } from "./service";
import { makeStubAuthServer, type StubAuthServer } from "./fixtures/stub-auth-server";
import { makeStubServer, type StubServer } from "./fixtures/stub-server";

/** Any port will do — `McpOauth` only ever interpolates it into the redirect URI, and no test here
 *  drives a real browser to it. `gateway.test.ts` covers the route on the real listener. */
const GATEWAY_PORT = 45678;
const REDIRECT_URI = `http://127.0.0.1:${GATEWAY_PORT}/oauth/callback`;

type Harness = {
  db: Db;
  servers: McpServersStore;
  oauth: McpOauth;
  as: StubAuthServer;
  row: McpServerRow;
  /** Every `serverId` the status callback was fired with, in order. */
  statusEvents: string[];
  /** Re-read the row — `McpServerRow` is a snapshot, and every write here goes through the store. */
  reload(): McpServerRow;
  state(): McpOauthState;
  /** Rewrite the stored expiry into the past, the only way to reach the refresh path without waiting an
   *  hour. Deliberately touches only `expires_at`: the tokens themselves stay exactly as issued, so the
   *  refresh that follows is a real one against the stub. */
  expireAccessToken(): void;
  /** start → stub-browser authorize → callback, i.e. one complete interactive connection. */
  connect(): Promise<void>;
};

const open: { db: Db; as: StubAuthServer }[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) { await h.as.close(); h.db.close(); }
});

async function setup(opts: Parameters<typeof makeStubAuthServer>[0] = {}): Promise<Harness> {
  const as = await makeStubAuthServer(opts);
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "realm-mcp-oauth-")), "realm.db"));
  open.push({ db, as });
  const servers = new McpServersStore(db);
  const row = servers.create({ name: "remote", transport: "http", command: "", args: [], url: `${as.url}/mcp`, secrets: {} });
  const statusEvents: string[] = [];
  const oauth = new McpOauth({ servers, gatewayPort: () => GATEWAY_PORT, onStatus: (id) => statusEvents.push(id) });
  const h: Harness = {
    db, servers, oauth, as, row, statusEvents,
    reload: () => servers.get(row.id)!,
    state: () => readOauthState(servers.get(row.id)!.oauthJson),
    expireAccessToken() {
      const state = h.state();
      servers.setOauth(row.id, JSON.stringify({ ...state, tokens: { ...state.tokens!, expires_at: Date.now() - 1000 } }));
    },
    // Reads `h.oauth` rather than closing over the instance built here, so the hub tests below — which
    // swap in an instance wired to a hub — actually exercise THAT one's status callback.
    async connect() {
      const { authUrl } = await h.oauth.start(row.id);
      await h.oauth.handleCallback(as.authorize(authUrl));
    },
  };
  return h;
}

/** `expect(...).rejects` loses the `RpcError` code, so failures are caught rather than asserted on
 *  inline — every test here cares about the code AND the message text a user would read. */
async function rejection(fn: () => Promise<unknown>): Promise<RpcError> {
  try { await fn(); } catch (err) { return err as RpcError; }
  throw new Error("expected the call to reject, but it resolved");
}

describe("start — discovery, registration, PKCE", () => {
  it("returns an authorization URL carrying an S256 challenge, a state nonce, and the loopback redirect", async () => {
    const h = await setup();
    const { authUrl } = await h.oauth.start(h.row.id);
    const p = new URL(authUrl).searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toBeTruthy();
    expect(p.get("state")).toBeTruthy();
    expect(p.get("redirect_uri")).toBe(REDIRECT_URI);
    // The scope came from the protected-resource document, not from anything hard-coded here.
    expect(p.get("scope")).toBe("mcp:tools");
    // The verifier stays server-side; only its hash ever goes on the wire.
    expect(authUrl).not.toContain(h.state().pending!.codeVerifier);
  });

  it("registers a client dynamically and reuses it on the next start rather than re-registering", async () => {
    const h = await setup();
    await h.oauth.start(h.row.id);
    const first = h.state().client!.client_id;
    await h.oauth.start(h.row.id);
    expect(h.as.registrations).toHaveLength(1);
    expect(h.state().client!.client_id).toBe(first);
  });

  it("a fresh flow replaces the previous pending nonce, so only one is ever live for a row", async () => {
    const h = await setup();
    const first = new URL((await h.oauth.start(h.row.id)).authUrl).searchParams.get("state");
    const second = new URL((await h.oauth.start(h.row.id)).authUrl).searchParams.get("state");
    expect(second).not.toBe(first);
    expect(h.state().pending!.state).toBe(second);
  });

  it("a pending flow alone is not a connection — status stays unconfigured until the callback lands", async () => {
    const h = await setup();
    await h.oauth.start(h.row.id);
    expect(oauthStatusOf(h.reload())).toBe("unconfigured");
    expect(await h.oauth.headers(h.reload())).toEqual({});
    expect(h.statusEvents).toEqual([]);
  });

  it("keeps a registration whose own start then failed, instead of orphaning it and minting another", async () => {
    // `response_types_supported` without `"code"` makes the SDK reject the server as incompatible at
    // `startAuthorization` — AFTER `POST /register` has already created a real record on the AS. Losing
    // track of it here would leave a dead client behind on the server on every retry.
    const h = await setup({ responseTypes: ["token"] });
    expect((await rejection(() => h.oauth.start(h.row.id))).code).toBe("MCP_OAUTH_FAILED");
    const clientId = h.state().client?.client_id;
    expect(clientId).toBeTruthy();
    expect(oauthStatusOf(h.reload())).toBe("unconfigured");
    await rejection(() => h.oauth.start(h.row.id));
    expect(h.as.registrations).toHaveLength(1);
    expect(h.state().client!.client_id).toBe(clientId);
  });

  it("refuses a server that offers no dynamic client registration instead of starting a doomed flow", async () => {
    const h = await setup({ dynamicRegistration: false });
    const err = await rejection(() => h.oauth.start(h.row.id));
    expect(err.code).toBe("MCP_OAUTH_UNSUPPORTED");
    expect(err.message).toContain("dynamic client registration");
  });

  it("refuses a stdio row — it authenticates through its own environment, not OAuth", async () => {
    const h = await setup();
    const stdio = h.servers.create({ name: "local", transport: "stdio", command: "x", args: [], url: "", secrets: {} });
    const err = await rejection(() => h.oauth.start(stdio.id));
    expect(err.code).toBe("MCP_OAUTH_UNSUPPORTED");
  });

  it("refuses before the gateway is listening rather than minting a redirect URI nothing answers", async () => {
    const h = await setup();
    const oauth = new McpOauth({ servers: h.servers, gatewayPort: () => null });
    const err = await rejection(() => oauth.start(h.row.id));
    expect(err.code).toBe("MCP_OAUTH_UNAVAILABLE");
  });

  it("falls back to treating the server URL as the authorization server when RFC 9728 is absent", async () => {
    // No protected-resource document: no scope to request and no RFC 8707 resource indicator, but the
    // flow still completes — this is the legacy shape a lot of deployed servers still have.
    const h = await setup({ protectedResourceMetadata: false });
    const { authUrl } = await h.oauth.start(h.row.id);
    expect(new URL(authUrl).searchParams.get("scope")).toBeNull();
    expect(new URL(authUrl).searchParams.get("resource")).toBeNull();
    await h.oauth.handleCallback(h.as.authorize(authUrl));
    expect(oauthStatusOf(h.reload())).toBe("connected");
  });
});

describe("handleCallback — state validation and code exchange", () => {
  it("exchanges the code and stores tokens, and headers() then injects the Bearer", async () => {
    const h = await setup();
    const { authUrl } = await h.oauth.start(h.row.id);
    const { serverId } = await h.oauth.handleCallback(h.as.authorize(authUrl));
    expect(serverId).toBe(h.row.id);
    expect(oauthStatusOf(h.reload())).toBe("connected");
    expect(h.statusEvents).toEqual([h.row.id]);
    // The stub verifies the code_verifier against the S256 challenge before issuing this, so a Bearer
    // arriving here proves the PKCE binding held end to end.
    expect(await h.oauth.headers(h.reload())).toEqual({ Authorization: `Bearer ${h.as.lastIssuedAccessToken()}` });
    expect(h.as.tokenRequests[0]!.grant_type).toBe("authorization_code");
    expect(h.as.tokenRequests[0]!.params.code_verifier).toBeTruthy();
  });

  it("rejects a callback whose state matches no pending flow", async () => {
    const h = await setup();
    await h.oauth.start(h.row.id);
    const err = await rejection(() => h.oauth.handleCallback(`${REDIRECT_URI}?code=whatever&state=not-a-real-nonce`));
    expect(err.code).toBe("MCP_OAUTH_STATE");
    expect(oauthStatusOf(h.reload())).toBe("unconfigured");
  });

  it("rejects a callback with no state at all", async () => {
    const h = await setup();
    await h.oauth.start(h.row.id);
    expect((await rejection(() => h.oauth.handleCallback(`${REDIRECT_URI}?code=whatever`))).code).toBe("MCP_OAUTH_STATE");
  });

  it("rejects a replayed redirect — the state nonce is single-use", async () => {
    const h = await setup();
    const { authUrl } = await h.oauth.start(h.row.id);
    const redirect = h.as.authorize(authUrl);
    await h.oauth.handleCallback(redirect);
    const err = await rejection(() => h.oauth.handleCallback(redirect));
    expect(err.code).toBe("MCP_OAUTH_STATE");
    // The replay must not have disturbed the connection the first delivery established.
    expect(oauthStatusOf(h.reload())).toBe("connected");
    expect(h.as.tokenRequests).toHaveLength(1);
  });

  it("burns the nonce even when the exchange itself fails, so a retry needs a fresh Connect", async () => {
    const h = await setup();
    const { authUrl } = await h.oauth.start(h.row.id);
    const redirect = h.as.authorize(authUrl);
    h.as.failTokenNext(1, 400, JSON.stringify({ error: "invalid_grant", error_description: "code expired" }));
    expect((await rejection(() => h.oauth.handleCallback(redirect))).code).toBe("MCP_OAUTH_FAILED");
    expect(h.state().pending).toBeUndefined();
    expect((await rejection(() => h.oauth.handleCallback(redirect))).code).toBe("MCP_OAUTH_STATE");
  });

  it("surfaces an authorization server's refusal instead of a code-less exchange attempt", async () => {
    const h = await setup();
    const { authUrl } = await h.oauth.start(h.row.id);
    const state = new URL(authUrl).searchParams.get("state")!;
    const err = await rejection(() => h.oauth.handleCallback(`${REDIRECT_URI}?error=access_denied&error_description=user+said+no&state=${state}`));
    expect(err.code).toBe("MCP_OAUTH_FAILED");
    expect(err.message).toContain("access_denied");
    expect(h.as.tokenRequests).toHaveLength(0);
    expect(oauthStatusOf(h.reload())).toBe("unconfigured");
  });

  it("a completed reconnection clears reconnect_needed", async () => {
    const h = await setup();
    await h.connect();
    h.expireAccessToken();
    h.as.failTokenNext(1, 400, JSON.stringify({ error: "invalid_grant" }));
    await rejection(() => h.oauth.headers(h.reload()));
    expect(oauthStatusOf(h.reload())).toBe("reconnect_needed");
    await h.connect();
    expect(oauthStatusOf(h.reload())).toBe("connected");
    expect(await h.oauth.headers(h.reload())).toEqual({ Authorization: `Bearer ${h.as.lastIssuedAccessToken()}` });
  });
});

describe("headers — silent refresh and reconnect_needed", () => {
  it("returns {} for a row that has never connected, and for one whose stored state is corrupt", async () => {
    const h = await setup();
    expect(await h.oauth.headers(h.reload())).toEqual({});
    h.servers.setOauth(h.row.id, "{not json at all");
    expect(await h.oauth.headers(h.reload())).toEqual({});
    expect(oauthStatusOf(h.reload())).toBe("unconfigured");
  });

  it("refreshes silently on expiry and stores the new token", async () => {
    const h = await setup();
    await h.connect();
    const original = h.state().tokens!.access_token;
    h.expireAccessToken();
    const headers = await h.oauth.headers(h.reload());
    const refreshed = h.as.lastIssuedAccessToken()!;
    expect(refreshed).not.toBe(original);
    expect(headers).toEqual({ Authorization: `Bearer ${refreshed}` });
    expect(h.state().tokens!.access_token).toBe(refreshed);
    expect(h.state().tokens!.expires_at).toBeGreaterThan(Date.now());
    expect(h.as.tokenRequests.map((r) => r.grant_type)).toEqual(["authorization_code", "refresh_token"]);
    // A silent refresh is not a status change — the row was connected before and is connected after.
    expect(h.statusEvents).toEqual([h.row.id]);
  });

  it("coalesces concurrent refreshes of one row onto a single token request", async () => {
    // Without the in-flight map, a `hub.invalidate` landing mid-refresh lets a second connect refresh
    // with the SAME not-yet-rotated refresh token. The stub rotates (it deletes each refresh token as it
    // is redeemed), so the loser would get `invalid_grant` and latch a spurious `reconnect_needed` on a
    // row whose tokens the winner had already stored fine.
    const h = await setup();
    await h.connect();
    h.expireAccessToken();
    const row = h.reload();

    const [a, b] = await Promise.all([h.oauth.headers(row), h.oauth.headers(row)]);
    expect(h.as.tokenRequests.filter((r) => r.grant_type === "refresh_token")).toHaveLength(1);
    expect(a).toEqual(b);
    expect(a).toEqual({ Authorization: `Bearer ${h.as.lastIssuedAccessToken()}` });
    expect(oauthStatusOf(h.reload())).toBe("connected");
  });

  it("a caller holding a row snapshot from before a refresh does not refresh again", async () => {
    // The other half of the same race: a snapshot read before the rotation still carries the OLD tokens,
    // so trusting it would redeem an already-consumed refresh token a tick after the map cleared.
    const h = await setup();
    await h.connect();
    h.expireAccessToken();
    const stale = h.reload(); // captured while expired, deliberately reused after the refresh lands
    await h.oauth.headers(stale);
    const after = h.as.tokenRequests.length;

    expect(await h.oauth.headers(stale)).toEqual({ Authorization: `Bearer ${h.as.lastIssuedAccessToken()}` });
    expect(h.as.tokenRequests).toHaveLength(after);
    expect(oauthStatusOf(h.reload())).toBe("connected");
  });

  it("a failed refresh releases the in-flight entry — the row is flagged, not wedged", async () => {
    // A rejected promise left in the map would replay the same failure forever, so a LATER refresh (on a
    // row the user has since reconnected) has to reach the network again rather than resolve from a
    // stale cached rejection.
    const h = await setup();
    await h.connect();
    h.expireAccessToken();
    h.as.failTokenNext(1, 400, JSON.stringify({ error: "invalid_grant" }));
    await rejection(() => h.oauth.headers(h.reload()));
    expect(oauthStatusOf(h.reload())).toBe("reconnect_needed");

    await h.connect(); // the user reconnects; the flag clears
    h.expireAccessToken();
    const before = h.as.tokenRequests.length;
    expect(await h.oauth.headers(h.reload())).toEqual({ Authorization: `Bearer ${h.as.lastIssuedAccessToken()}` });
    expect(h.as.tokenRequests.length).toBe(before + 1);
    expect(oauthStatusOf(h.reload())).toBe("connected");
  });

  it("names the machine reason when an OAuth error body carries no description", async () => {
    // `{"error":"invalid_grant"}` is spec-conforming and has no `error_description`, which leaves the
    // SDK's `OAuthError.message` EMPTY. Rendered as-is that produced a dangling `"...: "` — on the
    // gateway's callback page, a sentence that looks like it lost its ending.
    const h = await setup();
    await h.connect();
    h.expireAccessToken();
    h.as.failTokenNext(1, 400, JSON.stringify({ error: "invalid_grant" }));
    const err = await rejection(() => h.oauth.headers(h.reload()));
    expect(err.message).toContain("invalid_grant");
    expect(err.message).not.toMatch(/:\s*$/);
  });

  it("a still-valid token is used as-is, without touching the token endpoint", async () => {
    const h = await setup();
    await h.connect();
    await h.oauth.headers(h.reload());
    await h.oauth.headers(h.reload());
    expect(h.as.tokenRequests).toHaveLength(1);
  });

  it("flips to reconnect_needed on refresh failure and does not try a second time", async () => {
    const h = await setup();
    await h.connect();
    h.expireAccessToken();
    // Enough forced failures that a retry WOULD succeed at reaching the endpoint — the assertion below
    // is that no second request was ever made, not that a second one would also have failed.
    h.as.failTokenNext(5, 400, JSON.stringify({ error: "invalid_grant", error_description: "refresh token revoked" }));

    const first = await rejection(() => h.oauth.headers(h.reload()));
    expect(first.code).toBe("MCP_OAUTH_RECONNECT");
    expect(first.message).toContain("needs reconnecting");
    expect(first.message).toContain("Connect again in settings");
    expect(oauthStatusOf(h.reload())).toBe("reconnect_needed");
    expect(h.statusEvents).toEqual([h.row.id, h.row.id]);
    const attempts = h.as.tokenRequests.length;

    const second = await rejection(() => h.oauth.headers(h.reload()));
    expect(second.code).toBe("MCP_OAUTH_RECONNECT");
    expect(second.message).toContain("needs reconnecting");
    // The refresh-storm guard: a flagged row fails without going near the network again.
    expect(h.as.tokenRequests).toHaveLength(attempts);
  });

  it("flips to reconnect_needed when there is no refresh token to refresh with", async () => {
    const h = await setup({ refreshTokens: false, accessTokenTtlSec: 3600 });
    await h.connect();
    h.expireAccessToken();
    expect((await rejection(() => h.oauth.headers(h.reload()))).code).toBe("MCP_OAUTH_RECONNECT");
    expect(oauthStatusOf(h.reload())).toBe("reconnect_needed");
    // No refresh token means nothing to send: the endpoint was never called.
    expect(h.as.tokenRequests.map((r) => r.grant_type)).toEqual(["authorization_code"]);
  });

  it("a token with no expiry is never proactively refreshed", async () => {
    const h = await setup({ accessTokenTtlSec: null });
    await h.connect();
    expect(h.state().tokens!.expires_at).toBeUndefined();
    expect(await h.oauth.headers(h.reload())).toEqual({ Authorization: `Bearer ${h.as.lastIssuedAccessToken()}` });
    expect(h.as.tokenRequests).toHaveLength(1);
  });
});

describe("sanitization — a thrown error never carries a credential", () => {
  it("scrubs tokens an authorization server echoed back in its error body", async () => {
    const h = await setup();
    await h.connect();
    const { access_token: accessToken, refresh_token: refreshToken } = h.state().tokens!;
    h.expireAccessToken();
    // Not a well-formed OAuth error response, on purpose: the SDK's `parseErrorResponse` then copies the
    // RAW BODY into the error message, which is exactly the leak the hub cannot redact on its own
    // (it never saw these values — they came out of `oauthJson`, not `row.secrets`).
    h.as.failTokenNext(1, 400, `{"detail":"refresh_token ${refreshToken} is revoked; access_token ${accessToken} is dead"}`);

    const err = await rejection(() => h.oauth.headers(h.reload()));
    expect(err.message).not.toContain(accessToken);
    expect(err.message).not.toContain(refreshToken!);
    expect(err.message).toContain("[redacted]");
    // Still says something useful about what happened — sanitizing must not mean saying nothing.
    expect(err.message).toContain("is revoked");
  });

  it("scrubs the PKCE verifier out of a failed exchange — it renders onto the callback page", async () => {
    // An AS reporting a failed PKCE check can echo `code_verifier` straight into its 400 body, and this
    // failure path is exactly the one whose message the gateway prints on the callback page.
    const h = await setup();
    const { authUrl } = await h.oauth.start(h.row.id);
    const verifier = h.state().pending!.codeVerifier;
    const redirect = h.as.authorize(authUrl);
    h.as.failTokenNext(1, 400, `{"detail":"code_verifier ${verifier} did not match"}`);
    const err = await rejection(() => h.oauth.handleCallback(redirect));
    expect(err.message).not.toContain(verifier);
    expect(err.message).toContain("[redacted]");
  });

  it("scrubs the authorization code out of a failed exchange", async () => {
    const h = await setup();
    const { authUrl } = await h.oauth.start(h.row.id);
    const redirect = h.as.authorize(authUrl);
    const code = new URL(redirect).searchParams.get("code")!;
    h.as.failTokenNext(1, 400, `{"detail":"code ${code} was already used"}`);
    const err = await rejection(() => h.oauth.handleCallback(redirect));
    expect(err.message).not.toContain(code);
    expect(err.message).toContain("[redacted]");
  });
});

describe("disconnect", () => {
  it("clears every trace of the connection and returns the row to unconfigured", async () => {
    const h = await setup();
    await h.connect();
    const { access_token: accessToken } = h.state().tokens!;
    h.oauth.disconnect(h.row.id);
    expect(h.reload().oauthJson).toBe("");
    expect(h.reload().oauthJson).not.toContain(accessToken);
    expect(oauthStatusOf(h.reload())).toBe("unconfigured");
    expect(await h.oauth.headers(h.reload())).toEqual({});
    expect(h.statusEvents).toEqual([h.row.id, h.row.id]);
  });

  it("clears reconnect_needed too — Connect starts from nothing, including a new client registration", async () => {
    const h = await setup();
    await h.connect();
    h.expireAccessToken();
    h.as.failTokenNext(1, 400, JSON.stringify({ error: "invalid_grant" }));
    await rejection(() => h.oauth.headers(h.reload()));
    h.oauth.disconnect(h.row.id);
    expect(oauthStatusOf(h.reload())).toBe("unconfigured");
    await h.oauth.start(h.row.id);
    expect(h.as.registrations).toHaveLength(2);
  });

  it("throws NOT_FOUND for a server that does not exist", async () => {
    const h = await setup();
    expect(() => h.oauth.disconnect("nope")).toThrow(/not found/);
  });
});

describe("oauthStatusOf — the single derivation site", () => {
  const rowWith = (state: unknown): McpServerRow => ({ oauthJson: typeof state === "string" ? state : JSON.stringify(state) } as McpServerRow);
  const TOKENS = { access_token: "a-token", token_type: "Bearer" };

  it("empty column is unconfigured", () => {
    expect(oauthStatusOf(rowWith(""))).toBe("unconfigured");
  });

  it("a pending flow with no tokens is unconfigured — Connect was never completed", () => {
    expect(oauthStatusOf(rowWith({ pending: { state: "n", codeVerifier: "v", redirectUri: REDIRECT_URI, startedAt: 1 } }))).toBe("unconfigured");
  });

  it("a client registration with no tokens is unconfigured", () => {
    expect(oauthStatusOf(rowWith({ client: { client_id: "c" } }))).toBe("unconfigured");
  });

  it("tokens are connected", () => {
    expect(oauthStatusOf(rowWith({ tokens: TOKENS }))).toBe("connected");
  });

  it("the reconnect flag wins over tokens — a row that cannot call is not connected", () => {
    expect(oauthStatusOf(rowWith({ tokens: TOKENS, reconnectNeeded: true }))).toBe("reconnect_needed");
  });

  it("corruption degrades to unconfigured rather than throwing", () => {
    for (const bad of ["{{{", "[]", "null", "42", '"a string"']) {
      expect(oauthStatusOf(rowWith(bad))).toBe("unconfigured");
    }
  });

  it("partial corruption costs only the branch that is bad", () => {
    // Working tokens survive a mangled pending flow — losing a connection because an abandoned nonce
    // went bad would be a needless re-auth.
    expect(oauthStatusOf(rowWith({ tokens: TOKENS, pending: "not an object" }))).toBe("connected");
    // ...and a token entry with no access_token is not a connection, whatever else it carries.
    expect(oauthStatusOf(rowWith({ tokens: { token_type: "Bearer" } }))).toBe("unconfigured");
  });
});

describe("hub + oauth end to end", () => {
  type Wired = {
    hub: McpHub;
    stub: StubServer;
    /** The `Authorization` header handed to each transport built, in order. */
    captured: (string | undefined)[];
  };

  /** The `app.ts` wiring, in miniature: the hub's `authHeaders` seam calls `oauth.headers`, and the
   *  oauth status callback invalidates the hub. `makeTransport` stands in for the real HTTP transport
   *  and records the headers the hub actually built. */
  function wire(h: Harness): Wired {
    const stub = makeStubServer();
    const captured: (string | undefined)[] = [];
    let hub: McpHub;
    h.oauth = new McpOauth({
      servers: h.servers,
      gatewayPort: () => GATEWAY_PORT,
      onStatus: (id) => { h.statusEvents.push(id); hub.invalidate(id); },
    });
    hub = new McpHub({
      servers: h.servers,
      onStatus: () => {},
      authHeaders: (row) => h.oauth.headers(row),
      makeTransport: async (_row, headers): Promise<Transport> => {
        captured.push(headers.Authorization);
        return stub.connectInMemory();
      },
    });
    return { hub, stub, captured };
  }

  it("injects the stored Bearer on an upstream call", async () => {
    const h = await setup();
    const { hub, captured } = wire(h);
    await h.connect();
    await hub.tools(h.row.id);
    expect(captured).toEqual([`Bearer ${h.as.lastIssuedAccessToken()}`]);
    await hub.close();
  });

  it("refreshes an expired token at connect time and injects the NEW Bearer", async () => {
    const h = await setup();
    const { hub, captured } = wire(h);
    await h.connect();
    const stale = h.state().tokens!.access_token;
    h.expireAccessToken();
    await hub.tools(h.row.id);
    const refreshed = h.as.lastIssuedAccessToken()!;
    expect(refreshed).not.toBe(stale);
    expect(captured).toEqual([`Bearer ${refreshed}`]);
    await hub.close();
  });

  it("hub.invalidate on a status change is what lets a rotated token reach the next call", async () => {
    const h = await setup();
    const { hub, captured } = wire(h);
    await h.connect();
    const first = h.as.lastIssuedAccessToken()!;
    await hub.tools(h.row.id);
    // A second call reuses the live client — `authHeaders` is a CONNECT-time seam, so nothing about the
    // stored tokens is re-read here. This is precisely why the status callback has to invalidate.
    await hub.tools(h.row.id);
    expect(captured).toEqual([`Bearer ${first}`]);

    await h.connect(); // reconnect: new tokens, status callback fires, hub client is dropped
    const second = h.as.lastIssuedAccessToken()!;
    expect(second).not.toBe(first);
    await hub.tools(h.row.id);
    expect(captured).toEqual([`Bearer ${first}`, `Bearer ${second}`]);
    await hub.close();
  });

  it("a reconnect_needed row fails the hub call with the reconnect message, never a raw token", async () => {
    const h = await setup();
    const { hub } = wire(h);
    await h.connect();
    const { access_token: accessToken, refresh_token: refreshToken } = h.state().tokens!;
    h.expireAccessToken();
    h.as.failTokenNext(5, 400, `{"detail":"token ${refreshToken} revoked, ${accessToken} dead"}`);

    const err = await rejection(() => hub.tools(h.row.id));
    expect(err.message).toContain("needs reconnecting");
    expect(err.message).not.toContain(accessToken);
    expect(err.message).not.toContain(refreshToken!);
    expect(oauthStatusOf(h.reload())).toBe("reconnect_needed");
    await hub.close();
  });

  it("disconnect stops a live client from going on using the revoked Bearer", async () => {
    const h = await setup();
    const { hub, captured } = wire(h);
    await h.connect();
    await hub.tools(h.row.id);
    h.oauth.disconnect(h.row.id);
    await hub.tools(h.row.id);
    // The second transport was built after the disconnect, so it carries no credential at all.
    expect(captured).toEqual([`Bearer ${h.as.lastIssuedAccessToken()}`, undefined]);
    await hub.close();
  });
});
