import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";

/**
 * A real (if tiny) OAuth 2.1 authorization server + protected resource, over real loopback HTTP, for
 * `oauth.test.ts`. It exists because the SDK's auth helpers do the whole flow over `fetch`, so the only
 * way to test Realm's orchestration of them without stubbing out the very code under test is to give
 * them something to actually talk to.
 *
 * It is deliberately strict where a permissive stub would let a bug pass:
 * - `/authorize` refuses an unknown `client_id`, a mismatched `redirect_uri`, or a challenge that is not
 *   S256, and remembers the challenge it was given.
 * - `/token` verifies the presented `code_verifier` against that stored challenge — real PKCE, so a test
 *   asserting the flow works is asserting the S256 binding works, not that a string was echoed.
 * - authorization codes are single-use.
 *
 * Endpoints: `/.well-known/oauth-protected-resource[/*]` (RFC 9728), `/.well-known/oauth-authorization-server`
 * (RFC 8414), `POST /register` (RFC 7591), `POST /token`. `/authorize` is not served over HTTP — no test
 * drives a browser — but `authorize()` below performs the same validation in-process and returns the URL
 * the browser would have been redirected to.
 */
export type StubAuthServerOptions = {
  /** Omit the RFC 9728 document, forcing the SDK's fallback of treating the server URL as the AS. */
  protectedResourceMetadata?: boolean;
  /** Omit `registration_endpoint`, so a first-time connection has no way to obtain a client. */
  dynamicRegistration?: boolean;
  /** Seconds until an issued access token expires. `null` issues a token with no `expires_in` at all. */
  accessTokenTtlSec?: number | null;
  /** Issue a refresh token alongside the access token. */
  refreshTokens?: boolean;
  /** Scopes advertised on the protected-resource document. */
  scopes?: string[];
  /** Advertised `response_types_supported`. Set to something without `"code"` to make the SDK's
   *  `startAuthorization` reject the server as incompatible AFTER registration has already happened. */
  responseTypes?: string[];
};

export type StubAuthServer = {
  /** Origin of this stub, e.g. `http://127.0.0.1:54321`. Doubles as the MCP resource URL. */
  readonly url: string;
  /** Every `/token` request seen, newest last — the counter refresh-storm assertions read. */
  readonly tokenRequests: { grant_type: string; params: Record<string, string> }[];
  /** Every successful `POST /register`. */
  readonly registrations: { client_id: string; body: Record<string, unknown> }[];
  /**
   * Stand in for the user's browser: validate an authorization URL exactly as `/authorize` would, mint a
   * code for it, and return the redirect URL the browser would land on. Throws if the URL is not one a
   * conforming client would have produced.
   */
  authorize(authUrl: string): string;
  /** Make the NEXT `n` `/token` requests fail with this status and raw body. The body is arbitrary text
   *  on purpose: the sanitization test hands it one that echoes the refresh token back. */
  failTokenNext(n: number, status: number, body: string): void;
  /** The access token most recently issued, so a test can force it to look expired or assert on it. */
  lastIssuedAccessToken(): string | null;
  close(): Promise<void>;
};

const s256 = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

export async function makeStubAuthServer(opts: StubAuthServerOptions = {}): Promise<StubAuthServer> {
  const withPrm = opts.protectedResourceMetadata ?? true;
  const withDcr = opts.dynamicRegistration ?? true;
  const ttl = opts.accessTokenTtlSec === undefined ? 3600 : opts.accessTokenTtlSec;
  const withRefresh = opts.refreshTokens ?? true;
  const scopes = opts.scopes ?? ["mcp:tools"];
  const responseTypes = opts.responseTypes ?? ["code"];

  const clients = new Map<string, { redirectUris: string[]; secret?: string }>();
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  const refreshTokens = new Set<string>();
  const tokenRequests: { grant_type: string; params: Record<string, string> }[] = [];
  const registrations: { client_id: string; body: Record<string, unknown> }[] = [];
  let forcedFailures: { remaining: number; status: number; body: string } | null = null;
  let lastAccessToken: string | null = null;
  let base = "";

  const issueTokens = (): Record<string, unknown> => {
    lastAccessToken = `at_${randomBytes(12).toString("hex")}`;
    const body: Record<string, unknown> = { access_token: lastAccessToken, token_type: "Bearer" };
    if (ttl !== null) body.expires_in = ttl;
    if (withRefresh) {
      const rt = `rt_${randomBytes(12).toString("hex")}`;
      refreshTokens.add(rt);
      body.refresh_token = rt;
    }
    return body;
  };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const readBody = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  };

  const handleToken = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const params = Object.fromEntries(new URLSearchParams(await readBody(req)));
    tokenRequests.push({ grant_type: params.grant_type ?? "", params });
    // Recorded BEFORE the forced-failure check so "did it try again?" assertions count attempts, not
    // successes — which is the whole point of the no-refresh-storm test.
    if (forcedFailures && forcedFailures.remaining > 0) {
      forcedFailures.remaining -= 1;
      res.writeHead(forcedFailures.status, { "Content-Type": "application/json" });
      res.end(forcedFailures.body);
      return;
    }
    if (params.grant_type === "authorization_code") {
      const entry = codes.get(params.code ?? "");
      // Single-use: deleted the moment it is looked up, so a replayed code fails even when everything
      // else about the request is valid.
      if (params.code) codes.delete(params.code);
      if (!entry) return json(res, 400, { error: "invalid_grant", error_description: "unknown or already-used code" });
      if (!params.code_verifier || s256(params.code_verifier) !== entry.challenge) {
        return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      }
      if (params.redirect_uri !== entry.redirectUri) {
        return json(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
      }
      return json(res, 200, issueTokens());
    }
    if (params.grant_type === "refresh_token") {
      if (!params.refresh_token || !refreshTokens.has(params.refresh_token)) {
        return json(res, 400, { error: "invalid_grant", error_description: "unknown refresh token" });
      }
      refreshTokens.delete(params.refresh_token);
      return json(res, 200, issueTokens());
    }
    return json(res, 400, { error: "unsupported_grant_type" });
  };

  const server: HttpServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", base);
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        if (!withPrm) return json(res, 404, { error: "not_found" });
        return json(res, 200, { resource: base, authorization_servers: [base], scopes_supported: scopes });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          ...(withDcr ? { registration_endpoint: `${base}/register` } : {}),
          response_types_supported: responseTypes,
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: scopes,
        });
      }
      if (url.pathname === "/register" && req.method === "POST") {
        if (!withDcr) return json(res, 404, { error: "not_found" });
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const clientId = `client_${randomBytes(8).toString("hex")}`;
        const redirectUris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]) : [];
        clients.set(clientId, { redirectUris });
        registrations.push({ client_id: clientId, body });
        return json(res, 201, { client_id: clientId, redirect_uris: redirectUris, client_id_issued_at: Math.floor(Date.now() / 1000) });
      }
      if (url.pathname === "/token" && req.method === "POST") return handleToken(req, res);
      // The OIDC discovery fallback the SDK tries after OAuth metadata, and anything else.
      json(res, 404, { error: "not_found" });
    })().catch(() => {
      if (!res.headersSent) json(res, 500, { error: "stub_failure" });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  return {
    get url() { return base; },
    tokenRequests,
    registrations,
    authorize(authUrl) {
      const url = new URL(authUrl);
      const p = url.searchParams;
      const clientId = p.get("client_id") ?? "";
      const client = clients.get(clientId);
      if (!client) throw new Error(`stub AS: unknown client_id ${clientId}`);
      const redirectUri = p.get("redirect_uri") ?? "";
      if (!client.redirectUris.includes(redirectUri)) throw new Error(`stub AS: redirect_uri ${redirectUri} was not registered`);
      if (p.get("response_type") !== "code") throw new Error("stub AS: response_type must be code");
      if (p.get("code_challenge_method") !== "S256") throw new Error("stub AS: code_challenge_method must be S256");
      const challenge = p.get("code_challenge");
      if (!challenge) throw new Error("stub AS: no code_challenge");
      const code = `code_${randomBytes(12).toString("hex")}`;
      codes.set(code, { challenge, redirectUri, clientId });
      const redirect = new URL(redirectUri);
      redirect.searchParams.set("code", code);
      const state = p.get("state");
      if (state) redirect.searchParams.set("state", state);
      return redirect.toString();
    },
    failTokenNext(n, status, body) { forcedFailures = { remaining: n, status, body }; },
    lastIssuedAccessToken: () => lastAccessToken,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
