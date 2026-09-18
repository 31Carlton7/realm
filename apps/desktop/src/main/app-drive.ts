import { NO_AGENT_ATTR, type BrowserAction, type BrowserActResult, type BrowserSnapshotResult } from "@realm/contracts";
import { buildSnapshot, markAct, performAct, type CdpSend, type SnapshotIndex } from "./browser-agent";

/**
 * Realm driving its OWN interface: a snapshot of this window's DOM, and acts dispatched into it.
 *
 * ## Why this reuses the browser agent wholesale
 *
 * A browser pane is a `WebContentsView` driven over `webContents.debugger`; Realm's window is a
 * `BrowserWindow` with a `webContents` and the same debugger on it. `buildSnapshot`, `performAct`
 * and `markAct` never knew which of those they were pointed at — they take a `CdpSend` — so pointing
 * them here is a binding, not a port. Everything that path has learned stays true: refs resolved
 * against live geometry, the occlusion check, the agent cursor drawn at the point the input went to,
 * and the controlled-screen frame around the thing being driven.
 *
 * That last one is why no separate overlay is drawn for this. The frame `markAct` injects is
 * `position: fixed; inset: 0` in the document it is injected into, and the document here IS Realm's
 * window — so the mark that says "an agent is controlling this" lands around the whole app, drawn by
 * exactly the code that draws it around a page. `DriveFrame`'s pane scope stays what it is for: a
 * single pty inside a window nobody is otherwise driving.
 *
 * ## The one thing that must never be clickable
 *
 * An agent that can click Realm's buttons can click Realm's OWN permission dialog — approving, on
 * the user's behalf, the very request it is blocked on. There is no permission model that survives
 * that, because every approval in Realm ultimately renders as a button in this window.
 *
 * So the renderer declares what is off limits, with `data-no-agent` on the surfaces that grant
 * things, and `forbiddenAncestor` refuses any ref inside one. The check runs HERE, against the live
 * DOM at act time, for the reason the browser's password refusal runs in the executor: a snapshot
 * taken before a permission card appeared is a fact about a different screen.
 *
 * Marking it in the DOM rather than matching on labels is deliberate. A label is text — it gets
 * reworded, translated, and shared with buttons that grant nothing — while the attribute is a claim
 * the component makes about itself, in the file where someone changing that component will see it.
 *
 * `computer-use` refuses to drive Realm at all (`COMPUTER_FORBIDDEN_BUNDLE_IDS`), and that refusal
 * is what this file is the sanctioned door through. Opening one means inheriting its reason.
 */

/** What a refusal calls a region that carries the attribute with no value, and what it calls one it
 *  could not read at all — the two cases where Realm knows to refuse but not what to name. */
const UNNAMED_REGION = "protected surface";

export type AppDriveDeps = {
  /** CDP into the app window, or null when there is no window (the daemon runs headless). */
  attach(): { send: CdpSend } | null;
};

export class AppDriveHost {
  /** The previous snapshot's fingerprints, so `*[new]` markers mean the same thing here as in a
   *  page. One window, so one index — unlike the browser host, which keys them per view. */
  private index: SnapshotIndex | null = null;
  private accent: string | undefined;

  constructor(private readonly d: AppDriveDeps) {}

  async snapshot(): Promise<BrowserSnapshotResult> {
    const cdp = this.require();
    const { index, ...snapshot } = await buildSnapshot(cdp.send, this.index);
    this.index = index;
    return snapshot;
  }

  /** The live theme's accent, from the renderer — so Realm's own marks are the colour the user
   *  chose, exactly as the browser executor's are. Until one arrives the marks take Realm's default
   *  blue, which is what `DEFAULT_AGENT_ACCENT` is for. */
  setAccent(accent: string): void { this.accent = accent; }

  async act(action: BrowserAction): Promise<BrowserActResult> {
    const cdp = this.require();
    const ref = refOf(action);
    if (ref !== null) {
      const forbidden = await forbiddenAncestor(cdp.send, ref);
      if (forbidden) {
        return {
          ok: false,
          refused: "realm_protected",
          error:
            `that element is inside Realm's ${forbidden}, which no agent may act in. `
            + "Realm never lets an agent answer its own permission request. Say what you need in your reply and let the user click it.",
        };
      }
    }
    // The mark first, then the act, exactly as the browser path orders them: the press flash is what
    // marks the moment, so drawing after would depict the act late.
    await markAct(cdp.send, action, this.accent);
    return performAct(cdp.send, action);
  }

  /** The window went away (closed, or never opened). The next snapshot starts fresh. */
  forget(): void { this.index = null; }

  private require(): { send: CdpSend } {
    const cdp = this.d.attach();
    if (!cdp) throw new Error("Realm's window is not open, so there is nothing to drive.");
    return cdp;
  }
}

/** The ref an action addresses, or null for one that addresses a point rather than an element. */
function refOf(action: BrowserAction): number | null {
  switch (action.kind) {
    case "click": case "type": return action.ref;
    case "key": case "scroll": return action.ref ?? null;
  }
}

/**
 * The name of the forbidden region this ref sits in, or null.
 *
 * Asked of the DOM rather than of the snapshot, because `closest()` walks ancestors and a snapshot
 * line carries no ancestry at all — a button inside a permission card and a button beside one are
 * the same line. The attribute's VALUE is the region's name, so the refusal can say which surface it
 * was, rather than "a forbidden one".
 *
 * A failure here is a refusal, not a pass: this runs on the path that decides whether an agent may
 * press Realm's own Approve button, and "the check errored" is not a reason to let it through.
 */
async function forbiddenAncestor(send: CdpSend, ref: number): Promise<string | null> {
  const fn = `function () {
    try {
      var hit = this.closest && this.closest("[${NO_AGENT_ATTR}]");
      return hit ? (hit.getAttribute("${NO_AGENT_ATTR}") || UNNAMED) : null;
    } catch (e) { return UNNAMED; }
  }`.replace(/UNNAMED/g, JSON.stringify(UNNAMED_REGION));
  try {
    const { object } = (await send("DOM.resolveNode", { backendNodeId: ref })) as { object?: { objectId?: string } };
    // A ref that does not resolve is a ref this code cannot vouch for, on the path that decides
    // whether an agent may press Realm's own Approve button. Refuse.
    if (!object?.objectId) return UNNAMED_REGION;
    const res = (await send("Runtime.callFunctionOn", {
      objectId: object.objectId, functionDeclaration: fn, returnByValue: true,
    })) as { result?: { value?: string | null } };
    return res.result?.value ?? null;
  } catch {
    return UNNAMED_REGION;
  }
}
