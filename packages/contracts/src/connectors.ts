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
};

export const CONNECTORS: readonly Connector[] = [
  { id: "linear", name: "Linear", blurb: "Read and update issues, projects and cycles. Paste an issue link and the agent has it.",
    icon: "linear", url: "https://mcp.linear.app/mcp", transport: "http", docs: "https://linear.app/docs/mcp", link: "linear" },
  { id: "notion", name: "Notion", blurb: "Search and read pages and databases, and write back.",
    icon: "notion", url: "https://mcp.notion.com/mcp", transport: "http", docs: "https://developers.notion.com/docs/mcp", link: "notion" },
  { id: "slack", name: "Slack", blurb: "Read channels and threads, search messages, post as you.",
    icon: "slack", url: "https://mcp.slack.com/mcp", transport: "http", docs: "https://api.slack.com/mcp", link: "slack" },
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
