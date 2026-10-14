/**
 * Authorization servers that issue no client on the fly (no RFC 7591 registration endpoint), and the
 * other ways Realm can get a bearer token for them. A short table on purpose: an entry earns its place
 * only when there is a sign-in a person already has (a vendor CLI) or one Realm can run without a
 * registered redirect (the device flow). Every server, listed here or not, can still take a pasted
 * token or the client id and secret of an app the user registered.
 */
export type KnownProvider = {
  id: string;
  /** The vendor's name, as the sign-in sheet says it. */
  name: string;
  /** Hosts of MCP servers this vendor runs, matched before any discovery request. */
  hosts: string[];
  /** Hosts of the vendor's authorization server, matched against what discovery found. */
  authHosts: string[];
  /** A CLI whose existing sign-in Realm can borrow. */
  cli?: { name: string };
  /** RFC 8628 device authorization. Offered only while `clientId` is set. */
  device?: { codeUrl: string; tokenUrl: string; clientId: string; scope: string };
  /** Where to create a personal access token, and which scopes the server's tools want. */
  token: { url: string; scopes: string };
};

/**
 * TODO: Realm has no GitHub OAuth App yet, so the device-flow sign-in stays hidden. To turn it on,
 * register one (see docs/dev/getting-started.md, "GitHub sign-in for MCP"), tick "Enable Device Flow",
 * and put its client id here. A client id is public — the device flow sends no secret — so it ships in
 * the source. `REALM_GITHUB_CLIENT_ID` overrides it for a local build trying one out.
 */
export const GITHUB_OAUTH_CLIENT_ID = process.env.REALM_GITHUB_CLIENT_ID ?? "";

/** What GitHub's MCP server's tools reach: repositories, the orgs they belong to, and Actions. */
const GITHUB_SCOPES = "repo read:org workflow";

export const KNOWN_PROVIDERS: readonly KnownProvider[] = [
  {
    id: "github",
    name: "GitHub",
    hosts: ["api.githubcopilot.com", "github.com", "api.github.com"],
    authHosts: ["github.com"],
    cli: { name: "GitHub CLI" },
    device: { codeUrl: "https://github.com/login/device/code", tokenUrl: "https://github.com/login/oauth/access_token", clientId: GITHUB_OAUTH_CLIENT_ID, scope: GITHUB_SCOPES },
    token: { url: `https://github.com/settings/tokens/new?description=Realm&scopes=${GITHUB_SCOPES.replaceAll(" ", ",")}`, scopes: GITHUB_SCOPES },
  },
];

/** The known provider behind this server, by its own host or, once discovery has run, by its
 *  authorization server's. Never by the row's name, which the user chose. */
export function providerFor(serverUrl: string, authorizationServerUrl?: string, providers: readonly KnownProvider[] = KNOWN_PROVIDERS): KnownProvider | null {
  const host = hostOf(serverUrl);
  const authHost = authorizationServerUrl ? hostOf(authorizationServerUrl) : null;
  return providers.find((p) => (host !== null && p.hosts.includes(host)) || (authHost !== null && p.authHosts.includes(authHost))) ?? null;
}

const hostOf = (url: string): string | null => {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
};
