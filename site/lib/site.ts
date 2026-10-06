/**
 * Everything about the site that is a decision rather than a design.
 *
 * Links live here because they are the parts most likely to change independently of the layout.
 */
export const site = {
  name: "Realm",
  domain: "realm.computer",
  tagline: "One workspace for every coding agent, on your Mac.",
  description:
    "Realm gives your coding agents a place to work on your Mac. Every space is in one sidebar, sessions sit side by side with what their agents open, and one MCP gateway keeps your credentials away from the agent.",
  repo: process.env.NEXT_PUBLIC_REPO_URL ?? "https://github.com/31Carlton7/realm",
  x: "https://x.com/31Carlton7",
  /** Carlton's own accounts, as his GitHub profile lists them — the footer's "made by" column. */
  author: {
    name: "Carlton Aikins",
    x: { href: "https://x.com/31carlton7", handle: "@31carlton7" },
    linkedin: { href: "https://www.linkedin.com/in/carltonaikins", handle: "carltonaikins" },
    github: { href: "https://github.com/31Carlton7", handle: "31Carlton7" },
    site: { href: "https://carltonaikins.com", handle: "carltonaikins.com" },
  },
} as const

/** Where the download button lands when GitHub cannot be asked for the current release. */
export const releasesUrl = `${site.repo}/releases`
