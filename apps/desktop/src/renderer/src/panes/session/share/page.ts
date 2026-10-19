import { basenameOf, bareToolName, formatAttachmentSize, isImageMime, mimeForPath } from "@realm/contracts";
import { Marked } from "marked";
import { REALM_MARK_PATH, REALM_MARK_VIEWBOX } from "../../../components/RealmMark";
import { grammarFor, grammarForPath } from "../rich/highlight";
import hljs from "../rich/highlight-grammars";
import type { FileDiff } from "../rich/diff";
import { toolPanel, type ToolPanel } from "../rich/tool-view";
import { formatDuration, groupTranscript, isDelegationLine, isDelegationWait, isHarnessLaunch, runWork, summarizeToolRun, type ToolBlock, type ToolNode } from "../tool-group";
import { editStat, editTarget, failureReason, mcpParts, readTarget, resultEditStat, toolSummary, toolVerb } from "../tool-summary";
import { goalTurnLabel, type Block, type Transcript } from "../transcript-model";
import { hideHomeFolders, scrubSecrets } from "./scrub";
import { DEFAULT_SHARE_OPTIONS, type ShareOptions } from "./options";
import { PAGE_SCRIPT, PAGE_SCRIPT_HASH, pageStyle } from "./style";

/**
 * A session as one web page: a single `.html` file that reads well anywhere it is opened, sent or
 * hosted, and asks the network for nothing.
 *
 * Built from the transcript model the pane draws (`transcript-model.ts`), in the same vocabulary —
 * the prompt a bubble, the answer prose, the work quiet lines that open to their detail, a sub-agent
 * a section that nests — so the page reads as the session did. Pure and DOM-free: the desktop calls
 * it, and nothing in it needs a window, so a website or a phone could call it the same way.
 *
 * Every string in a transcript is untrusted. Nothing here is ever inserted as markup: text is escaped
 * where it is written, Markdown is rendered with raw HTML escaped rather than passed through, a link
 * is drawn only when it parses as http(s) or mailto, and a picture only when it is a raster data URL
 * Realm encoded itself. The page's Content-Security-Policy then allows its own stylesheet, its own
 * script by hash, and data: images — so even a mistake here could not run or fetch anything.
 */

/** A permission prompt and what was decided, out of the session's log — the transcript model keeps
 *  only the prompts still open, so the caller reads these from the events. Null: never answered. */
export type SharedPermission = {
  requestId: string; toolName: string; input: Record<string, unknown>; title: string;
  decision: "allow" | "allow_always" | "deny" | null; ts: number;
};

/** A sub-agent Realm ran as a session of its own (`agent_start`, `agent_run`), with its log. */
export type SharedChild = { title: string; agent: string; transcript: Transcript; permissions: SharedPermission[] };

export type SharedSession = {
  title: string;
  /** The space it was worked in. */
  space: string | null;
  /** Who did the work, as a person would say it: "Claude · Opus 5.5". */
  agent: string;
  transcript: Transcript;
  permissions: SharedPermission[];
  /** Pictures as data: URLs, keyed by the path exactly as the transcript writes it (`sharedImagePaths`). */
  images: Record<string, string>;
  /** Realm's own sub-agents, keyed by the id of the call that started them. */
  children: Record<string, SharedChild[]>;
  /** When the page is made. Passed in so the output is testable. */
  now: number;
};

export type SharePage = {
  html: string;
  /** The title as the page shows it — keys hidden, the home folder written as `~` — for its filename. */
  title: string;
  /** Values hidden because they looked like keys or tokens. */
  hidden: number;
  /** Pictures that were asked for and left out, for their size. */
  imagesLeftOut: number;
};

/** One picture's ceiling inside the page, and all of them together. Realm re-encodes a picture at
 *  1600px before it gets here (main/share-images.ts), so these are a backstop, not the usual case. */
export const IMAGE_CAP_BYTES = 1.5 * 1024 * 1024;
export const IMAGES_CAP_BYTES = 12 * 1024 * 1024;
/** A call's text — a command's output, a file read, a fetched page — past which the page shows the
 *  start and says how much is left. The session has the rest; a page of forty file dumps is unread. */
export const TEXT_CAP = 12_000;
/** A diff's lines per file, by the same reasoning. */
export const DIFF_LINES_CAP = 400;

/** Stands in for a hidden value until the page is assembled, where it becomes the `[hidden]` note.
 *  A private-use character no transcript is allowed to keep (`clean` strips it), so it can only ever
 *  mean what the scrubber put there. */
const SECRET = "\uE000";
const SECRET_NOTE = `<span class="secret" title="Hidden by Realm: it looked like a key or a token">[hidden]</span>`;

/** The only pictures the page will embed: base64 rasters, which is what Realm's encoder writes. An
 *  SVG could carry script, and anything else is not a picture. */
const RASTER = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** For an attribute, or the document's title: no markup may land there, so a hidden value is its word. */
const attr = (s: string): string => esc(s.replaceAll(SECRET, "[hidden]"));

/** The URL a link may point at, normalised, or null. Only the web and mail: `javascript:`, `data:`,
 *  `file:` and every relative path (which means nothing once the page leaves this Mac) are not links.
 *  Parsed rather than prefix-matched, so `java\tscript:` and `JAVASCRIPT:` are read as browsers read
 *  them. */
export function safeUrl(href: string): string | null {
  try {
    const url = new URL(href.trim().replaceAll(SECRET, "[hidden]"));
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.href : null;
  } catch {
    return null;
  }
}

const KEEP_KEYS = new Set(["toolUseId", "parentToolUseId", "messageId", "planId", "requestId", "sessionId", "mime"]);

/** Every string under `v`, through `fn` — except ids, which only ever match each other. */
function mapStrings<T>(v: T, fn: (s: string) => string): T {
  if (typeof v === "string") return fn(v) as T;
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn)) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, KEEP_KEYS.has(k) ? x : mapStrings(x, fn)])) as T;
  }
  return v;
}

/**
 * Every path to a picture the page could show, as the transcript writes it: what was attached, what a
 * call read or wrote that is a picture, and what an answer drew with `![](…)`. The caller reads these
 * from disk and hands them back in `images`; the page looks them up by the same string.
 */
export function sharedImagePaths(t: Transcript): string[] {
  const out = new Set<string>();
  for (const b of t.blocks) {
    if (b.kind === "user") for (const a of b.attachments ?? []) if (isImageMime(a.mime)) out.add(a.path);
    if (b.kind === "tool") {
      const panel = toolPanel(b);
      if (panel?.kind === "media" && isImageMime(mimeForPath(panel.path))) out.add(panel.path);
    }
    if (b.kind === "assistant") for (const m of b.text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?/g)) if (!/^[a-z][a-z0-9+.-]*:/i.test(m[1]!)) out.add(m[1]!);
  }
  return [...out];
}

/** What a session has that a switch in the sheet would change — so a switch is offered only where
 *  flipping it does something. */
export function shareContents(s: SharedSession): { tools: boolean; thinking: boolean; images: boolean; subagents: boolean } {
  const all = [s.transcript, ...Object.values(s.children).flat().map((c) => c.transcript)].flatMap((t) => t.blocks);
  return {
    tools: all.some((b) => b.kind === "tool"),
    thinking: all.some((b) => b.kind === "thinking" && b.text.trim() !== ""),
    images: Object.keys(s.images).length > 0,
    subagents: Object.keys(s.children).length > 0 || s.transcript.blocks.some((b) => b.kind === "tool" && isHarnessLaunch(b)),
  };
}

type Ctx = {
  options: ShareOptions;
  images: Map<string, string>;
  children: Record<string, SharedChild[]>;
  /** What is left of the pictures' allowance, and how many did not fit. */
  room: { bytes: number; leftOut: number };
  /** Messages numbered down the whole page, sub-agents' included, for their anchors. */
  count: { n: number };
  /** The prompts, for the outline beside a wide page — the session's own, not its sub-agents'. */
  prompts: { id: string; text: string }[];
  /** How many sub-agent sessions deep the log being drawn is. */
  depth: number;
  markdown: (src: string) => string;
};

export function buildSharePage(session: SharedSession, options: ShareOptions = DEFAULT_SHARE_OPTIONS): SharePage {
  /** Every string the page draws goes through here first: the stand-in stripped, keys and tokens
   *  hidden, and the home folder written as `~` when asked. */
  const scrub = (s: string): { text: string; hidden: number } => {
    const scrubbed = scrubSecrets(s.replaceAll(SECRET, ""), SECRET);
    return { text: options.hidePaths ? hideHomeFolders(scrubbed.text) : scrubbed.text, hidden: scrubbed.hidden };
  };
  let hidden = 0;
  const clean = (s: string): string => { const r = scrub(s); hidden += r.hidden; return r.text; };

  const ctx: Ctx = {
    options,
    // Looked up by the same cleaned path the transcript's blocks will carry; a key is never shown, so
    // what it hid is not counted.
    images: new Map(Object.entries(session.images).map(([path, data]) => [scrub(path).text, data])),
    children: Object.fromEntries(Object.entries(session.children).map(([id, kids]) => [id, kids.map((k) => ({
      title: clean(k.title), agent: clean(k.agent),
      transcript: { ...k.transcript, blocks: mapStrings(k.transcript.blocks, clean) },
      permissions: mapStrings(k.permissions, clean),
    }))])),
    room: { bytes: IMAGES_CAP_BYTES, leftOut: 0 },
    count: { n: 0 },
    prompts: [],
    depth: 0,
    markdown: () => "",
  };
  ctx.markdown = markdownFor(ctx);

  const title = clean(session.title.trim()) || "Session";
  const space = session.space ? clean(session.space) : null;
  const agent = clean(session.agent);
  const blocks = mapStrings(session.transcript.blocks, clean);
  const permissions = mapStrings(session.permissions, clean);

  const log = renderLog(blocks, permissions, ctx);
  const head = renderHead({ title, space, agent, blocks, children: Object.values(ctx.children).flat() });
  const outline = ctx.prompts.length > 1
    ? `<nav class="outline" aria-label="Prompts"><div class="outline-in"><p class="outline-head">Prompts</p><ol>${ctx.prompts.map((p) => `<li><a href="#${p.id}">${esc(p.text)}</a></li>`).join("")}</ol></div></nav>`
    : "";
  const foot = renderFoot(session.now, hidden);

  const body = [
    `<button type="button" class="theme" hidden>Appearance: auto</button>`,
    `<main class="page">`, head, outline, `<div class="log">${log}</div>`, foot, `</main>`,
  ].join("\n");
  const html = [
    "<!doctype html>",
    `<html lang="en">`,
    "<head>",
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src '${PAGE_SCRIPT_HASH}'; base-uri 'none'; form-action 'none'">`,
    `<meta name="referrer" content="no-referrer">`,
    `<meta name="color-scheme" content="light dark">`,
    `<meta name="generator" content="Realm">`,
    `<title>${attr(title)}</title>`,
    `<style>${pageStyle()}</style>`,
    "</head>",
    `<body>`,
    body.replaceAll(SECRET, SECRET_NOTE),
    `<script>${PAGE_SCRIPT}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
  return { html, title: title.replaceAll(SECRET, "[hidden]"), hidden, imagesLeftOut: ctx.room.leftOut };
}

// ── The head and the foot ─────────────────────────────────────────────────────────────────────

const DAY: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };
const TIME: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

/** "Oct 18, 2026, 2:14 – 3:02 PM", or across days "Oct 18 – Oct 20, 2026". */
export function dateRange(from: number, to: number): string {
  const a = new Date(from), b = new Date(to);
  const sameDay = a.toDateString() === b.toDateString();
  if (sameDay) {
    const day = a.toLocaleDateString("en-US", DAY);
    // ICU writes a narrow no-break space before the meridiem; one ordinary rule for every engine.
    const start = a.toLocaleTimeString("en-US", TIME).replace(/\s/g, " "), end = b.toLocaleTimeString("en-US", TIME).replace(/\s/g, " ");
    if (start === end) return `${day}, ${start}`;
    // "2:02 – 2:08 PM": the meridiem once, where both ends share it.
    const meridiem = / [AP]M$/;
    return `${day}, ${start.match(meridiem)?.[0] === end.match(meridiem)?.[0] ? start.replace(meridiem, "") : start} – ${end}`;
  }
  const sameYear = a.getFullYear() === b.getFullYear();
  return `${a.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : DAY)} – ${b.toLocaleDateString("en-US", DAY)}`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function renderHead(h: { title: string; space: string | null; agent: string; blocks: readonly Block[]; children: readonly SharedChild[] }): string {
  const dated = h.blocks.filter((b) => b.kind !== "unseen-mark" && b.kind !== "retrying");
  const prompts = h.blocks.filter((b) => b.kind === "user").length;
  const messages = prompts + h.blocks.filter((b) => b.kind === "assistant" && b.text.trim()).length;
  // A failover changes who answers mid-session; the head names everyone who did.
  const agents = [h.agent, ...h.blocks.flatMap((b) => (b.kind === "handoff" ? [b.to] : []))]
    .filter((a, i, all) => a && all.indexOf(a) === i);
  const harness = h.blocks.filter((b) => b.kind === "tool" && isHarnessLaunch(b)).length;
  const subagents = h.children.length + harness;
  // The harness's own sub-agents run on the session's agent; Realm's may run on any.
  const kids = [...new Set([...(harness ? [h.agent] : []), ...h.children.map((c) => c.agent)])];
  const facts: [string, string][] = [];
  if (dated.length) facts.push(["Date", dateRange(dated[0]!.ts, dated.at(-1)!.ts)]);
  facts.push([agents.length > 1 ? "Agents" : "Agent", agents.join(", then ")]);
  if (subagents > 0) facts.push([subagents === 1 ? "Sub-agent" : "Sub-agents", `${subagents} on ${kids.join(" and ")}`]);
  facts.push(["Conversation", `${plural(messages, "message")} · ${plural(prompts, "turn")}`]);
  return [
    `<header class="head">`,
    h.space ? `<p class="crumb">${esc(h.space)}</p>` : "",
    `<h1>${esc(h.title)}</h1>`,
    `<dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>`,
    `</header>`,
  ].join("");
}

function renderFoot(now: number, hidden: number): string {
  const mark = `<svg viewBox="${REALM_MARK_VIEWBOX}" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="${REALM_MARK_PATH}"/></svg>`;
  const lines = [`Shared ${new Date(now).toLocaleDateString("en-US", DAY)}`];
  if (hidden > 0) lines.push(`Realm hid ${hidden === 1 ? "a value that looked" : `${hidden} values that looked`} like a key or a token.`);
  return `<footer class="foot"><a class="made" href="https://realm.computer" rel="noopener noreferrer">${mark}Made with Realm</a>${lines.map((l) => `<p>${esc(l)}</p>`).join("")}</footer>`;
}

// ── The log ───────────────────────────────────────────────────────────────────────────────────

/** Inputs as the two halves of a call report them; only key order may differ. */
const stable = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x);

/** Each prompt, on the call it was about: the last call before it with the same tool and input, as
 *  the pane's own `waitingToolIds` pairs them. A prompt no call matches stands on its own line. */
function pairPermissions(blocks: readonly Block[], permissions: readonly SharedPermission[]): { byCall: Map<string, SharedPermission>; loose: SharedPermission[] } {
  const byCall = new Map<string, SharedPermission>();
  const loose: SharedPermission[] = [];
  for (const p of [...permissions].sort((a, b) => a.ts - b.ts)) {
    let found: ToolBlock | null = null;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]!;
      if (b.kind !== "tool" || b.ts > p.ts || byCall.has(b.toolUseId)) continue;
      if ((b.name === p.toolName || bareToolName(b.name) === bareToolName(p.toolName)) && stable(b.input) === stable(p.input)) { found = b; break; }
    }
    if (found) byCall.set(found.toolUseId, p); else loose.push(p);
  }
  return { byCall, loose };
}

const DECIDED: Record<NonNullable<SharedPermission["decision"]>, string> = {
  allow: "Allowed when asked", allow_always: "Always allowed when asked", deny: "Denied when asked",
};

function renderLog(blocks: readonly Block[], permissions: readonly SharedPermission[], ctx: Ctx): string {
  const { byCall, loose } = pairPermissions(blocks, permissions);
  const out: string[] = [];
  const pending = [...loose];
  const flushBefore = (ts: number) => {
    while (pending.length && pending[0]!.ts <= ts) out.push(loosePermission(pending.shift()!));
  };
  for (const item of groupTranscript(blocks)) {
    if (item.kind === "group") {
      flushBefore(item.steps[0]!.block.ts);
      out.push(renderSteps(item.steps, byCall, ctx));
      continue;
    }
    flushBefore(item.block.ts);
    out.push(renderBlock(item.block, item.nested, byCall, ctx));
  }
  while (pending.length) out.push(loosePermission(pending.shift()!));
  return out.filter(Boolean).join("\n");
}

function loosePermission(p: SharedPermission): string {
  const what = p.title || `Use ${toolVerb(p.toolName).toLowerCase()}`;
  const decision = p.decision === null ? "not answered" : p.decision === "deny" ? "denied" : p.decision === "allow_always" ? "always allowed" : "allowed";
  return `<p class="note">Asked: ${esc(what)} — ${decision}.</p>`;
}

function renderBlock(b: Block, nested: readonly ToolNode[], byCall: Map<string, SharedPermission>, ctx: Ctx): string {
  switch (b.kind) {
    case "user": return renderPrompt(b, ctx);
    case "assistant": {
      if (!b.text.trim()) return "";
      const id = `m-${++ctx.count.n}`;
      return `<article class="msg msg-agent" id="${id}">${anchor(id)}<div class="md">${ctx.markdown(b.text)}</div></article>`;
    }
    case "thinking":
      return ctx.options.thinking && b.text.trim()
        ? `<details class="thinking"><summary class="line">${CHEV}<span class="verb">Thinking</span></summary><div class="body md">${ctx.markdown(b.text)}</div></details>`
        : "";
    case "tool": return renderCall(b, nested, byCall, ctx);
    case "plan": {
      const steps = b.steps?.length ? `<ul class="todo">${b.steps.map((s) => `<li data-status="${s.status}">${esc(s.text)}</li>`).join("")}</ul>` : "";
      return `<section class="plan"><p class="plan-head">Plan</p>${b.text ? `<div class="md">${ctx.markdown(b.text)}</div>` : ""}${steps}</section>`;
    }
    case "question": {
      if (!b.decision && !b.card.refused) return "";
      const who = b.card.asker.kind === "server" ? `${b.card.asker.name}'s MCP server` : b.card.asker.name;
      if (b.card.refused) return `<p class="note">${esc(who)} asked a question, and Realm declined it: ${esc(b.card.refused)}</p>`;
      const rows = b.card.questions.map((q) => {
        const a = b.answers?.[q.id];
        const said = a === undefined ? "Not answered" : Array.isArray(a) ? a.join(", ") : typeof a === "object" && a !== null ? Object.values(a).join(", ") : String(a);
        return `<p class="q">${esc(q.prompt)}</p><p class="a">${esc(said)}</p>`;
      }).join("");
      return `<div class="ask"><p class="cap">${esc(who)} asked</p>${rows}</div>`;
    }
    case "error": return `<p class="note" data-tone="bad"><strong>Error</strong> · ${esc(b.message)}</p>`;
    case "handoff": return `<p class="note"><strong>Handed over</strong> from ${esc(b.from)} to ${esc(b.to)} · ${esc(b.note)}</p>`;
    case "compacted": return `<p class="note"><strong>Context compacted</strong>${b.postTokens === undefined ? "" : ` · ${b.preTokens.toLocaleString("en-US")} tokens summarised to ${b.postTokens.toLocaleString("en-US")}`}</p>`;
    case "context_reset": return `<p class="note"><strong>Context reset</strong> · ${esc(b.note)}</p>`;
    case "run": return `<p class="run">${b.stopped ? "Stopped after" : b.failed ? "Failed after" : "Worked for"} ${formatDuration(b.ms)}</p>`;
    // Where one reader stopped reading, and a retry in flight at the moment of sharing: facts about a
    // window, not about the session.
    case "unseen-mark": case "retrying": return "";
  }
}

const anchor = (id: string): string => `<a class="anchor" href="#${id}" aria-label="Link to this message">#</a>`;

function renderPrompt(b: Extract<Block, { kind: "user" }>, ctx: Ctx): string {
  const id = `m-${++ctx.count.n}`;
  const text = b.text.trim();
  if (text && ctx.depth === 0) ctx.prompts.push({ id, text: text.split("\n")[0]!.replaceAll(SECRET, "[hidden]").slice(0, 80) });
  const from = b.from ? `From ${b.from.title}` : b.goal ? goalTurnLabel(b.goal) : b.scheduled ? `Scheduled · ${b.scheduled.task}` : null;
  const files = (b.attachments ?? []).map((a) => `<li>${isImageMime(a.mime) ? picture(a.path, basenameOf(a.path), ctx) : fileChip(a.path)}</li>`).join("");
  return [
    `<article class="msg msg-user" id="${id}">`,
    anchor(id),
    from ? `<p class="msg-from">${esc(from)}</p>` : "",
    files ? `<ul class="files">${files}</ul>` : "",
    text ? `<div class="bubble">${esc(text)}</div>` : "",
    `</article>`,
  ].join("");
}

const fileChip = (path: string): string => `<span class="file" title="${attr(path)}">${esc(basenameOf(path))}</span>`;

/** A picture, inside the page, or why it is not. */
function picture(path: string, alt: string, ctx: Ctx): string {
  if (!ctx.options.images) return fileChip(path);
  const data = ctx.images.get(path);
  if (!data || !RASTER.test(data)) return fileChip(path);
  const bytes = Math.floor(((data.length - data.indexOf(",") - 1) * 3) / 4);
  if (bytes > IMAGE_CAP_BYTES || bytes > ctx.room.bytes) {
    ctx.room.leftOut++;
    const why = bytes > IMAGE_CAP_BYTES ? `${formatAttachmentSize(bytes)} is over the ${formatAttachmentSize(IMAGE_CAP_BYTES)} a picture may take` : `the page already holds ${formatAttachmentSize(IMAGES_CAP_BYTES)} of pictures`;
    return `<span class="left" title="${attr(path)}">${esc(basenameOf(path))} is not included: ${why}</span>`;
  }
  ctx.room.bytes -= bytes;
  return `<figure class="pic"><img src="${data}" alt="${attr(alt)}" loading="lazy" decoding="async"></figure>`;
}

// ── Calls ─────────────────────────────────────────────────────────────────────────────────────

const CHEV = `<svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const DOT = `<span class="dot" aria-hidden="true"></span>`;

/** A line that opens to `body`, or a line with nothing under it. */
function line(cls: string, row: string, body: string): string {
  return body
    ? `<details class="${cls}"><summary class="line">${CHEV}${row}</summary><div class="body">${body}</div></details>`
    : `<div class="${cls} line">${DOT}${row}</div>`;
}

const stat = (s: { add: number; del: number } | null): string =>
  s && (s.add || s.del) ? `<span class="stat"><span class="add">+${s.add}</span> <span class="del">−${s.del}</span></span>` : "";

/** What the line names: a file by its name, anything else by its one-line summary. */
function callObject(b: ToolBlock): { text: string; title: string; mono: boolean } {
  const path = editTarget(b)?.path ?? readTarget(b);
  if (path) return { text: basenameOf(path), title: path, mono: true };
  const mcp = mcpParts(b.name);
  const summary = toolSummary(b.name, b.input).replace(/\s+/g, " ").trim();
  if (mcp) return { text: summary ? `${mcp.server} · ${summary}` : mcp.server, title: summary, mono: false };
  const verb = toolVerb(b.name, b.toolKind);
  return { text: summary, title: summary, mono: verb === "Run" || verb === "Search" || verb === "Find files" || verb === "Fetch" };
}

function renderCall(b: ToolBlock, nested: readonly ToolNode[], byCall: Map<string, SharedPermission>, ctx: Ctx): string {
  if (isHarnessLaunch(b)) return renderHarnessAgent(b, nested, byCall, ctx);
  if (isDelegationLine(b)) return renderDelegation(b, ctx);
  if (isDelegationWait(b)) return line("call", `<span class="verb">Waited for sub-agents</span>`, "");
  const obj = callObject(b);
  const permission = byCall.get(b.toolUseId);
  const failed = b.result?.isError ?? false;
  const tags = [
    // A denied call's error is the denial; saying "Failed" beside it would say it twice.
    failed && permission?.decision !== "deny" ? `<span class="tag" data-tone="bad">Failed</span>` : "",
    permission ? `<span class="tag"${permission.decision === "deny" ? ` data-tone="bad"` : ""}>${permission.decision ? DECIDED[permission.decision] : "Waiting for an answer"}</span>` : "",
    b.result === null && !permission ? `<span class="tag">No result</span>` : "",
  ].join("");
  const row = `<span class="verb">${esc(toolVerb(b.name, b.toolKind))}</span>`
    + (obj.text ? `<span class="obj${obj.mono ? "" : " prose"}" title="${attr(obj.title)}">${esc(obj.text)}</span>` : "")
    + stat(editStat(b.name, b.input) ?? resultEditStat(b)) + tags;
  const body = ctx.options.tools ? callBody(b, ctx) + nestedCalls(nested, byCall, ctx) : "";
  return line("call", row, body);
}

function nestedCalls(nested: readonly ToolNode[], byCall: Map<string, SharedPermission>, ctx: Ctx): string {
  return nested.map((n) => renderCall(n.block, n.nested, byCall, ctx)).join("");
}

/** The calls a run made, folded under one line that says what kind of work it was. */
function renderSteps(steps: readonly ToolNode[], byCall: Map<string, SharedPermission>, ctx: Ctx): string {
  const all: ToolBlock[] = [];
  const walk = (ns: readonly ToolNode[]) => { for (const n of ns) { all.push(n.block); walk(n.nested); } };
  walk(steps);
  const s = summarizeToolRun(all);
  const work = Object.values(runWork(s)).filter(Boolean) as string[];
  const row = `<span class="verb">Worked</span><span class="obj prose">${esc(work.length ? work.join(" · ") : plural(s.tools, "step"))}</span>`
    + stat(s.add || s.del ? { add: s.add, del: s.del } : null)
    + (s.failed ? `<span class="tag" data-tone="bad">${s.failed} failed</span>` : "");
  return line("steps", row, steps.map((n) => renderCall(n.block, n.nested, byCall, ctx)).join(""));
}

/** The text a call produced, capped, with what was left out said in words. */
function capped(text: string): { text: string; more: string } {
  if (text.length <= TEXT_CAP) return { text, more: "" };
  const kept = text.slice(0, TEXT_CAP);
  const rest = text.slice(TEXT_CAP).split("\n").length;
  return { text: kept, more: `<p class="more">${plural(rest, "more line")} not included.</p>` };
}

function highlight(code: string, grammar: string | null): string {
  if (!grammar || code.length > 40_000) return esc(code);
  try {
    return hljs.highlight(code, { language: grammar, ignoreIllegals: true }).value;
  } catch {
    return esc(code);
  }
}

function well(text: string, grammar: string | null = null, wrap = false): string {
  const c = capped(text);
  return `<pre class="well${wrap ? " wrap" : ""}"><code>${highlight(c.text, grammar)}</code></pre>${c.more}`;
}

function callBody(b: ToolBlock, ctx: Ctx): string {
  const panel = toolPanel(b);
  if (panel) return panelBody(panel, ctx);
  // No drawing for this call: what it was handed and what came back, as text.
  const parts: string[] = [];
  if (Object.keys(b.input).length) parts.push(`<p class="cap">Input</p>${well(JSON.stringify(b.input, null, 2), "json")}`);
  if (b.result?.content) parts.push(`<p class="cap"${b.result.isError ? ` data-tone="bad"` : ""}>${b.result.isError ? "Error" : "Result"}</p>${well(b.result.content, null, true)}`);
  return parts.join("");
}

function panelBody(p: ToolPanel, ctx: Ctx): string {
  switch (p.kind) {
    case "run": {
      // The command and what it printed are one terminal, as they were on the screen it ran on.
      const printed = !p.diff && p.output ? capped(p.output) : null;
      const out: string[] = [`<pre class="well"><code><span class="ps">$ </span><span class="cmd">${esc(p.command)}</span>${printed ? `\n${esc(printed.text)}` : ""}</code></pre>${printed?.more ?? ""}`];
      if (p.diff) out.push(renderDiffs(p.diff));
      if (p.exitCode !== null) out.push(`<p class="cap"${p.exitCode ? ` data-tone="bad"` : ""}>Exit code ${p.exitCode}</p>`);
      else if (p.error && p.output) out.push(`<p class="cap" data-tone="bad">${esc(failureReason(p.output))}</p>`);
      return out.join("");
    }
    case "diff": return renderDiffs(p.files) + (p.error ? `<p class="cap" data-tone="bad">${esc(failureReason(p.error))}</p>` : "");
    case "read": {
      if (p.error) return `<p class="cap" data-tone="bad">${esc(failureReason(p.error))}</p>`;
      const c = capped(p.text);
      return `<p class="cap">${esc(p.path)}</p>${listing(c.text, grammarForPath(p.path), p.firstLine)}${c.more}`;
    }
    case "media": return picture(p.path, basenameOf(p.path), ctx) + (p.error ? `<p class="cap" data-tone="bad">${esc(failureReason(p.error))}</p>` : "");
    case "search": {
      const lines = p.groups.flatMap((g) => g.matches.length ? g.matches.map((m) => `${g.path}${m.line === null ? "" : `:${m.line}`}  ${m.text}`) : [g.path]);
      // The pattern is the line's own object; only the harness's note about the result is new here.
      return `${p.note ? `<p class="cap">${esc(p.note)}</p>` : ""}${well(lines.join("\n"))}`;
    }
    case "fetch": {
      const url = p.url ? safeUrl(p.url) : null;
      const head = url ? `<a href="${attr(url)}" rel="noopener noreferrer nofollow">${esc(p.url!)}</a>` : esc(p.url ?? p.query ?? "");
      return `<p class="cap">${head}${p.prompt ? ` · ${esc(p.prompt)}` : ""}</p>${p.result ? well(p.result, null, true) : ""}`;
    }
    case "mcp": {
      const args = p.args.length ? `<dl class="args">${p.args.map((a) => `<dt>${esc(a.key)}</dt><dd>${esc(a.value)}</dd>`).join("")}</dl>` : "";
      const result = p.result ? `<p class="cap"${p.error ? ` data-tone="bad"` : ""}>${p.error ? "Error" : "Result"}</p>${well(p.result, p.json ? "json" : null, !p.json)}` : "";
      return args + result;
    }
    case "todos": return `<ul class="todo">${p.todos.map((t) => `<li data-status="${t.status}">${esc(t.content)}</li>`).join("")}</ul>`;
  }
}

/** A file as it was read: its own line numbers in a gutter when the read reported them, which is
 *  how a `Read` with an offset keeps the file's numbering. */
function listing(text: string, grammar: string | null, firstLine: number | null): string {
  if (firstLine === null) return `<pre class="well"><code>${highlight(text, grammar)}</code></pre>`;
  const rows = text.split("\n").map((l, i) => `<tr><td class="no">${firstLine + i}</td><td class="text">${highlight(l, grammar)}</td></tr>`);
  return `<div class="listing"><table>${rows.join("")}</table></div>`;
}

function renderDiffs(files: readonly FileDiff[]): string {
  return files.map(renderDiff).join("");
}

function renderDiff(f: FileDiff): string {
  const grammar = grammarForPath(f.path);
  const rows: string[] = [];
  let shown = 0, cut = 0;
  for (const h of f.hunks) {
    if (h.skipped > 0) rows.push(`<tr class="gap"><td colspan="3">${plural(h.skipped, "unchanged line")}</td></tr>`);
    for (const l of h.lines) {
      if (shown >= DIFF_LINES_CAP) { cut++; continue; }
      shown++;
      const no = f.numbered ? (l.kind === "del" ? l.oldNo : l.newNo) : null;
      const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : " ";
      rows.push(`<tr data-kind="${l.kind}"><td class="no">${no ?? ""}</td><td class="sign">${sign}</td><td class="text">${highlight(l.text, grammar)}</td></tr>`);
    }
  }
  const lines = rows.length ? `<div class="diff-lines"><table>${rows.join("")}</table></div>` : "";
  return `<div class="diff"><div class="diff-head"><span class="path" title="${attr(f.path)}">${esc(f.path || "Change")}</span>${stat({ add: f.add, del: f.del })}</div>${lines}`
    + `${f.note ? `<p class="diff-note">${esc(f.note)}</p>` : ""}${cut ? `<p class="diff-note">${plural(cut, "more changed line")} not included.</p>` : ""}</div>`;
}

// ── Sub-agents ────────────────────────────────────────────────────────────────────────────────

/** One of the harness's own sub-agents (`Task`, `Agent`, `Workflow`): what it was asked, the calls it
 *  made under the call that started it, and what it reported. */
function renderHarnessAgent(b: ToolBlock, nested: readonly ToolNode[], byCall: Map<string, SharedPermission>, ctx: Ctx): string {
  const str = (k: string): string | null => (typeof b.input[k] === "string" && (b.input[k] as string).trim() ? (b.input[k] as string) : null);
  const task = str("description") ?? str("prompt") ?? "Sub-agent";
  const kind = str("subagent_type");
  const state = b.result?.isError ? "Failed" : b.background === "running" || b.result === null ? "Still working when shared" : "Finished";
  const row = `<span class="verb">Sub-agent</span><span class="obj prose" title="${attr(task)}">${esc(task)}</span>`
    + `<span class="tag"${b.result?.isError ? ` data-tone="bad"` : ""}>${esc([kind, state].filter(Boolean).join(" · "))}</span>`;
  if (!ctx.options.subagents) return line("agent", row, "");
  const prompt = str("prompt");
  // A background agent's call returns at once with a receipt, not a report.
  const report = b.result && !b.result.isError && b.background === undefined ? b.result.content : null;
  const body = [
    prompt ? `<p class="agent-label">Asked</p><div class="md">${ctx.markdown(prompt)}</div>` : "",
    nested.length ? nestedCalls(nested, byCall, ctx) : "",
    report ? `<p class="agent-label">Reported</p><div class="md">${ctx.markdown(capped(report).text)}</div>` : "",
    b.result?.isError ? `<p class="cap" data-tone="bad">${esc(failureReason(b.result.content))}</p>` : "",
  ].join("");
  return line("agent", row, body);
}

/** One of Realm's own sub-agents: a session of its own, drawn whole under the call that started it. */
function renderDelegation(b: ToolBlock, ctx: Ctx): string {
  const kids = ctx.children[b.toolUseId] ?? [];
  const goal = typeof b.input["goal"] === "string" ? (b.input["goal"] as string) : "";
  const named = typeof b.input["title"] === "string" ? (b.input["title"] as string) : "";
  if (kids.length === 0) {
    const row = `<span class="verb">Sub-agent</span><span class="obj prose" title="${attr(goal)}">${esc(named || goal || "Sub-agent")}</span>`;
    return line("agent", row, "");
  }
  return kids.map((kid) => {
    const row = `<span class="verb">Sub-agent</span><span class="obj prose" title="${attr(goal)}">${esc(kid.title || named || goal)}</span><span class="tag">${esc(kid.agent)}</span>`;
    if (!ctx.options.subagents) return line("agent", row, "");
    // The child's first message is the brief Realm wrapped round the goal. What the lead asked for is
    // the goal itself, so that is what the page shows — as a harness sub-agent's ask is shown.
    const [brief, ...rest] = kid.transcript.blocks;
    const asked = goal && brief?.kind === "user";
    ctx.depth++;
    const log = renderLog(asked ? rest : kid.transcript.blocks, kid.permissions, ctx);
    ctx.depth--;
    return line("agent", row, `${asked ? `<p class="agent-label">Asked</p><div class="md">${ctx.markdown(goal)}</div>` : ""}${log}`);
  }).join("");
}

// ── Markdown ──────────────────────────────────────────────────────────────────────────────────

/**
 * An answer's Markdown as HTML that can carry nothing but the answer. A Marked instance of its own,
 * so nothing here changes how the app's transcript renders: raw HTML is written out as the text it
 * is, a heading moves down under the page's own title, links pass `safeUrl`, a picture is one Realm
 * embedded (anything remote is a link to it, never a request), and code is highlighted now so the
 * page needs no script to colour it.
 */
function markdownFor(ctx: Ctx): (src: string) => string {
  const md = new Marked({ gfm: true, breaks: false, async: false });
  md.use({
    renderer: {
      html({ text }) { return esc(text); },
      heading({ tokens, depth }) {
        const level = Math.min(6, depth + 2);
        return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const url = safeUrl(href);
        if (!url) return `<span class="dead">${text}</span>`;
        return `<a href="${attr(url)}"${title ? ` title="${attr(title)}"` : ""} rel="noopener noreferrer nofollow">${text}</a>`;
      },
      image({ href, text }) {
        const url = safeUrl(href);
        if (url) return `<a href="${attr(url)}" rel="noopener noreferrer nofollow">${esc(text || "Picture")}</a>`;
        return picture(href.trim(), text, ctx);
      },
      code({ text, lang }) {
        const name = (lang ?? "").trim().split(/\s+/)[0] ?? "";
        const label = /^[\w#+.-]{1,32}$/.test(name) ? name : "";
        return `<figure class="code"><figcaption>${esc(label)}</figcaption><pre><code class="hljs">${highlight(text, grammarFor(label))}</code></pre></figure>\n`;
      },
      table(token) {
        const head = `<tr>${token.header.map((c) => cell(this.parser.parseInline(c.tokens), c.align, "th")).join("")}</tr>`;
        const rows = token.rows.map((r) => `<tr>${r.map((c) => cell(this.parser.parseInline(c.tokens), c.align, "td")).join("")}</tr>`).join("");
        return `<div class="table"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>\n`;
      },
    },
  });
  return (src) => md.parse(src) as string;
}

const cell = (content: string, align: "center" | "left" | "right" | null, tag: "th" | "td"): string =>
  `<${tag}${align ? ` align="${align}"` : ""}>${content}</${tag}>`;
