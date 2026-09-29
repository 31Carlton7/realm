import type { SimulatorAxElement, SimulatorAxTree } from "@realm/contracts";
import type { AssistOutcome } from "../laya/assist";
import { sensitiveRule } from "../laya/shadow";
import type { ObservedElement } from "../mcp/act-observer";
import type { MotionMark, ScreenMotion } from "./screen-motion";

/**
 * `simulator_do`: a whole walk through an app in ONE tool call, carried out on this Mac.
 *
 * The slow part of an agent driving a phone is not the phone. It is the model: every tap is a turn —
 * read the screen, think, act — and a turn costs seconds, where the device answers in a few hundred
 * milliseconds. Computer use that looks at pixels pays that price for every step. This splits the work
 * where it belongs. The agent, which knows that About lives under General, says the path once:
 * `["General", "About"]`. This walks it on the accessibility tree, at the device's speed, with no
 * model in the loop:
 *
 *   1. Find the label on the live screen: exactly, then closely ("WiFi" for "Wi-Fi", "&" for "and",
 *      a row whose label starts with it), preferring what can be tapped over what only reads.
 *   2. Not there? Scroll to find it — down the list, then back up — and stop when it stops moving.
 *   3. Still not there? Laya, on this Mac, picks from the screen, when its Assist has earned that.
 *   4. Tap, then wait for the screen to CHANGE AND HOLD STILL, rather than for a fixed time. A tap
 *      that changed nothing ends the walk instead of being taken for one that worked.
 *
 * It stops rather than guesses: a label it cannot find, a tap that changed nothing, a step the
 * sensitive rule flags (buying, deleting, sending, a password) — each ends the walk with the
 * likeliest elements on the screen it stopped on, and the agent decides. Sensitive steps are never
 * walked into: the agent takes those one tap at a time, by number.
 */

/**
 * A screen's tree, as a walk reads it. `screenChecks: false` marks one whose elements are all on
 * screen and whose clicks are checked, where they are sent, for anything drawn over them — a Mac
 * app's, through the accessibility helper (`computer/agent-tools.ts`). Its frames are global and can
 * be negative on a second display, it has no status bar, and the helper refuses an occluded click
 * itself, so the walk's own screen checks are skipped for it.
 */
export type WalkTree = Omit<SimulatorAxTree, "elements"> & { elements: WalkElement[]; screenChecks?: false };
/** An element as a walk reads it: `focused` where the tree says which element has focus — a Mac app's
 *  does, so a click into a field shows as the change it is. */
export type WalkElement = SimulatorAxElement & { focused?: boolean };

export type ExecIO = {
  /** The live tree. May throw while the device is mid-animation; the executor looks again. */
  read(): Promise<WalkTree>;
  tap(el: SimulatorAxElement, tree: WalkTree): Promise<{ ok: boolean; detail: string }>;
  /** Move the content by most of a screen: `up` brings what is below into view, `down` what is above. */
  scroll(direction: "up" | "down", tree: WalkTree): Promise<{ ok: boolean; detail: string }>;
  type(text: string): Promise<{ ok: boolean; detail: string }>;
  /** Laya's pick for a label nothing on the screen matches. Present only while its Assist can act. */
  laya?(label: string, elements: readonly ObservedElement[]): Promise<AssistOutcome>;
  /** Each tap, just before it is sent — for Laya's shadow. */
  observe?(step: { label: string; elements: readonly SimulatorAxElement[]; chosen: SimulatorAxElement; by: "agent" | "laya" }): void;
  /** Each screen once it has settled after a step — the "after" the observer is owed. */
  settled?(tree: WalkTree): void;
  /** The screen's picture, for telling when it has stopped moving without reading its tree
   *  (`screen-motion.ts`). Absent, the walk reads the tree until two reads agree. */
  motion?: ScreenMotion;
  now(): number;
  sleep(ms: number): Promise<void>;
};

export type Settle = {
  /** How long a tap may take to show on the screen before the walk calls it a tap that did nothing. */
  tapTimeoutMs: number;
  /** How long a scroll may take to come to rest. */
  scrollTimeoutMs: number;
  /** The pause between two looks at the tree, when there is no picture to watch. A look itself
   *  takes a few hundred milliseconds. */
  pollMs: number;
  /** How long the picture must hold still to count as at rest: several display frames. */
  stillMs: number;
};

export type ExecOptions = {
  path: readonly string[];
  /** Typed at the end: into the field the walk's last tap focused, or the only field on the screen. */
  text?: string;
  /** A label that must be on the final screen for the walk to count as done. */
  until?: string;
  /** How many scrolls each way one label may take to find. */
  maxScrolls?: number;
  /**
   * The name of an app launched just now. The walk starts once the screen is that app's and two reads
   * of it agree: a read the moment an app comes up can be the home screen it is leaving, or the
   * status bar and two rows of it — MEASURED, on Settings, under load.
   */
  launched?: string;
  settle?: Partial<Settle>;
};

export type ExecStep = {
  label: string;
  /** How the element was found: the label as written, a close form of it, or Laya's pick. */
  how: "exact" | "close" | "laya" | "typed";
  matched: string;
  scrolls: number;
  ms: number;
};

export type ExecStopReason = "not-found" | "sensitive" | "no-change" | "tap-failed" | "not-there" | "which-field";

export type ExecStop = {
  why: ExecStopReason;
  label: string;
  detail: string;
  /** The likeliest elements on the screen it stopped on — what the agent picks from by number. */
  candidates: SimulatorAxElement[];
};

export type ExecResult = { ok: boolean; steps: ExecStep[]; stop: ExecStop | null; ms: number; final: WalkTree };

export const DEFAULT_SETTLE: Settle = { tapTimeoutMs: 3_000, scrollTimeoutMs: 2_000, pollMs: 30, stillMs: 120 };
/** A scroll's picture moves while the finger does, so one that has not moved this soon after the
 *  finger lifts is a list that cannot go further. */
const SCROLL_CHANGE_WITHIN_MS = 300;
export const DEFAULT_MAX_SCROLLS = 8;

/** Roles a person taps, ahead of roles that only read — "Settings" the back button over "Settings" the
 *  heading. iOS's own words and the Mac's (`AXMenuBarItem`, `AXCheckBox`) both. */
const TAPPABLE = /button|cell|link|switch|toggle|tab|field|menu ?item|bar ?item|slider|segment|check ?box|radio|icon|key|row|pop ?up/i;
const READ_ONLY = /heading|static ?text|^(ax)?text$|label|header/i;
const FIELD = /text ?field|search ?field|text ?view|text ?area|combo ?box|secure/i;

export async function runPath(given: ExecIO, o: ExecOptions): Promise<ExecResult> {
  // Each tree remembers where the picture stood when its read began, so a tap can ask whether the
  // screen has moved since — without reading it again to find out.
  const readAt = new WeakMap<WalkTree, MotionMark>();
  const io: ExecIO = {
    ...given,
    read: async () => {
      const mark = given.motion?.mark();
      const tree = await given.read();
      if (mark) readAt.set(tree, mark);
      return tree;
    },
  };
  const movedSince = (t: WalkTree): boolean => {
    const at = readAt.get(t);
    return !!io.motion && !!at && io.motion.mark().moved > at.moved;
  };
  const started = io.now();
  const settle: Settle = { ...DEFAULT_SETTLE, ...o.settle };
  const maxScrolls = o.maxScrolls ?? DEFAULT_MAX_SCROLLS;
  const steps: ExecStep[] = [];
  let tree = await firstRead(io, settle, o.launched);
  if (o.launched !== undefined && fold(tree.app) !== fold(o.launched)) {
    return { ok: false, steps, stop: { why: "not-found", label: o.launched, detail: `${o.launched} did not come to the front — the screen is ${tree.app.trim() ? `"${clip(tree.app.trim(), 60)}"` : "the home screen"}`, candidates: likeliest(tree, o.launched) }, ms: Math.round(io.now() - started), final: tree };
  }
  let lastTapped: SimulatorAxElement | null = null;
  const done = (stop: ExecStop | null): ExecResult => ({ ok: stop === null, steps, stop, ms: Math.round(io.now() - started), final: tree });

  for (const [index, label] of o.path.entries()) {
    const t0 = io.now();
    const hit = locate(tree, label);
    let found: { el: SimulatorAxElement; how: "exact" | "close" | "laya" } | null = hit && "el" in hit ? hit : null;
    let scrolls = 0;
    // Down the list first. A screen the walk itself opened starts at the top of its list, so that is
    // the whole list; only the walk's FIRST screen, which somebody may have scrolled, is also scanned
    // back up past where it was. A match that something is drawn over is scrolled toward the middle.
    const coveredHigh = hit !== null && "covered" in hit && tapPoint(hit.covered).y < tree.screen.height / 2;
    const order = coveredHigh ? (["down", "up"] as const) : index === 0 ? (["up", "down"] as const) : (["up"] as const);
    for (const [k, direction] of order.entries()) {
      for (let tries = k === 0 ? maxScrolls : maxScrolls * 2; !found && tries > 0; tries--) {
        const before = signature(tree);
        const mark = io.motion?.mark();
        const r = await io.scroll(direction, tree);
        if (!r.ok) return done({ why: "tap-failed", label, detail: r.detail, candidates: likeliest(tree, label) });
        scrolls++;
        const moved = await afterInput(io, mark, before, settle, { timeoutMs: settle.scrollTimeoutMs, scroll: true });
        // The end of the list: nothing moved, or nothing came into view that was not there already —
        // a list that bounced off its end, or nudged a few points and stopped.
        const revealed = moved ? newLabels(tree, moved) : 0;
        if (moved) tree = moved;
        if (revealed === 0) break;
        found = findLabel(tree, label);
      }
      if (found) break;
    }
    if (!found && io.laya) {
      const outcome = await io.laya(label, tree.elements.map(observed));
      if (outcome.kind === "pick") {
        const el = tree.elements.find((e) => e.path === outcome.element.id);
        if (el) found = { el, how: "laya" };
      }
    }
    if (!found) {
      const alert = tree.elements.find((e) => /alert|dialog/i.test(e.role));
      const why = alert ? ` — an alert is up${alert.label.trim() ? `: "${clip(alert.label.trim(), 80)}"` : ""}` : "";
      return done({ why: "not-found", label, detail: `no "${clip(label, 60)}" on the screen${scrolls ? `, after scrolling ${scrolls} time(s)` : ""}${why}`, candidates: likeliest(tree, label) });
    }

    // Never walked into: the agent takes these one tap at a time. What is checked is the step — the
    // label asked for and the element it matched — not the goal, which says what the walk is for and
    // would stop every step of "delete an app" at General.
    const rule = sensitiveRule(`${label} ${found.el.label}`);
    if (rule.value) {
      return done({ why: "sensitive", label, detail: `"${clip(found.el.label.trim() || label, 60)}" reads as a step that ${rule.matched ? `says "${rule.matched}"` : "is sensitive"}, which the walk never takes on its own`, candidates: [found.el, ...likeliest(tree, label).filter((e) => e !== found!.el)].slice(0, 8) });
    }

    // The screen may have moved since it was read — MEASURED: Settings puts a row in above General
    // 1.6 s after it launches, and a tap where General was read opens that row. With a picture to
    // watch, that is known without a read; the walk then looks again and touches the element where
    // it is now. The element is found again by its own label, so the step is the one judged above.
    if (movedSince(tree)) {
      tree = await firstRead(io, settle, undefined);
      const again = findLabel(tree, found.el.label);
      if (!again) {
        return done({ why: "not-found", label, detail: `"${clip(found.el.label.trim() || label, 60)}" moved off the screen before the tap`, candidates: likeliest(tree, label) });
      }
      found = { el: again.el, how: found.how };
    }

    const before = signature(tree);
    io.observe?.({ label, elements: tree.elements, chosen: found.el, by: found.how === "laya" ? "laya" : "agent" });
    const mark = io.motion?.mark();
    const tapped = await io.tap(found.el, tree);
    if (!tapped.ok) return done({ why: "tap-failed", label, detail: tapped.detail, candidates: likeliest(tree, label) });
    const after = await afterInput(io, mark, before, settle, { timeoutMs: settle.tapTimeoutMs, scroll: false });
    // A tap into a field focuses it, which a tree need not show: a Mac app's does not, where an
    // iPhone's brings up its keyboard. So a field that stayed the same is a field with focus.
    if (!after && !FIELD.test(found.el.role)) {
      return done({ why: "no-change", label, detail: `tapped "${clip(found.el.label.trim() || label, 60)}", and the screen did not change within ${(settle.tapTimeoutMs / 1000).toFixed(1)} s`, candidates: likeliest(tree, label) });
    }
    if (after) tree = after;
    lastTapped = found.el;
    io.settled?.(tree);
    steps.push({ label, how: found.how, matched: found.el.label, scrolls, ms: Math.round(io.now() - t0) });
  }

  if (o.text !== undefined) {
    const t0 = io.now();
    const fields = tree.elements.filter((e) => FIELD.test(e.role) && onScreen(e, tree));
    // The field the last tap landed on, if the walk ended on one; otherwise the only one there is.
    const field = lastTapped && FIELD.test(lastTapped.role) ? lastTapped : fields.length === 1 ? fields[0]! : null;
    if (!field) {
      return done({ why: "which-field", label: "a text field", detail: fields.length === 0 ? "nothing on the screen takes text" : `${fields.length} fields are on the screen — end the path on the one to type into`, candidates: fields.slice(0, 8) });
    }
    if (/secure/i.test(field.role)) return done({ why: "sensitive", label: "a secure field", detail: "Realm never types into a password field", candidates: [field] });
    if (field !== lastTapped) {
      const before = signature(tree);
      const mark = io.motion?.mark();
      const r = await io.tap(field, tree);
      if (!r.ok) return done({ why: "tap-failed", label: "a text field", detail: r.detail, candidates: [field] });
      tree = (await afterInput(io, mark, before, settle, { timeoutMs: settle.tapTimeoutMs, scroll: false })) ?? tree;
    }
    const before = signature(tree);
    const mark = io.motion?.mark();
    const typed = await io.type(o.text);
    if (!typed.ok) return done({ why: "tap-failed", label: "typing", detail: typed.detail, candidates: [] });
    tree = (await afterInput(io, mark, before, settle, { timeoutMs: settle.tapTimeoutMs, scroll: false })) ?? tree;
    io.settled?.(tree);
    steps.push({ label: `type "${clip(o.text, 40)}"`, how: "typed", matched: field.label, scrolls: 0, ms: Math.round(io.now() - t0) });
  }

  if (o.until !== undefined && !findLabel(tree, o.until)) {
    return done({ why: "not-there", label: o.until, detail: `the walk finished, but "${clip(o.until, 60)}" is not on the screen it ended on`, candidates: likeliest(tree, o.until) });
  }
  return done(null);
}

/* ---------------------------------- matching ---------------------------------- */

/** A label as a person compares it: case, punctuation, dashes, "&"/"and" and spacing folded. */
export function fold(s: string): string {
  return s.normalize("NFKC").toLowerCase()
    .replace(/[\u2010-\u2015\u2212-]/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ").trim();
}

/**
 * The element a label names on this screen, or null. In order: the same words (folded); the same
 * letters with the spaces gone ("WiFi" is "Wi-Fi"); a label that STARTS with it ("Display" for
 * "Display & Brightness"); a label that holds it as whole words. Ties go to what can be tapped, then
 * to reading order. Off-screen elements are passed over, and so are elements something else is
 * drawn over — a row under a floating search bar — because a tap there lands on the bar. `covered`
 * is the best of those, so the walk knows which way to scroll to uncover it.
 */
export function findLabel(tree: WalkTree, label: string): { el: SimulatorAxElement; how: "exact" | "close" } | null {
  const hit = locate(tree, label);
  return hit && "el" in hit ? hit : null;
}

function locate(tree: WalkTree, label: string): { el: SimulatorAxElement; how: "exact" | "close" } | { covered: SimulatorAxElement } | null {
  const want = fold(label);
  if (!want) return null;
  const wantTight = want.replace(/ /g, "");
  let best: { el: SimulatorAxElement; rank: number; closeness: number } | null = null;
  let covered: { el: SimulatorAxElement; rank: number } | null = null;
  const leaves = leafOverlays(tree);
  for (const [i, el] of tree.elements.entries()) {
    if (!el.label.trim() || !onScreen(el, tree)) continue;
    const have = fold(el.label);
    const closeness = have === want ? 4
      : have.replace(/ /g, "") === wantTight ? 3
      : have.startsWith(`${want} `) ? 2
      : want.length >= 3 && ` ${have} `.includes(` ${want} `) ? 1
      : 0;
    if (closeness === 0) continue;
    const rank = closeness * 10 + (TAPPABLE.test(el.role) ? 2 : READ_ONLY.test(el.role) ? 0 : 1) - (el.enabled ? 0 : 5);
    if (tree.screenChecks !== false && isCovered(el, i, leaves)) {
      if (!covered || rank > covered.rank) covered = { el, rank };
      continue;
    }
    if (!best || rank > best.rank) best = { el, rank, closeness };
  }
  if (best) return { el: best.el, how: best.closeness === 4 ? "exact" : "close" };
  return covered ? { covered: covered.el } : null;
}

/** Elements with nothing inside them, by their place in the tree — the ones a touch actually lands
 *  on. A container that fills the screen is not drawn OVER anything; its children are. "Inside" is by
 *  ancestry, not by parent: a tree can leave out the empty containers between an element and what it
 *  holds (the device runner's does), and a bar whose own child was left out still holds its field. */
function leafOverlays(tree: WalkTree): { el: SimulatorAxElement; i: number }[] {
  const holders = new Set<string>();
  for (const el of tree.elements) {
    for (let cut = el.path.lastIndexOf("."); cut > 0; cut = el.path.lastIndexOf(".", cut - 1)) holders.add(el.path.slice(0, cut));
  }
  return tree.elements.flatMap((el, i) => (holders.has(el.path) ? [] : [{ el, i }]));
}

/**
 * Whether something drawn later in the tree — so on top — sits over the point a tap on `el` would
 * land: a floating search bar over the last rows of a list, a tab bar, the region that dismisses a
 * sheet. Nothing inside `el` counts. (What `el` is inside comes before it in the tree, never after.)
 */
function isCovered(el: SimulatorAxElement, at: number, leaves: readonly { el: SimulatorAxElement; i: number }[]): boolean {
  const p = tapPoint(el);
  return leaves.some(({ el: o, i }) => i > at && !o.path.startsWith(`${el.path}.`)
    && p.x >= o.frame.x && p.x < o.frame.x + o.frame.width && p.y >= o.frame.y && p.y < o.frame.y + o.frame.height);
}

/** Where a tap on an element lands: the centre of its frame. */
export function tapPoint(el: SimulatorAxElement): { x: number; y: number } {
  return { x: el.frame.x + el.frame.width / 2, y: el.frame.y + el.frame.height / 2 };
}

/** The elements most like a label — what the agent is handed when the walk stops. */
export function likeliest(tree: WalkTree, label: string): SimulatorAxElement[] {
  const want = new Set(fold(label).split(" ").filter((w) => w.length > 1));
  return tree.elements
    .filter((e) => e.label.trim() && onScreen(e, tree) && !inStatusBar(e, tree))
    .map((e, i) => ({ e, i, s: fold(e.label).split(" ").filter((w) => want.has(w)).length + (TAPPABLE.test(e.role) ? 0.5 : 0) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, 8)
    .map((x) => x.e);
}

function onScreen(el: SimulatorAxElement, tree: WalkTree): boolean {
  if (tree.screenChecks === false) return true;
  const p = tapPoint(el);
  return p.x >= 0 && p.y >= 0 && p.x < tree.screen.width && p.y < tree.screen.height;
}

/** How many labels are on screen in `after` that were not on screen in `before`. */
function newLabels(before: WalkTree, after: WalkTree): number {
  const had = new Set(before.elements.filter((e) => onScreen(e, before)).map((e) => e.label));
  return after.elements.filter((e) => e.label.trim() && onScreen(e, after) && !inStatusBar(e, after) && !had.has(e.label)).length;
}

/** The clock, the battery and the signal: they change on their own, and nobody navigates by them. */
const inStatusBar = (el: SimulatorAxElement, tree: WalkTree): boolean =>
  tree.screenChecks !== false && el.frame.y + el.frame.height <= 56 && !/button/i.test(el.role);

/* ---------------------------------- settling ---------------------------------- */

/** What the screen shows, as one string — minus the status bar, whose clock turning over is not a
 *  tap that worked. Places are rounded: a list that has come to rest reads the same twice. */
export function signature(tree: WalkTree): string {
  return tree.elements.filter((e) => !inStatusBar(e, tree))
    .map((e) => `${e.role}|${e.label}|${e.value}|${Math.round(e.frame.x)},${Math.round(e.frame.y)}${e.focused ? "|focused" : ""}`).join("\n");
}

/**
 * The screen once it has CHANGED from `before` and then held still for one look — or null.
 *
 * `stillMeansNone` is for a scroll: its finger has lifted by the time this runs, so a screen that
 * reads as `before` twice did not move, which is the end of the list. A tap gets its whole timeout,
 * because an app can take a moment to answer one. A screen that changed and came back — a list that
 * rubber-banded at its end — counts as no change, never as the half-way frame.
 */
async function waitForChange(io: ExecIO, before: string, w: { timeoutMs: number; pollMs: number; stillMeansNone: boolean }): Promise<WalkTree | null> {
  const deadline = io.now() + w.timeoutMs;
  let prev: string | null = null;
  let latest: WalkTree | null = null;
  while (io.now() < deadline) {
    await io.sleep(w.pollMs);
    let tree: WalkTree;
    try { tree = await io.read(); } catch { prev = null; continue; }
    const sig = signature(tree);
    const steady = sig === prev;
    prev = sig;
    if (sig === before) {
      latest = null;
      if (steady && w.stillMeansNone) return null;
      continue;
    }
    latest = tree;
    if (steady) return tree;
  }
  return latest;
}

/**
 * The screen after an input, once it has changed and come to rest — or null when it did not change.
 *
 * With a picture to watch, the tree is read once the picture is at rest: one read a step instead of
 * three. A picture that moved while the tree stayed the same — a highlight flashing on a tap still
 * being answered — is waited past. Without a picture, or when the stream drops mid-step, the tree is
 * read until two reads agree.
 */
async function afterInput(io: ExecIO, mark: MotionMark | undefined, before: string, settle: Settle, w: { timeoutMs: number; scroll: boolean }): Promise<WalkTree | null> {
  const motion = io.motion;
  const deadline = io.now() + w.timeoutMs;
  const poll = () => waitForChange(io, before, { timeoutMs: Math.max(0, deadline - io.now()), pollMs: settle.pollMs, stillMeansNone: w.scroll });
  if (!motion || mark === undefined) return poll();
  let from = mark;
  for (;;) {
    const left = deadline - io.now();
    if (left <= 0) return null;
    const r = await motion.settle(from, { changeWithinMs: w.scroll ? Math.min(left, SCROLL_CHANGE_WITHIN_MS) : left, stillMs: settle.stillMs, maxMs: left });
    if (r === "lost") return poll();
    if (r === "none") {
      if (w.scroll) return null;
      // Nothing moved in the picture. One look at the tree before calling it a tap that did nothing:
      // a switch flipping at the edge of the screen while a scroll indicator was still fading there is
      // a change the picture cannot tell from the fade (`screen-motion.ts`).
      try {
        const tree = await io.read();
        return signature(tree) !== before ? tree : null;
      } catch {
        return null;
      }
    }
    from = motion.mark();
    let tree: WalkTree;
    try { tree = await io.read(); } catch { continue; }
    if (signature(tree) !== before) return tree;
    // The picture moved and the tree did not: a scroll that bounced off the end of its list, or a
    // highlight on a tap still being answered. A scroll is done; a tap waits on.
    if (w.scroll || r === "moving") return null;
  }
}

/** How long an app just launched may take to come to the front with its first screen drawn. */
const LAUNCH_TIMEOUT_MS = 10_000;

/**
 * The first read — once the picture is at rest, when there is one to watch — asked again through the
 * "not yet" a device answers while it animates. For an app launched just now, read until the screen
 * is that app's and two reads agree.
 */
async function firstRead(io: ExecIO, settle: Settle, launched: string | undefined): Promise<WalkTree> {
  await io.motion?.rest({ stillMs: settle.stillMs, maxMs: settle.tapTimeoutMs });
  const deadline = io.now() + (launched === undefined ? settle.tapTimeoutMs : LAUNCH_TIMEOUT_MS);
  const read = async (): Promise<WalkTree> => {
    for (;;) {
      try { return await io.read(); } catch (e) {
        if (io.now() >= deadline) throw e;
        await io.sleep(Math.max(settle.pollMs, 100));
      }
    }
  };
  let tree = await read();
  if (launched === undefined) return tree;
  const want = fold(launched);
  for (let sig: string | null = null; io.now() < deadline;) {
    const next = fold(tree.app) === want ? signature(tree) : null;
    if (next !== null && next === sig) break;
    sig = next;
    await io.sleep(settle.pollMs);
    tree = await read();
  }
  return tree;
}

const observed = (el: SimulatorAxElement): ObservedElement =>
  ({ id: el.path, role: el.role, label: el.label, ...(el.value ? { value: el.value } : {}) });

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
