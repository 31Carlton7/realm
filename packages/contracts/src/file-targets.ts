import { expandHome } from "./attachments";

/**
 * A file as an agent names it, turned into the one file it means.
 *
 * Agents name what they made every way a terminal would accept and several it would not: an absolute
 * path, `~/Downloads/clip.mp4`, `./out/report.md` from wherever the session stands, a `file://` URL
 * with its spaces as `%20`, and an editor's `src/app.ts:42` or `app.ts#L42`. Each surface that acted on
 * one — Reveal in Finder, Open, Quick Look, an agent's `docs_open` — used to take the string as it came,
 * so the line suffix or the URL scheme became part of a filename nobody had, and the action reported
 * that nothing was there. This is the one reading of that string, pure so main, the server and the
 * renderer all agree on it; whether the file exists is still each side's own question.
 */
export type FileTarget = { path: string; line: number | null };

/** `:42`, `:42:7`, `#L42`, `#L42C7`, `#L42-L50` — the ways a line rides on a path. */
const LINE_SUFFIX = /^(.+?)(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/;

/** The path and the line a string names, before any directory is applied. Null for nothing usable:
 *  an empty string, a URL of another scheme, a NUL byte. */
export function parseFileTarget(raw: string): FileTarget | null {
  let t = raw.trim();
  // Quotes and angle brackets are how a path with spaces is written in prose and in Markdown links.
  if (/^(["'`<]).*(["'`>])$/.test(t) && t.length > 2) t = t.slice(1, -1).trim();
  if (t === "" || t.includes("\0")) return null;
  if (/^file:/i.test(t)) {
    let url: URL;
    try { url = new URL(t); } catch { return null; }
    if (url.hostname !== "" && url.hostname !== "localhost") return null;
    let path: string;
    try { path = decodeURIComponent(url.pathname); } catch { return null; }
    const line = /^#L(\d+)/.exec(url.hash)?.[1];
    return path ? { path, line: line ? Number(line) : null } : null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null;
  const m = LINE_SUFFIX.exec(t);
  if (m) {
    const line = m[2] ?? m[3];
    return { path: m[1]!, line: line ? Number(line) : null };
  }
  return { path: t, line: null };
}

/** `/`-joined and normalised the way a filesystem reads it: `.` dropped, `..` climbing, never above
 *  the root. Only for absolute paths. */
function normalizeAbsolute(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { out.pop(); continue; }
    out.push(seg);
  }
  return `/${out.join("/")}`;
}

/**
 * The absolute file a string names, and its line: `~` is `home`, a relative path is relative to `cwd`
 * (where the agent that wrote it was standing), a `file://` URL is its decoded path. Null when the
 * string is not a path, or is relative with no absolute `cwd` to be relative to — resolving against
 * anything else would answer a question nobody asked.
 */
export function resolveFileTarget(raw: string, where: { cwd?: string | null; home: string }): FileTarget | null {
  const target = parseFileTarget(raw);
  if (!target) return null;
  const named = expandHome(target.path, where.home);
  const cwd = where.cwd ?? null;
  const absolute = named.startsWith("/") ? named : cwd && cwd.startsWith("/") ? `${cwd.replace(/\/+$/, "")}/${named}` : null;
  if (absolute === null) return null;
  return { path: normalizeAbsolute(absolute), line: target.line };
}
