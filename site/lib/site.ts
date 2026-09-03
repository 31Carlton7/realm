/**
 * Everything about the site that is a decision rather than a design.
 *
 * Links live here because they are the parts most likely to change independently of the layout —
 * the repository is private today, so `repo` currently 404s for anyone without access. Point it
 * somewhere else (or set `NEXT_PUBLIC_REPO_URL`) the day that changes and nothing else needs editing.
 */
export const site = {
  name: "Realm",
  domain: "realm.sh",
  tagline: "A local-first control plane for coding agents.",
  description:
    "Realm gives every coding agent a space on your Mac: split panes for sessions, terminals, browsers and artifacts, a shared context pool, and one MCP gateway that keeps your credentials out of the agent.",
  repo: process.env.NEXT_PUBLIC_REPO_URL ?? "https://github.com/31Carlton7/realm",
} as const

export const nav = [
  { href: "/#product", label: "Product" },
  { href: "/#stack", label: "Stack" },
  { href: "/docs", label: "Docs" },
] as const

export const docsNav = [
  {
    title: "Start here",
    items: [
      { href: "/docs", label: "Overview" },
      { href: "/docs/getting-started", label: "Getting started" },
    ],
  },
  {
    title: "Concepts",
    items: [
      { href: "/docs/spaces-and-panes", label: "Spaces & panes" },
      { href: "/docs/sessions", label: "Agent sessions" },
      { href: "/docs/mcp-gateway", label: "MCP gateway" },
    ],
  },
  {
    title: "Reference",
    items: [
      { href: "/docs/skills", label: "Skills" },
      { href: "/docs/packaging", label: "Packaging & updates" },
    ],
  },
] as const
