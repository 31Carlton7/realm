import type { LinkService } from "./links";

/**
 * The apps Realm can connect a space to in one click: each a vendor's OWN remote MCP server, reached
 * over streamable HTTP with OAuth, so there is nothing to install and no token to paste. Connecting
 * one creates an MCP server row exactly as the "Add server" form would and starts the OAuth flow;
 * from then on it is an ordinary server in the list, with the same tools policy and activity log.
 *
 * Endpoints are the vendors' published ones (checked 2026-09-09). They are data, not code: when a
 * vendor moves, the URL moves here and nothing else changes. `link` names which pasted URLs this
 * connection gives the agent context for — the reason the marketplace and the prompter's link
 * chips are one feature.
 */
export type Connector = {
  id: string;
  name: string;
  /** What the agent can do with it, in one line. */
  blurb: string;
  /** The brand mark, from `@realm/ui`'s brand set. */
  icon: string;
  url: string;
  transport: "http" | "sse";
  /** The vendor's page about the server. */
  docs: string;
  /** The link service this connection answers for, when there is one. */
  link?: LinkService;
  /**
   * How the client is registered with the vendor's authorization server. `dynamic` (the default)
   * is RFC 7591 registration at first connect, which needs nothing from the user. `app` means the
   * vendor issues no client on the fly: the user creates an app of their own in the vendor's
   * console and pastes its client id and secret, and the callback goes through Realm's HTTPS relay
   * (`OAUTH_RELAY_URL`) because such vendors also refuse a loopback `http://` redirect.
   */
  oauth?: "dynamic" | "app";
  /** For `oauth: "app"`: where to create the app, and what to set there, in one line each. */
  app?: { url: string; steps: string[] };
};

/**
 * The HTTPS callback vendors without dynamic registration are given. It is a stateless bounce on
 * the site: the `state` Realm sends carries the gateway's loopback port ahead of the nonce, and the
 * page 302s to `http://127.0.0.1:<port>/oauth/callback` with the code and state intact. The site
 * and the server both read `relayTarget`, so the two cannot disagree about the shape.
 */
export const OAUTH_RELAY_URL = "https://realm.computer/oauth/callback";

/** `<port>.<nonce>`: the port is what the relay needs; the nonce is what the row is holding. */
export const relayState = (port: number, nonce: string): string => `${port}.${nonce}`;

/** Where a relayed callback goes, or null for a state that names no plausible loopback port. Only
 *  ever a loopback address: the relay is a public page, and it must not be a redirector to anywhere. */
export function relayTarget(state: string | null, code: string | null, error: string | null): string | null {
  const m = /^(\d{4,5})\.[A-Za-z0-9_-]{16,}$/.exec(state ?? "");
  if (!m) return null;
  const port = Number(m[1]);
  if (port < 1024 || port > 65535) return null;
  const u = new URL(`http://127.0.0.1:${port}/oauth/callback`);
  u.searchParams.set("state", state!);
  if (code) u.searchParams.set("code", code);
  if (error) u.searchParams.set("error", error);
  return u.toString();
}

export const CONNECTORS: readonly Connector[] = [
  { id: "linear", name: "Linear", blurb: "Read and update issues, projects and cycles. Paste an issue link and the agent has it.",
    icon: "linear", url: "https://mcp.linear.app/mcp", transport: "http", docs: "https://linear.app/docs/mcp", link: "linear" },
  { id: "notion", name: "Notion", blurb: "Search and read pages and databases, and write back.",
    icon: "notion", url: "https://mcp.notion.com/mcp", transport: "http", docs: "https://developers.notion.com/docs/mcp", link: "notion" },
  // Slack issues no client on the fly and refuses a loopback redirect (docs.slack.dev/ai/mcp-server,
  // checked 2026-09-09): a Slack app of the user's own, and the site's HTTPS relay for the callback.
  { id: "slack", name: "Slack", blurb: "Read channels and threads, search messages, post as you.",
    icon: "slack", url: "https://mcp.slack.com/mcp", transport: "http", docs: "https://docs.slack.dev/ai/mcp-server/", link: "slack",
    oauth: "app", app: { url: "https://api.slack.com/apps", steps: [
      "Create an app in your workspace (From scratch).",
      `Under OAuth & Permissions, add the redirect URL ${OAUTH_RELAY_URL}.`,
      "Copy the Client ID and Client Secret from Basic Information.",
      "Install the app to the workspace, or have an admin approve it.",
    ] } },
  { id: "github", name: "GitHub", blurb: "Issues, pull requests, code search and Actions on your repositories.",
    icon: "github", url: "https://api.githubcopilot.com/mcp/", transport: "http", docs: "https://docs.github.com/en/copilot/how-tos/context/model-context-protocol/using-the-github-mcp-server", link: "github" },
  { id: "atlassian", name: "Jira & Confluence", blurb: "Jira issues and boards, Confluence pages, through Atlassian's own server.",
    icon: "jira", url: "https://mcp.atlassian.com/v1/mcp", transport: "http", docs: "https://support.atlassian.com/atlassian-rovo-mcp-server/", link: "jira" },
  { id: "figma", name: "Figma", blurb: "Read designs, components and variables straight from a file link.",
    icon: "figma", url: "https://mcp.figma.com/mcp", transport: "http", docs: "https://help.figma.com/hc/en-us/articles/32132100833559", link: "figma" },
  { id: "sentry", name: "Sentry", blurb: "Issues, stack traces and releases, so an error link is a starting point.",
    icon: "sentry", url: "https://mcp.sentry.dev/mcp", transport: "http", docs: "https://docs.sentry.io/product/sentry-mcp/", link: "sentry" },
];

export const connectorById = (id: string): Connector | undefined => CONNECTORS.find((c) => c.id === id);

/** The MCP server name a connector registers under: `McpServerNameSchema`-safe and stable, so the
 *  page can tell "connected" by name rather than by guessing at URLs someone may have edited. */
export const connectorServerName = (c: Connector): string => `realm-${c.id}`;
