/**
 * Links to the apps a team works in, read for what they point AT.
 *
 * A pasted Slack permalink is 90 characters of nothing a person can read; what it means is "this
 * thread". The prompter shows that meaning as a chip — the app's mark and a short name — and sends
 * the agent the link itself, which is what the agent's MCP connection to that app can open. This
 * module is the one place a URL is turned into that name, so the chip in the composer and the chip
 * in the transcript cannot disagree about what a link is.
 *
 * Pure, and deliberately conservative: a URL this cannot name is not a chip. Pasting it stays a
 * paste. A wrong name on a chip is worse than the URL, because the URL at least says what it is.
 */
export type LinkService = "slack" | "notion" | "linear" | "github" | "jira" | "figma" | "sentry";

export type LinkRef = { service: LinkService; label: string; url: string };

/** How each service is shown: its mark, and its name. */
export const LINK_SERVICE_META: Record<LinkService, { label: string; icon: LinkService }> = {
  slack: { label: "Slack", icon: "slack" },
  notion: { label: "Notion", icon: "notion" },
  linear: { label: "Linear", icon: "linear" },
  github: { label: "GitHub", icon: "github" },
  jira: { label: "Jira", icon: "jira" },
  figma: { label: "Figma", icon: "figma" },
  sentry: { label: "Sentry", icon: "sentry" },
};

const LABEL_MAX = 48;
const clip = (s: string): string => (s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1).trimEnd()}…` : s);
/** "Card-redesign-and-model-picker" → "Card redesign and model picker". */
const words = (slug: string): string => {
  let s = slug;
  try { s = decodeURIComponent(slug); } catch { /* a stray %: keep the raw slug */ }
  return s.replace(/[-_+]+/g, " ").replace(/\s+/g, " ").trim();
};

/** A Slack permalink's `p1712345678123456` is the message's timestamp with the dot removed. */
const slackTs = (p: string): string => (p.length > 6 ? `${p.slice(0, -6)}.${p.slice(-6)}` : p);

export function describeLink(raw: string): LinkRef | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  const url = u.toString();

  // Slack: <ws>.slack.com/archives/C0123/p1712345678123456 is a message; without the p-part, a channel.
  if (host.endsWith(".slack.com") || host === "slack.com") {
    if (parts[0] === "archives" && parts[1]) {
      const p = parts[2];
      if (p && /^p\d{10,}$/.test(p)) return { service: "slack", label: `Thread ${slackTs(p.slice(1))}`, url };
      return { service: "slack", label: `Channel ${parts[1]}`, url };
    }
    return null;
  }

  // Notion: notion.so/<ws>/<Title-32hex> or notion.site/<Title-32hex>; the title is the slug minus the id.
  // …and app.notion.com/p/<ws>/<Title-id>, the form the app's own "Copy link" produces.
  if (host === "notion.so" || host.endsWith(".notion.so") || host.endsWith(".notion.site") || host === "app.notion.com") {
    const last = parts.at(-1) ?? "";
    const m = /^(?:(.*?)-)?([0-9a-f]{32})$/i.exec(last);
    if (m) return { service: "notion", label: clip(m[1] ? words(m[1]) : "Notion page"), url };
    return parts.length ? { service: "notion", label: clip(words(last)), url } : null;
  }

  // Linear: linear.app/<team>/issue/ENG-123/<slug>; projects and documents by their slug.
  if (host === "linear.app") {
    const at = parts.indexOf("issue");
    if (at >= 0 && parts[at + 1]) return { service: "linear", label: parts[at + 1]!.toUpperCase(), url };
    for (const kind of ["project", "document", "view", "team"]) {
      const i = parts.indexOf(kind);
      if (i >= 0 && parts[i + 1]) return { service: "linear", label: clip(words(parts[i + 1]!.replace(/-[0-9a-f]{8,}$/i, ""))), url };
    }
    return null;
  }

  // GitHub: owner/repo, then #123 for an issue or pull, or a path for a file.
  if (host === "github.com") {
    const [owner, repo, kind, id, ...rest] = parts;
    if (!owner || !repo) return null;
    const name = `${owner}/${repo}`;
    if ((kind === "pull" || kind === "issues") && id && /^\d+$/.test(id)) return { service: "github", label: `${name}#${id}`, url };
    if (kind === "blob" || kind === "tree") { const path = rest.join("/"); return { service: "github", label: clip(path ? `${name} · ${path}` : name), url }; }
    if (kind === "commit" && id) return { service: "github", label: `${name}@${id.slice(0, 7)}`, url };
    return { service: "github", label: name, url };
  }

  // Jira: <site>.atlassian.net/browse/KEY-123, or the board/issue query form; Confluence under /wiki.
  if (host.endsWith(".atlassian.net")) {
    if (parts[0] === "browse" && parts[1]) return { service: "jira", label: parts[1].toUpperCase(), url };
    const key = u.searchParams.get("selectedIssue");
    if (key) return { service: "jira", label: key.toUpperCase(), url };
    if (parts[0] === "wiki") return { service: "jira", label: clip(words(parts.at(-1) ?? "Confluence page")), url };
    return null;
  }

  // Figma: figma.com/(design|file|board|proto|slides)/<key>/<Name>?node-id=…
  if (host === "figma.com") {
    if (["design", "file", "board", "proto", "slides", "deck"].includes(parts[0] ?? "") && parts[1]) {
      const name = parts[2] ? words(parts[2]) : "Figma file";
      const node = u.searchParams.get("node-id");
      return { service: "figma", label: clip(node ? `${name} · ${node.replace("-", ":")}` : name), url };
    }
    return null;
  }

  // Sentry: <org>.sentry.io/issues/123… or sentry.io/organizations/<org>/issues/123
  if (host === "sentry.io" || host.endsWith(".sentry.io")) {
    const at = parts.indexOf("issues");
    if (at >= 0 && parts[at + 1] && /^\d+$/.test(parts[at + 1]!)) return { service: "sentry", label: `Issue ${parts[at + 1]}`, url };
    return null;
  }

  return null;
}
