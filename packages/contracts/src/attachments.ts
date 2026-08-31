import { AGENT_META } from "./presets";
import type { AgentKind } from "./entities";

/**
 * Ceiling on a single attachment, enforced twice on purpose.
 *
 * The Claude adapter throws above it (an inlined base64 block is the one path that actually has to
 * fit in a request), and the prompter refuses above it before the file is ever attached — a message
 * that dies in the adapter after the user pressed send is the failure this constant exists to avoid.
 *
 * The prompter applies it to EVERY kind, not just Claude's inline path, because a session's agent is
 * switchable right up to its first event: a 30 MB screenshot attached to a Codex session and then
 * moved to Claude would otherwise become an error at send time, with the file already in the chip row.
 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Human size for the chip tooltip and the "too large" refusal. Binary units, matching the cap. */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** What travels on `sessions.send` and lands in the `user_message` event. */
export type Attachment = { path: string; mime: string };

export const isImageMime = (mime: string): boolean => mime.startsWith("image/");

/** Extension → mime. Deliberately not a dependency: the adapters only branch on `image/`, and the
 *  rest of the map exists so a chip can say "PDF" rather than "file". Unknown → octet-stream. */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif", heic: "image/heic", ico: "image/x-icon",
  tiff: "image/tiff", tif: "image/tiff",
  pdf: "application/pdf", json: "application/json", zip: "application/zip", gz: "application/gzip",
  txt: "text/plain", log: "text/plain", md: "text/markdown", markdown: "text/markdown",
  csv: "text/csv", tsv: "text/tab-separated-values", html: "text/html", htm: "text/html",
  css: "text/css", xml: "text/xml", yml: "text/yaml", yaml: "text/yaml", toml: "text/toml",
  ts: "text/typescript", tsx: "text/typescript", js: "text/javascript", jsx: "text/javascript",
  py: "text/x-python", rs: "text/x-rust", go: "text/x-go", rb: "text/x-ruby", java: "text/x-java",
  c: "text/x-c", h: "text/x-c", cpp: "text/x-c++", sh: "text/x-shellscript", sql: "text/x-sql",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4",
};

export const DEFAULT_MIME = "application/octet-stream";

/** Mime from a path's extension. Case-insensitive; a dotfile or extensionless name is octet-stream. */
export function mimeForPath(path: string): string {
  const name = basenameOf(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return DEFAULT_MIME;
  return MIME_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? DEFAULT_MIME;
}

/** Last path segment, for both separators — the renderer has no `node:path`. */
export function basenameOf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/**
 * What an agent actually does with an attachment.
 *
 * - `inline` — the file's bytes are put in the request (Claude's base64 image blocks).
 * - `path`   — the agent is handed the path and reads the file itself (Codex: `localImage` for images,
 *              an "Attached files:" list in the message text for everything else).
 * - `link`   — the agent is handed a `file://` resource link (ACP). Images MAY be inlined instead when
 *              the agent advertises `promptCapabilities.image`, but a link is the guaranteed floor and
 *              Realm cannot know which it will be until the agent has connected — so a link is what we
 *              promise.
 * - `ignored`— the file never reaches the agent at all. Claude's adapter skips non-images outright, and
 *              the scripted `fake` adapter reads no attachments.
 *
 * This table MIRRORS the adapters; it does not govern them. The divergence between the three is
 * deliberate (each protocol wants something different), so the point of naming it here is that the
 * prompter can tell the user which one they are getting BEFORE they press send.
 */
export type AttachmentDisposition = "inline" | "path" | "link" | "ignored";

const DISPOSITIONS = {
  // claude-adapter.ts: images become base64 blocks; non-images hit a bare `continue`.
  claude: { image: "inline", other: "ignored" },
  // codex-adapter.ts: `{ type: "localImage", path }`; non-images are appended to the text as paths.
  codex: { image: "path", other: "path" },
  // acp-adapter.ts: `resource_link` unless the agent advertised image support.
  "acp:gemini": { image: "link", other: "link" },
  "acp:cursor": { image: "link", other: "link" },
  // fake-adapter.ts never looks at `attachments`.
  fake: { image: "ignored", other: "ignored" },
} as const satisfies Record<AgentKind, { image: AttachmentDisposition; other: AttachmentDisposition }>;

export function attachmentDisposition(kind: AgentKind, mime: string): AttachmentDisposition {
  const row = DISPOSITIONS[kind];
  return isImageMime(mime) ? row.image : row.other;
}

/** One sentence naming the agent and what it will do — the chip's tooltip and the prompter's note row.
 *  Always names the agent, so a note rendered for the wrong session is visibly wrong. */
export function attachmentNote(kind: AgentKind, mime: string): string {
  const label = AGENT_META[kind].label;
  switch (attachmentDisposition(kind, mime)) {
    case "inline": return `${label} reads image attachments inline.`;
    case "path": return `${label} gets the file path in your message and opens the file itself.`;
    case "link": return `${label} gets a link to the file and opens it itself.`;
    case "ignored": return isImageMime(mime)
      ? `${label} ignores attachments — it will never see this file.`
      : `${label} ignores non-image attachments — it will never see this file.`;
  }
}

/** Worst news first: a file that will be dropped outranks one that merely has to be opened. */
const NOTICE_ORDER: AttachmentDisposition[] = ["ignored", "link", "path", "inline"];

/**
 * The prompter's note rows: one line per distinct disposition among the pending attachments, naming
 * the files it covers. Grouped rather than per-chip so four screenshots do not print the same sentence
 * four times — but never collapsed to a single line, because "inlined" and "dropped" in the same batch
 * is exactly the case the user must be able to see.
 */
export function attachmentSummary(kind: AgentKind, attachments: readonly Attachment[]): { disposition: AttachmentDisposition; note: string; files: string[] }[] {
  const groups = new Map<AttachmentDisposition, { disposition: AttachmentDisposition; note: string; files: string[] }>();
  for (const a of attachments) {
    const disposition = attachmentDisposition(kind, a.mime);
    const g = groups.get(disposition) ?? { disposition, note: attachmentNote(kind, a.mime), files: [] };
    g.files.push(basenameOf(a.path));
    groups.set(disposition, g);
  }
  return NOTICE_ORDER.filter((d) => groups.has(d)).map((d) => groups.get(d)!);
}
