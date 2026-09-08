import { basenameOf, isImageMime, mimeForPath } from "@realm/contracts";
import type { Block } from "./transcript-model";

/**
 * What a session PRODUCED, what it was GIVEN, and what it PROPOSED — the three questions a transcript
 * can answer but cannot show, because each answer is scattered down a log the reader has to scroll.
 *
 * Everything here is derived from blocks the transcript already holds. Nothing is fetched, nothing is
 * remembered across sessions, and nothing is inferred from prose except where the rule says so and
 * says why. The point is a summary that cannot disagree with the transcript it summarises: re-derive
 * it and you get the same list, because the list IS the transcript read a second way.
 */

/** One artefact the session produced. */
export type Output =
  /** A file a tool wrote or edited. `path` is what the tool was given, verbatim. */
  | { kind: "file"; path: string; name: string; media: MediaKind; ts: number }
  /** A link the agent's own prose offered, which no tool in this session fetched. */
  | { kind: "url"; url: string; host: string; ts: number };

/** A file the USER handed the session — an attachment on a sent message. */
export type Upload = { path: string; name: string; mime: string; ts: number };

/** A plan the agent proposed, in the shape the block carried it. */
export type PlanEntry = { planId: string; text: string; steps: readonly { text: string; status: string }[]; ts: number };

export type SessionSummary = { outputs: Output[]; uploads: Upload[]; plans: PlanEntry[] };

/** How an output should be OPENED, which is the only reason its type matters here. */
export type MediaKind = "image" | "video" | "file";

export function mediaKindOf(path: string): MediaKind {
  const mime = mimeForPath(path);
  if (isImageMime(mime)) return "image";
  return mime.startsWith("video/") ? "video" : "file";
}

/**
 * Tools that CHANGE a file, keyed by the bare name.
 *
 * `Read`, `Glob` and `Grep` are deliberately absent: reading a file is not producing one, and a
 * session that read forty files to answer a question has produced nothing. That distinction is the
 * whole value of the list — a "files touched" tally would be the transcript again, only longer.
 */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);

/** Tools whose input carries a url the agent RETRIEVED — the same set `message-sources.ts` trusts,
 *  and for the same reason: the url is structured data there rather than something parsed out of a
 *  sentence. A page the session fetched is not a page it produced. */
const FETCH_TOOLS = new Set(["WebFetch", "browser_open", "browser_navigate"]);

/** MCP tools reach the transcript fully prefixed (`mcp__<server>__realm-browser__browser_open`);
 *  nothing in the renderer normalises them, so the bare name has to be recovered here. */
const bareToolName = (name: string): string => {
  const at = name.lastIndexOf("__");
  return at < 0 ? name : name.slice(at + 2);
};

/** The path a write-shaped tool was pointed at, or null when the payload does not name one. */
export function writtenPath(name: string, input: Record<string, unknown>): string | null {
  const str = (k: string) => (typeof input[k] === "string" && input[k] ? (input[k] as string) : null);
  if (name === "apply_patch") {
    // Codex's envelope: `changes` is a list, and each entry names its own path. Only the first is
    // taken — one row per CALL keeps the list readable, and the card in the transcript is where a
    // reader goes for the rest.
    const changes = input["changes"];
    const first = Array.isArray(changes) ? changes[0] : null;
    const path = first && typeof first === "object" ? (first as Record<string, unknown>)["path"] : null;
    return typeof path === "string" && path ? path : null;
  }
  return str("file_path") ?? str("notebook_path") ?? str("path");
}

/** http(s) links in a run of prose, in the order they appear. Bare urls and markdown targets alike;
 *  trailing sentence punctuation is trimmed, because "see https://x.test/a." names no such page. */
export function linksIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>()[\]"'`]+/g)) out.push(m[0]!.replace(/[.,;:!?]+$/, ""));
  return out;
}

const hostOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.host.replace(/^www\./, "");
  } catch { return null; }
};

/**
 * Fold a transcript into its summary.
 *
 * Ordering is newest-first throughout, because the question is nearly always "what did it just make".
 * Each list is deduped by identity — a file edited nine times is one artefact, not nine — and keeps
 * the LATEST timestamp for it, which is what "newest first" has to mean for a thing that was touched
 * more than once.
 *
 * The url rule is the only one that reads prose, and it is narrowed twice over. A link is an output
 * only when the agent typed it AND no tool in the session fetched it: the first half is what makes it
 * the agent's own (a fetched page is something it read, and belongs to `MessageSources` on the message
 * that read it), the second is what keeps a docs page the agent both cited and opened out of a list
 * headed "what this session made". Streaming messages are skipped — half a url is a different url.
 */
export function summarize(blocks: readonly Block[]): SessionSummary {
  const fetched = new Set<string>();
  for (const b of blocks) {
    if (b.kind !== "tool" || !FETCH_TOOLS.has(bareToolName(b.name))) continue;
    const url = b.input["url"];
    if (typeof url === "string") fetched.add(url);
  }

  const outputs = new Map<string, Output>();
  const uploads = new Map<string, Upload>();
  const plans: PlanEntry[] = [];

  for (const b of blocks) {
    switch (b.kind) {
      case "tool": {
        if (!WRITE_TOOLS.has(bareToolName(b.name))) break;
        // A call still in flight, or one that came back an error, produced nothing. Reporting a
        // failed Write as an output is the single most misleading row this list could carry.
        if (!b.result || b.result.isError) break;
        const path = writtenPath(bareToolName(b.name), b.input);
        if (!path) break;
        outputs.set(`file:${path}`, { kind: "file", path, name: basenameOf(path), media: mediaKindOf(path), ts: b.ts });
        break;
      }
      case "assistant": {
        if (b.streaming) break;
        for (const url of linksIn(b.text)) {
          if (fetched.has(url)) continue;
          const host = hostOf(url);
          if (!host) continue;
          outputs.set(`url:${url}`, { kind: "url", url, host, ts: b.ts });
        }
        break;
      }
      case "user": {
        for (const a of b.attachments ?? []) {
          uploads.set(a.path, { path: a.path, name: basenameOf(a.path), mime: a.mime, ts: b.ts });
        }
        break;
      }
      case "plan": {
        plans.push({ planId: b.planId, text: b.text ?? "", steps: b.steps ?? [], ts: b.ts });
        break;
      }
      default: break;
    }
  }

  const newestFirst = <T extends { ts: number }>(xs: T[]): T[] => [...xs].reverse();
  return {
    outputs: newestFirst([...outputs.values()]),
    uploads: newestFirst([...uploads.values()]),
    plans: newestFirst(plans),
  };
}

/** Nothing to show at all — what the button reads to stay out of the way of a session that has yet
 *  to produce, receive or propose anything. */
export const isEmptySummary = (s: SessionSummary): boolean =>
  s.outputs.length === 0 && s.uploads.length === 0 && s.plans.length === 0;

/** The last exchange: what the user asked, and how the agent answered. */
export type Recap = { asked: string; answered: string } | null;

/** One line of prose, clipped. A recap is a glance, not a re-read — and the first sentence of an
 *  agent's answer is reliably its verdict, because that is how they are trained to write. */
const firstLine = (text: string, max: number): string => {
  const line = text.split("\n").map((l) => l.replace(/^[#>\-*\s]+/, "").trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/**
 * What this session was about, from its most recent exchange.
 *
 * The three lists say what a session PRODUCED. None of them says what it was for — which is the
 * question a panel titled "Summary" is actually being asked, and the reason the old one read as
 * thin: a filename tells you nothing about why it exists.
 *
 * Derived, never generated. This is the last thing the user asked and the first line of the answer
 * they got, both already on screen; a model-written summary would cost a call, could be wrong, and
 * would be the one thing in this panel that is not simply the transcript rearranged.
 *
 * A message another session delivered is skipped for `asked`, the same as everywhere else: those are
 * a peer's words, and attributing them to the user would be a lie the panel repeats every time it
 * opens.
 */
export function recapOf(blocks: readonly Block[]): Recap {
  let asked = "", answered = "";
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (!answered && b.kind === "assistant" && !b.streaming && b.text.trim()) answered = firstLine(b.text, 160);
    if (!asked && b.kind === "user" && !b.from && b.text.trim()) asked = firstLine(b.text, 120);
    if (asked && answered) break;
  }
  return asked || answered ? { asked, answered } : null;
}
