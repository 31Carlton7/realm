/**
 * Everything about the site that is a decision rather than a design.
 *
 * Links live here because they are the parts most likely to change independently of the layout.
 */
export const site = {
  name: "Realm",
  domain: "realm.computer",
  tagline: "A local-first control plane for coding agents.",
  description:
    "Realm gives every coding agent a space on your Mac: split panes for sessions, terminals, browsers and documents, a shared context pool, and one MCP gateway that keeps your credentials out of the agent.",
  repo: process.env.NEXT_PUBLIC_REPO_URL ?? "https://github.com/31Carlton7/realm",
  x: "https://x.com/31Carlton7",
} as const

/** Where the download button lands when GitHub cannot be asked for the current release. */
export const releasesUrl = `${site.repo}/releases`
