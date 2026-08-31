import { randomBytes } from "node:crypto";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { NotFoundError, RpcError } from "../store/rows";
import type { McpServerRow, McpServersStore } from "../store/mcp";

/**
 * Everything Realm persists about one server row's OAuth connection, serialized into
 * `McpServerRow.oauthJson`. **Plaintext, same posture as `row.secrets`** — `MCP_SECRET_STORAGE_NOTE`
 * already says so on every surface that touches it, and W5 does not weaken (or quietly improve) that
 * claim; `safeStorage` is a named follow-up, not this build.
 *
 * Deliberately **unversioned**: there is no migration path and there does not need to be one. A blob
 * this reader cannot make sense of degrades to "unconfigured" (see `readOauthState`), and the recovery
 * for that is the same single click as the very first connection — Connect. A version tag would buy
 * nothing that re-running a 20-second interactive flow does not already buy.
 *
 * Field shapes are the SDK's OWN snake_case types (`OAuthTokens`, `OAuthClientInformationMixed`,
 * `AuthorizationServerMetadata`) rather than a camelCase mirror, so a stored value is handed straight
 * back to `refreshAuthorization`/`exchangeAuthorization` with no translation layer that could drift out
 * of sync with the SDK's expectations after an upgrade.
 */
export type McpOauthState = {
  /**
   * The RFC 7591 dynamic client registration, REUSED across reconnects: an authorization server that
   * issues a fresh client on every Connect accumulates dead client records, and some rate-limit DCR
   * outright. Cleared only by `disconnect`.
   */
  client?: OAuthClientInformationMixed;
  /**
   * What RFC 9728 → RFC 8414 discovery found, cached so a token refresh (which happens on a timer the
   * user never sees) does not re-run two metadata round-trips first. Mirrors the SDK's own
   * `OAuthDiscoveryState` concept — see `OAuthClientProvider.saveDiscoveryState`'s doc comment for why
   * the SDK considers this worth persisting.
   */
  discovery?: {
    authorizationServerUrl: string;
    metadata?: AuthorizationServerMetadata;
    /** RFC 8707 resource indicator, when the server published protected-resource metadata. */
    resource?: string;
    /** Sent on both the DCR and authorization requests, per the SDK's scope-selection strategy. */
    scope?: string;
  };
  /** `expires_at` is absolute epoch ms, derived once from the response's relative `expires_in` — a
   *  stored relative TTL would be meaningless the moment the process restarts. */
  tokens?: OAuthTokens & { expires_at?: number };
  /**
   * The in-flight interactive flow: the PKCE verifier and the `state` nonce the callback must present.
   * **Single-use** — `handleCallback` burns it before it does anything that can fail, so a replayed
   * redirect finds nothing to match. At most one exists per row (a second `start` overwrites it), which
   * is also why there is no expiry sweep: an abandoned flow is one unusable 32-byte nonce sitting on a
   * row until the next Connect overwrites it, not a growing set of live credentials.
   */
  pending?: { state: string; codeVerifier: string; redirectUri: string; startedAt: number };
  /**
   * Set when a silent refresh failed. Read by `oauthStatusOf` (`service.ts`) to produce
   * `reconnect_needed`, and by `headers()` to fail fast instead of hammering a token endpoint that has
   * already said no. Cleared only by a completed `handleCallback` or by `disconnect`.
   */
  reconnectNeeded?: boolean;
};

/** Refresh this long BEFORE the stored expiry rather than exactly at it: an access token that expires
 *  during the round-trip it was attached to fails the call for no reason. */
const EXPIRY_SKEW_MS = 30_000;

/**
 * Parse `McpServerRow.oauthJson`. **Never throws** — Realm writes this column itself, so anything
 * unreadable is corruption (a half-written row, a hand-edited DB), not input, and the graceful
 * degradation is "this server has no OAuth connection": `oauthStatusOf` reports `unconfigured`,
 * `headers()` sends nothing, and Connect starts a clean flow. Failing loudly would instead make one bad
 * row un-listable and un-fixable from the UI.
 *
 * Each branch is validated independently so partial corruption costs only the branch that is bad: a
 * mangled `pending` does not throw away working `tokens`. `discovery.metadata` is the one value kept
 * unvalidated — it is a large SDK-shaped document whose fields only ever flow back INTO SDK helpers,
 * which reject a malformed one with an ordinary error that `headers()` catches, sanitizes, and turns
 * into `reconnect_needed` (recoverable by Connect). Re-validating it here would duplicate the SDK's own
 * schemas for no behavior the user can tell apart.
 */
export function readOauthState(json: string): McpOauthState {
  if (!json) return {};
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return {}; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const state: McpOauthState = {};
  const client = o.client;
  if (isObject(client) && typeof client.client_id === "string") state.client = client as unknown as OAuthClientInformationMixed;
  const discovery = o.discovery;
  if (isObject(discovery) && typeof discovery.authorizationServerUrl === "string") {
    state.discovery = {
      authorizationServerUrl: discovery.authorizationServerUrl,
      metadata: isObject(discovery.metadata) ? (discovery.metadata as unknown as AuthorizationServerMetadata) : undefined,
      resource: typeof discovery.resource === "string" ? discovery.resource : undefined,
      scope: typeof discovery.scope === "string" ? discovery.scope : undefined,
    };
  }
  const tokens = o.tokens;
  if (isObject(tokens) && typeof tokens.access_token === "string") state.tokens = tokens as unknown as McpOauthState["tokens"];
  const pending = o.pending;
  if (isObject(pending) && typeof pending.state === "string" && typeof pending.codeVerifier === "string" && typeof pending.redirectUri === "string") {
    state.pending = { state: pending.state, codeVerifier: pending.codeVerifier, redirectUri: pending.redirectUri, startedAt: typeof pending.startedAt === "number" ? pending.startedAt : 0 };
  }
  if (o.reconnectNeeded === true) state.reconnectNeeded = true;
  return state;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * OAuth 2.1 + PKCE for remote (http/sse) MCP servers, per the MCP authorization spec: RFC 9728
 * protected-resource metadata → RFC 8414 authorization-server metadata → RFC 7591 dynamic client
 * registration where the server offers it → authorization code with an S256 challenge.
 *
 * **Tokens never leave realm-server.** They live in `row.oauthJson`, they are turned into an
 * `Authorization` header inside `headers()`, and nothing here logs, broadcasts, or returns one. The
 * contract surface carries `oauthStatus` (a three-state enum) and nothing else.
 *
 * **Every error this class throws or rejects with is sanitized.** That is not defensive habit, it is a
 * contract the hub depends on: `hub.ts` redacts `row.secrets` and the headers IT built, but a token that
 * only ever appears inside an error thrown by `authHeaders` — an authorization server quoting the
 * rejected refresh token back in a 400 body, which `parseErrorResponse` faithfully copies into
 * `Error.message` — is invisible to the hub's redaction list. See `Redactor` below.
 *
 * The discovery/registration/PKCE/exchange primitives are the SDK's (`client/auth.js`), used
 * individually rather than through its `auth()` orchestrator: `auth()` drives an
 * `OAuthClientProvider` that owns browser redirection and transport retry, whereas Realm's flow is
 * split across three processes (settings click → system browser → loopback callback) and its upstream
 * headers are built by the hub's `authHeaders` seam. Composing the same primitives keeps every wire
 * detail — S256, discovery fallback, client-auth method selection — identical to the SDK's while
 * leaving the orchestration where Realm's architecture already put it.
 */
export class McpOauth {
  constructor(private readonly d: {
    servers: McpServersStore;
    /** The gateway's bound loopback port, or `null` before `McpGateway.listen()` has run — the redirect
     *  URI cannot exist until then, so `start()` refuses rather than minting a dead one. Late-bound (a
     *  function, not a number) because the gateway is constructed after the hub that needs this class. */
    gatewayPort: () => number | null;
    /**
     * One row's OAuth state changed in a way `oauthStatusOf` can see — connected after a callback,
     * `reconnect_needed` after a failed refresh, unconfigured after a disconnect. `app.ts` uses it to
     * broadcast `mcp.serverStatus` and to `hub.invalidate(id)`.
     *
     * Deliberately NOT fired on a successful silent refresh. A refresh only ever runs from inside
     * `headers()`, which the hub calls while it is building a transport — the fresh token is already
     * going into the client being constructed, and invalidating mid-connect would make the hub's own
     * post-resolve check reap the very client the refresh just served. The observable status
     * (`connected`) does not change either, so there would be nothing to broadcast.
     */
    onStatus?: (serverId: string) => void;
    /** Test seam: every SDK auth helper takes a `fetchFn`, so the whole flow can run against an
     *  in-process stub authorization server without patching global `fetch`. */
    fetchFn?: FetchLike;
  }) {}

  /**
   * Begin an interactive connection and return the URL the RENDERER opens in the system browser (this
   * process never opens a browser). Discovery and — for a row connecting for the first time — dynamic
   * client registration happen here, so a server that cannot do OAuth at all says so before the user
   * ever sees a browser tab.
   *
   * Existing tokens are left alone: a user who starts Connect and abandons it keeps the connection they
   * already had. `reconnectNeeded` is likewise left set until a callback actually completes — starting
   * a flow is not the same as finishing one.
   */
  async start(serverId: string): Promise<{ authUrl: string }> {
    const row = this.d.servers.get(serverId);
    if (!row) throw new NotFoundError("mcp server", serverId);
    if (row.transport === "stdio") {
      throw new RpcError("MCP_OAUTH_UNSUPPORTED", `"${row.name}" is a stdio server — it authenticates through its own environment, not OAuth`);
    }
    const port = this.d.gatewayPort();
    if (port === null) throw new RpcError("MCP_OAUTH_UNAVAILABLE", "the MCP gateway is not listening yet — try again in a moment");
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;

    const prev = readOauthState(row.oauthJson);
    const redact = new Redactor();
    redact.add(prev.client?.client_secret, prev.tokens?.access_token, prev.tokens?.refresh_token);
    try {
      const info = await discoverOAuthServerInfo(row.url, { fetchFn: this.d.fetchFn });
      const metadata = info.authorizationServerMetadata;
      // Same scope-selection strategy the SDK's own `auth()` applies (SEP-835): the protected resource's
      // advertised scopes, used consistently for BOTH the registration and the authorization request so
      // the client is registered for exactly what it then asks for.
      const scope = info.resourceMetadata?.scopes_supported?.join(" ");
      const resource = selectResource(row.url, info.resourceMetadata);

      let client = prev.client;
      if (!client) {
        if (!metadata?.registration_endpoint) {
          throw new RpcError("MCP_OAUTH_UNSUPPORTED", `"${row.name}" does not offer dynamic client registration, and Realm has no client registered with it`);
        }
        client = await registerClient(info.authorizationServerUrl, {
          metadata,
          scope,
          fetchFn: this.d.fetchFn,
          clientMetadata: {
            client_name: "Realm",
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            // A desktop app cannot keep a client secret, so it registers as a public client and relies on
            // PKCE. An authorization server that issues one anyway is still honored: the SDK's
            // `selectClientAuthMethod` picks a secret-bearing method whenever a secret came back.
            token_endpoint_auth_method: "none",
            scope,
          },
        });
        redact.add(client.client_secret);
        // Persisted IMMEDIATELY, before the authorization URL is even built: a registration is a record
        // the authorization server has already created, so losing track of it here would leave a dead
        // client behind on every failed start and re-register on every retry.
        this.write(serverId, { ...prev, client });
      }

      // The `state` nonce IS the binding to this server row: `handleCallback` finds the row whose pending
      // flow carries this exact value. 32 random bytes, single-use, stored server-side — equivalent to
      // the plan's "signed serverId nonce" without a signing key to manage, and it cannot be forged
      // because a value that no row is holding matches nothing.
      const state = randomBytes(32).toString("base64url");
      const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, {
        metadata, clientInformation: client, redirectUrl: redirectUri, scope, state, resource,
      });

      this.write(serverId, {
        ...prev,
        client,
        discovery: {
          authorizationServerUrl: info.authorizationServerUrl,
          metadata,
          resource: resource?.href,
          scope,
        },
        pending: { state, codeVerifier, redirectUri, startedAt: Date.now() },
      });
      return { authUrl: authorizationUrl.toString() };
    } catch (err) {
      throw redact.wrap("MCP_OAUTH_FAILED", err, `could not start the OAuth flow for "${row.name}"`);
    }
  }

  /**
   * Handle the loopback redirect. Takes the FULL callback URL (the gateway hands it the request URL
   * resolved against its own origin) and returns which server row just connected, so the caller can
   * name it in a status broadcast.
   */
  async handleCallback(callbackUrl: string): Promise<{ serverId: string }> {
    let url: URL;
    try { url = new URL(callbackUrl); } catch { throw new RpcError("MCP_OAUTH_FAILED", "the OAuth callback URL could not be parsed"); }
    const state = url.searchParams.get("state");
    if (!state) throw new RpcError("MCP_OAUTH_STATE", "this OAuth callback carried no state — start Connect again from settings");

    // Scanning rows is the lookup: `state` is only ever meaningful as "the nonce some row is holding".
    // There is at most one pending flow per row, so at most one row can match.
    const row = this.d.servers.list().find((r) => readOauthState(r.oauthJson).pending?.state === state);
    if (!row) throw new RpcError("MCP_OAUTH_STATE", "this OAuth callback does not match any connection Realm is waiting on — start Connect again from settings");

    const prev = readOauthState(row.oauthJson);
    const pending = prev.pending!;
    // Burned FIRST, before the `error` check and before any await: the nonce is single-use whether the
    // exchange succeeds, fails, or is a replay of one that already ran. Doing this after the exchange
    // would leave a window in which the same redirect could be delivered twice.
    this.write(row.id, { ...prev, pending: undefined });

    const redact = new Redactor();
    redact.add(prev.client?.client_secret, prev.tokens?.access_token, prev.tokens?.refresh_token);
    // The authorization code is short-lived and single-use, but it is still a credential — an error
    // response that quotes the rejected code back must not carry it into a log or an error toast.
    const code = url.searchParams.get("code");
    redact.add(code ?? undefined);
    try {
      const failure = url.searchParams.get("error");
      if (failure) {
        const description = url.searchParams.get("error_description");
        throw new Error(`the authorization server refused the connection: ${failure}${description ? ` — ${description}` : ""}`);
      }
      if (!code) throw new Error("the authorization server returned no code");
      if (!prev.discovery || !prev.client) throw new Error("this connection's discovery state is missing — start Connect again from settings");

      const tokens = await exchangeAuthorization(prev.discovery.authorizationServerUrl, {
        metadata: prev.discovery.metadata,
        clientInformation: prev.client,
        authorizationCode: code,
        codeVerifier: pending.codeVerifier,
        // The AS checks this for exact equality with the one sent to `/authorize`, so it comes from the
        // pending flow rather than being recomputed from the CURRENT gateway port — a restart between
        // start and callback would otherwise fail the exchange for a reason nothing could explain.
        redirectUri: pending.redirectUri,
        resource: prev.discovery.resource ? new URL(prev.discovery.resource) : undefined,
        fetchFn: this.d.fetchFn,
      });
      redact.add(tokens.access_token, tokens.refresh_token);
      this.write(row.id, {
        client: prev.client,
        discovery: prev.discovery,
        tokens: withExpiry(tokens),
        // A completed connection is what clears `reconnectNeeded` — this is the only path that does, and
        // `pending` is already gone from the burn above.
        reconnectNeeded: false,
      });
      this.d.onStatus?.(row.id);
      return { serverId: row.id };
    } catch (err) {
      throw redact.wrap("MCP_OAUTH_FAILED", err, `could not finish connecting "${row.name}"`);
    }
  }

  /**
   * The hub's `authHeaders` seam. Returns `{}` for a row with no OAuth connection (its `row.secrets`
   * still apply on their own), a Bearer header for a live one, and throws — sanitized — for a row that
   * needs the user's attention.
   *
   * `Bearer` is written literally rather than echoing the stored `token_type`: the MCP authorization
   * spec mandates bearer, and interpolating a server-supplied word into a header value is a needless
   * injection surface.
   */
  async headers(row: McpServerRow): Promise<Record<string, string>> {
    const state = readOauthState(row.oauthJson);
    // Checked FIRST, in the same order as `oauthStatusOf`, so what this seam does can never disagree
    // with what the badge says. Fail fast while flagged, WITHOUT touching the token endpoint: a refresh
    // that already failed will keep failing, and every hub reconnect attempt would otherwise be another
    // request at an authorization server that has said no — a refresh storm the user cannot see or stop.
    if (state.reconnectNeeded) throw reconnectError(row.name);
    if (!state.tokens) return {};

    const tokens = state.tokens;
    if (!isExpired(tokens)) return bearer(tokens.access_token);

    const redact = new Redactor();
    redact.add(state.client?.client_secret, tokens.access_token, tokens.refresh_token);
    if (!tokens.refresh_token || !state.discovery || !state.client) {
      // Nothing to refresh WITH — an access token that expired with no refresh token is simply over.
      this.markReconnectNeeded(row.id, state);
      throw reconnectError(row.name);
    }
    try {
      const next = await refreshAuthorization(state.discovery.authorizationServerUrl, {
        metadata: state.discovery.metadata,
        clientInformation: state.client,
        refreshToken: tokens.refresh_token,
        resource: state.discovery.resource ? new URL(state.discovery.resource) : undefined,
        fetchFn: this.d.fetchFn,
      });
      redact.add(next.access_token, next.refresh_token);
      this.write(row.id, { ...state, tokens: withExpiry(next) });
      return bearer(next.access_token);
    } catch (err) {
      this.markReconnectNeeded(row.id, state);
      // The upstream reason is carried through (a 401 reads very differently from a DNS failure) but
      // scrubbed first — `parseErrorResponse` copies an unrecognized error body into the message
      // verbatim, and a token endpoint rejecting a refresh token is exactly the response most likely to
      // quote that token back.
      throw redact.wrap("MCP_OAUTH_RECONNECT", err, reconnectMessage(row.name));
    }
  }

  /** Forget this server's OAuth connection entirely — registration, tokens, any pending flow. The row
   *  itself survives; `oauthStatus` returns to `unconfigured` and the next Connect starts clean. */
  disconnect(serverId: string): void {
    if (!this.d.servers.get(serverId)) throw new NotFoundError("mcp server", serverId);
    this.d.servers.setOauth(serverId, "");
    this.d.onStatus?.(serverId);
  }

  private markReconnectNeeded(serverId: string, state: McpOauthState): void {
    this.write(serverId, { ...state, reconnectNeeded: true });
    this.d.onStatus?.(serverId);
  }

  /** Persist, tolerating a row deleted underneath an in-flight flow. `setOauth` throws `NotFoundError`
   *  for a missing row, and a refresh racing a `mcp.remove` must surface the OAuth problem the caller
   *  was actually asking about (or, for `handleCallback`, a clean failure page) rather than a confusing
   *  "not found" from a write nobody asked for. */
  private write(serverId: string, state: McpOauthState): void {
    try { this.d.servers.setOauth(serverId, JSON.stringify(state)); } catch { /* row deleted mid-flow; nothing to persist to */ }
  }
}

const bearer = (accessToken: string): Record<string, string> => ({ Authorization: `Bearer ${accessToken}` });

/** Absolute expiry from the response's relative `expires_in`. A response without one (some servers
 *  issue non-expiring tokens) stores no `expires_at` and is therefore never proactively refreshed. */
function withExpiry(tokens: OAuthTokens): McpOauthState["tokens"] {
  return tokens.expires_in === undefined ? { ...tokens } : { ...tokens, expires_at: Date.now() + tokens.expires_in * 1000 };
}

const isExpired = (tokens: NonNullable<McpOauthState["tokens"]>): boolean =>
  tokens.expires_at !== undefined && tokens.expires_at - EXPIRY_SKEW_MS <= Date.now();

/**
 * The RFC 8707 resource indicator to send, using the same rule as the SDK's `selectResourceURL`: only
 * when the server actually published protected-resource metadata, and only if what it published covers
 * the URL Realm is calling. Inlined rather than called through `selectResourceURL` because that helper
 * takes a whole `OAuthClientProvider` purely to check for an optional `validateResourceURL` override
 * this class does not have — passing a cast-to-satisfy stub would be less honest than the four lines it
 * saves.
 */
function selectResource(serverUrl: string, resourceMetadata: OAuthProtectedResourceMetadata | undefined): URL | undefined {
  if (!resourceMetadata) return undefined;
  const requested = resourceUrlFromServerUrl(serverUrl);
  if (!checkResourceAllowed({ requestedResource: requested, configuredResource: resourceMetadata.resource })) {
    throw new Error(`this server's protected-resource metadata claims ${resourceMetadata.resource}, which does not cover ${requested.href}`);
  }
  return new URL(resourceMetadata.resource);
}

const reconnectMessage = (name: string): string => `"${name}" needs reconnecting — Connect again in settings`;
const reconnectError = (name: string): RpcError => new RpcError("MCP_OAUTH_RECONNECT", reconnectMessage(name));

/**
 * Scrubs known credential values out of an error message before it becomes an `RpcError` — the
 * mechanism behind this class's "every error is sanitized" contract.
 *
 * Same `≥ 4 chars` floor as `hub.ts`'s `sanitize()`, for the same reason: replacing every occurrence of
 * a two-character value would turn ordinary words into swiss cheese. Values are collected as they
 * become known (a token that only exists after a refresh response is added the moment it is parsed), so
 * a failure at any point in a flow scrubs everything that flow had actually seen by then.
 */
class Redactor {
  private readonly values = new Set<string>();

  add(...values: (string | undefined)[]): void {
    for (const v of values) if (v && v.length >= 4) this.values.add(v);
  }

  wrap(code: string, err: unknown, prefix: string): RpcError {
    // An `RpcError` this class raised itself is already a sanitized, human-addressed sentence — a
    // deliberate refusal ("does not offer dynamic client registration"), not an upstream failure —
    // so it passes through with its own code instead of being wrapped into a vaguer one.
    if (err instanceof RpcError) return err;
    const raw = err instanceof Error ? err.message : String(err);
    let message = raw;
    for (const value of this.values) message = message.split(value).join("[redacted]");
    return new RpcError(code, `${prefix}: ${message}`);
  }
}
