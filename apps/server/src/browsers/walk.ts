import { fenceUntrusted, type BrowserPageActivity, type BrowserSnapshotElement, type BrowserSnapshotResult } from "@realm/contracts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ObservedElement } from "../mcp/act-observer";
import { clip } from "../mcp/tool-result";
import type { ExecResult, ExecStopReason, WalkElement, WalkTree } from "../simulators/executor";

/**
 * `browser_do`'s page, as the walk in `simulators/executor.ts` reads it, and the walk's answer as an
 * agent reads it. The calls that drive the pane are beside the tool in `agent-tools.ts`.
 *
 * **`screenChecks: false`.** The walk's screen checks are a phone's, and each is wrong on a page:
 *
 *  - It takes an element as covered when something LATER IN THE TREE is drawn over its middle. A page's
 *    tree is its DOM, and DOM order is not stacking order: a fixed header early in the document sits
 *    over everything after it. The snapshot has already dropped what is covered, by the page's own
 *    paint order (`isCovered` in the desktop's `browser-agent.ts`), so the walk's check could only
 *    drop the wrong things.
 *  - It passes over what is off the screen and scrolls to find it. A snapshot lists the elements below
 *    the fold too, and a click scrolls its element into view before it is sent, then goes to the
 *    element's live centre, where Chromium hit-tests it like any click. Below the fold is one click
 *    away.
 *  - It leaves out a band at the top as a status bar. On a page that band is the navigation.
 *
 * **Scrolling.** Since the snapshot already lists what is further down, what a scroll can still bring
 * is what a page loads when it is scrolled to the end of what it has — the next rows of a feed. So a
 * walk's scroll goes to the end of the page (and back to the top), and a label is scrolled for only
 * when no element on the page has it yet.
 *
 * **What counts as a change.** Where an element sits is left out of the tree (every frame starts at
 * 0,0): a click on an element below the fold scrolls the page first, and a place would change under
 * that click whatever the click did. What is compared is what the page says — each element's role,
 * name and value, a checkbox's state — and its address, which the document carries at the top of the
 * tree as its value, unnamed so that no label can ever match it. A link to a part of the same page
 * changes the address; a form field filling changes a value.
 *
 * **Settling.** The walk reads until two reads agree, unless the browser says otherwise (`atRest` on
 * the tree). While the page waits on a document or on data it asked for, nothing read settles: two
 * reads of a page half-arrived agree as well as two of a whole one. Once the page has finished
 * loading and nothing it waits on has moved for long enough to be drawn (`NETWORK_QUIET_MS`), one
 * read that shows a click's change is enough.
 */

/** The document's own entry in a walk tree: never a ref, so never a label a path could name. */
export const DOCUMENT_PATH = "document";

/** How long a page's network must have been quiet before one read of it counts as at rest: a
 *  response that just arrived is usually drawn within a frame or two of it. */
export const NETWORK_QUIET_MS = 100;

/** What the browser's report makes of a read, as the module comment says: false while the page waits
 *  on a request, true once it is loaded and quiet, and nothing — read until two reads agree — between
 *  the two or without a report. */
export function atRest(page: BrowserPageActivity | undefined): boolean | undefined {
  if (page === undefined) return undefined;
  if (page.requests > 0) return false;
  return !page.loading && page.quietMs >= NETWORK_QUIET_MS ? true : undefined;
}

/**
 * A snapshot element's role in the words the walk and Laya read, which are the phone's and the Mac's:
 * a text box is a text field, and a password field says it is a secure one — the walk's own test for
 * a field it types into, and for one it never does. Every other role is the page's own.
 */
export function pageRole(role: string, password: boolean): string {
  if (password) return "secure text field";
  if (/^(textbox|textfield|textarea|spinbutton)$/i.test(role)) return "text field";
  if (/^searchbox$/i.test(role)) return "search field";
  return role;
}

/** A snapshot element as the walk reads it. Its focus is part of what the walk compares: a click into a
 *  field changes nothing else a snapshot shows, and would otherwise be waited on to its timeout. */
export function walkElementOf(e: BrowserSnapshotElement): WalkElement {
  return {
    path: String(e.ref), label: e.name, role: pageRole(e.role, e.password),
    value: e.checked === null ? e.value ?? "" : e.checked ? "checked" : "unchecked",
    id: null, enabled: !e.disabled, frame: { x: 0, y: 0, width: e.rect.w, height: e.rect.h }, depth: 1,
    ...(e.focused ? { focused: true } : {}),
  };
}

/** A snapshot as the walk reads it — see the module comment for each choice. */
export function walkTreeOf(snap: BrowserSnapshotResult): WalkTree {
  const document: WalkElement = { path: DOCUMENT_PATH, label: "", value: snap.url, role: "document", id: null, enabled: true, frame: { x: 0, y: 0, width: 0, height: 0 }, depth: 0 };
  const rest = atRest(snap.page);
  return {
    units: "pixels",
    screen: { width: snap.viewport?.width ?? 0, height: snap.viewport?.height ?? 0 },
    app: siteName(snap.url) ?? "",
    elements: [document, ...(snap.elements ?? []).map(walkElementOf)],
    screenChecks: false,
    ...(rest !== undefined ? { atRest: rest } : {}),
  };
}

/** A walk element as Laya's shadow hears it: named by its ref, the number the agent acts on. */
export function observedOf(el: WalkElement): ObservedElement {
  return { id: el.path, role: el.role, label: clip(el.label, 200), ...(el.value ? { value: clip(el.value, 200) } : {}) };
}

/** The elements a snapshot listed, as the shadow hears them — the document's own entry left out. */
export function observedPage(elements: readonly WalkElement[]): ObservedElement[] {
  return elements.filter((e) => e.path !== DOCUMENT_PATH).map(observedOf);
}

/**
 * The sites whose likes, follows and messages other people see, by the name the app goes by — the
 * name `sensitiveRule`'s app rules know. A subdomain is the same site: web.whatsapp.com is WhatsApp.
 */
const SOCIAL_SITES: readonly (readonly [string, string])[] = [
  ["instagram.com", "Instagram"], ["tiktok.com", "TikTok"], ["x.com", "X"], ["twitter.com", "X"],
  ["facebook.com", "Facebook"], ["messenger.com", "Messenger"], ["threads.net", "Threads"], ["threads.com", "Threads"],
  ["linkedin.com", "LinkedIn"], ["youtube.com", "YouTube"], ["reddit.com", "Reddit"], ["snapchat.com", "Snapchat"],
  ["whatsapp.com", "WhatsApp"], ["telegram.org", "Telegram"], ["discord.com", "Discord"], ["pinterest.com", "Pinterest"],
  ["bere.al", "BeReal"], ["tumblr.com", "Tumblr"], ["bsky.app", "Bluesky"], ["mastodon.social", "Mastodon"],
];

/**
 * The site a page is on, named the way an app on a phone names itself: a social site by its app's name
 * ("Instagram"), so that a Like on instagram.com is read as the Like it is in the app; any other by its
 * host, less a leading www. or m. Null for a page with no host.
 */
export function siteName(url: string | undefined): string | null {
  let host: string;
  try { host = new URL(url ?? "").hostname.toLowerCase(); } catch { return null; }
  if (!host) return null;
  const social = SOCIAL_SITES.find(([domain]) => host === domain || host.endsWith(`.${domain}`));
  return social ? social[1] : host.replace(/^(www|m)\./, "");
}

/* ---------------------------------- the answer ---------------------------------- */

/**
 * Why a walk stopped, in Realm's words. The executor's own sentence can quote the page — the name of
 * the element it stopped on — so it goes inside the fence with the snapshot; this is what stands
 * outside it. Where the executor's sentence is Realm's alone (a refusal from the pane, which field to
 * type into) it is used as it is.
 */
const WHY: Record<ExecStopReason, string | null> = {
  "not-found": "nothing on the page matched it",
  sensitive: "it is a step a walk never takes — it reads as buying, paying, deleting, sending, posting, submitting, signing out or entering a secret",
  "no-change": "the click changed nothing on the page",
  "tap-failed": null,
  "not-there": "the page it ended on does not show it",
  "which-field": null,
};

/** What to do after each way a walk stops. */
const AFTER_STOP: Record<ExecStopReason, string> = {
  "not-found": "Click one of those with browser_act by its ref, or walk again with the label as the snapshot below shows it.",
  sensitive: "If it is the step you mean, take it yourself with browser_act by its ref.",
  "no-change": "The snapshot below is what the click left; carry on from it with browser_act, or walk again.",
  "tap-failed": "Nothing further was sent.",
  "not-there": "The snapshot below is where it ended instead.",
  "which-field": "End the path on the field to type into, or type into it with browser_act by its ref.",
};

/**
 * A walk's answer: the steps as the agent gave them, or where it stopped and why, with the likeliest
 * elements by ref — then the snapshot it ended on, whose refs `browser_act` takes next. Everything the
 * page wrote is inside the fence: the snapshot, and the walk's own account of a stop that names what it
 * stopped on. A walk that stopped is an error, so an agent reading only the flag knows it did not get
 * there.
 */
export function pageWalked(snap: BrowserSnapshotResult, host: string, r: ExecResult): CallToolResult {
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const trail = r.steps.map((s) => {
    if (s.how === "typed") return s.label;
    const how = s.how === "close" ? " (a close match)" : s.how === "laya" ? " (Laya's pick)" : "";
    return `"${clip(s.label, 50)}"${how}${s.scrolls ? `, ${s.scrolls} scroll${s.scrolls === 1 ? "" : "s"}` : ""}`;
  }).join(" → ");
  let head: string;
  let account = "";
  if (r.stop === null) {
    head = `Walked ${trail} on ${host} in ${secs(r.ms)}.`;
  } else {
    const why = WHY[r.stop.why];
    const refs = r.stop.candidates.map((e) => `[ref=${e.path}]`);
    head = `${r.steps.length > 0 ? `Walked ${trail}, then stopped` : "Stopped"} at "${clip(r.stop.label, 60)}" on ${host} after ${secs(r.ms)}: ${sentence(why ?? r.stop.detail)}`
      + `${refs.length > 0 ? ` The likeliest: ${refs.join(", ")} — each is in the snapshot below.` : ""} ${AFTER_STOP[r.stop.why]}`;
    if (why !== null) account = `walk: ${sentence(r.stop.detail)}\n`;
  }
  const body = `Snapshot of ${snap.url} — ${snap.elementCount} interactive element(s), as browser_snapshot lists them; act on one with browser_act by its ref.`;
  return {
    content: [{ type: "text", text: `${head}\n${body}\n${fenceUntrusted(`${account}title: ${snap.title}\n${snap.text}`)}` }],
    isError: r.stop !== null,
  };
}

/** A clause as a sentence: a full stop added unless it already ends in one. */
const sentence = (s: string): string => (/[.!?]\)?$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
