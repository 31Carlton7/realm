import { acceleratorForChord, platformCapabilities, type QuickChatShortcutState } from "@realm/contracts";
import { restoredBounds, type SavedWindow } from "./window-state";

/**
 * The quick chat panel: the Quick Chat in a small window of its own, over whatever app is in front.
 *
 * It is not one of Realm's windows (window-registry.ts). It shows no space, has no browser pane and
 * is never restored, so it is made here and kept out of that registry; it opens with no Realm window
 * open, and opening it brings none forward.
 *
 * How it opens was measured on macOS 27.3 with Electron 45.3.0 (spike K0, 2026-11-20): a
 * `type: "panel"` window shown with `showInactive()` and then given the keyboard with `focus()`
 * left the front app as it was, and a page in the app behind heard no `blur` and no
 * `visibilitychange`. `hide()` gives the keyboard back.
 *
 * Electron-free, so the rules below are held by a unit test rather than by a live run.
 */

/** The in-window card's size (QuickChat.tsx), so the same chat reads the same in both places. */
export const QUICK_CHAT_PANEL_SIZE = { width: 380, height: 520 } as const;

/** What the panel's renderer is told it is (`window.realm.surface`). */
export const QUICK_CHAT_SURFACE = "quick-chat";

/**
 * The options that gave a panel which takes typing without changing the front app. The title is
 * empty because a window kept out of a capture is still listed by name to the app capturing.
 */
export const QUICK_CHAT_PANEL_OPTIONS = {
  frame: false, show: false, focusable: true, skipTaskbar: true, title: "",
  resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
  ...QUICK_CHAT_PANEL_SIZE,
} as const;

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Where the panel opens: where it was dragged to while enough of that is still on a display,
 * otherwise centred a fifth of the way down the display the pointer is on, which is the one the
 * person is working on.
 */
export function quickChatPanelPlace(saved: SavedWindow | null, displays: Rect[], current: Rect): { x: number; y: number } {
  const kept = restoredBounds(saved && { ...saved, ...QUICK_CHAT_PANEL_SIZE }, displays,
    { ...QUICK_CHAT_PANEL_SIZE, minWidth: QUICK_CHAT_PANEL_SIZE.width, minHeight: QUICK_CHAT_PANEL_SIZE.height });
  if (!kept.center) return { x: kept.x, y: kept.y };
  return {
    x: Math.round(current.x + (current.width - QUICK_CHAT_PANEL_SIZE.width) / 2),
    y: Math.round(current.y + Math.max(0, current.height - QUICK_CHAT_PANEL_SIZE.height) / 5),
  };
}

/**
 * Where Fn , and Fn . move the panel: the next of three places along its display, its left edge, the
 * middle and its right edge, at the height it is at. Between two places it goes to the next one in
 * that direction; at an edge it stays.
 */
export function quickChatPanelStep(x: number, area: Rect, direction: -1 | 1): number {
  const stops = [area.x, Math.round(area.x + (area.width - QUICK_CHAT_PANEL_SIZE.width) / 2), area.x + area.width - QUICK_CHAT_PANEL_SIZE.width];
  if (direction < 0) return [...stops].reverse().find((stop) => stop < x) ?? stops[0]!;
  return stops.find((stop) => stop > x) ?? stops[2]!;
}

export type PanelWindow = {
  isDestroyed(): boolean;
  isVisible(): boolean;
  showInactive(): void;
  focus(): void;
  hide(): void;
  destroy(): void;
  setContentProtection(on: boolean): void;
  webContents: { focus(): void; send(channel: string): void };
};

/**
 * Whether the panel made ahead waits for the first Realm window to draw. Made at launch, its renderer
 * loaded beside the main window's: 157 MB working set against 91 MB for a browser pane (the built
 * app, 2026-11-20). `REALM_QUICK_CHAT_PREPARE_AT_LAUNCH=1` makes it at launch again, for the live
 * script that measures the two.
 */
export function quickChatPanelWaitsForDraw(env: Record<string, string | undefined>): boolean {
  return env.REALM_QUICK_CHAT_PREPARE_AT_LAUNCH !== "1";
}

export class QuickChatPanel<W extends PanelWindow> {
  private made: { win: W; ready: Promise<unknown> } | null = null;
  private wanted = false;
  private hiddenFromSharing = true;
  private waiting: boolean;
  private askedAhead = false;

  /** `create` makes the window, hidden, and says when its page has loaded. Null while it cannot be
   *  made (no server to connect its page to). Off macOS (`platformCapabilities().quickChatPanel`)
   *  no window is ever made. With `waitForDraw`, nothing is made ahead until `windowDrawn()`. */
  constructor(private readonly create: () => { win: W; ready: Promise<unknown> } | null, private readonly platform = "darwin", { waitForDraw = false } = {}) {
    this.waiting = waitForDraw;
  }

  /** A Realm window has drawn: a panel asked for ahead of time is made now. */
  windowDrawn(): void {
    if (!this.waiting) return;
    this.waiting = false;
    if (this.askedAhead) this.prepare();
  }

  /** The window, once it has been made and until it is destroyed. */
  window(): W | null {
    return this.made && !this.made.win.isDestroyed() ? this.made.win : null;
  }

  isOpen(): boolean {
    return this.wanted && this.window() !== null;
  }

  /** Open it, or put it away. */
  toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  /** Make the window now, hidden, so the first open does not wait on a page load: made on the key
   *  press, the first open measured 151 to 347 ms to the panel on screen against 3 to 11 ms for the
   *  next (the built app, 2026-11-20). Nothing is shown and no chat is started until it opens. */
  prepare(): void {
    if (!platformCapabilities(this.platform).quickChatPanel || this.window()) return;
    if (this.waiting) { this.askedAhead = true; return; }
    const made = this.create();
    this.made = made;
    if (made) void made.ready.catch(() => this.forget(made));
  }

  /** Made ahead while a key opens it from another app: its chord, a double-tap of Command, the
   *  assistant's chords, or a call starting with "Start the assistant when a call starts" on. With
   *  none, a window made ahead is destroyed rather than kept hidden, so no renderer is held for a
   *  panel nothing can open; one that is open is left to be put away, and so is one whose page is
   *  listening, which would end the run and lose its notes. */
  prepareFor(keys: { chord: boolean; doubleTap: boolean; assistant?: boolean; autoStart?: boolean }, listening = false): void {
    if (keys.chord || keys.doubleTap || keys.assistant || keys.autoStart) {
      this.prepare();
      return;
    }
    this.askedAhead = false;
    if (this.made && !this.isOpen() && !listening) this.forget(this.made);
  }

  /** The window is made on the first open, unless `prepare` made it already, and kept, so the next
   *  one does not wait on a page load. */
  open(): void {
    this.show(true);
  }

  /** Open it and leave the keyboard with the app in front: the assistant's keys but its type key. */
  openInactive(): void {
    this.show(false);
  }

  private show(focus: boolean): void {
    if (!platformCapabilities(this.platform).quickChatPanel) return;
    if (!this.window()) this.made = this.create();
    const made = this.made;
    if (!made) return;
    this.wanted = true;
    void made.ready.then(() => {
      const win = this.window();
      if (!this.wanted || win !== made.win) return;
      win.setContentProtection(this.hiddenFromSharing);
      win.showInactive();
      if (focus) {
        win.focus();
        win.webContents.focus();
      }
      win.webContents.send("quick-chat-panel:shown");
    }, () => this.forget(made));
  }

  /** A page that failed to load is not kept: the next open makes a new window, and loads again. */
  private forget(made: { win: W; ready: Promise<unknown> }): void {
    if (this.made !== made) return;
    this.wanted = false;
    this.made = null;
    if (!made.win.isDestroyed()) made.win.destroy();
  }

  close(): void {
    this.wanted = false;
    const win = this.window();
    if (win?.isVisible()) win.hide();
  }

  /** Whether the panel is left out of screen shares and recordings. Applied at once to a panel that
   *  exists, and to each one made after. */
  setHiddenFromSharing(on: boolean): void {
    this.hiddenFromSharing = on;
    this.window()?.setContentProtection(on);
  }
}

/**
 * The system-wide chord that toggles the panel, through Electron's `globalShortcut`.
 *
 * `registered: false` is what Settings reports: the system refused the chord. Another app holding the
 * same chord is not that case on macOS: measured on 27.3, a second process registering a chord
 * this one held was told yes as well.
 */
export class QuickChatShortcut {
  private state: QuickChatShortcutState = { chord: null, registered: false };
  private held: string | null = null;

  constructor(private readonly deps: {
    register: (accelerator: string, press: () => void) => boolean;
    unregister: (accelerator: string) => void;
    press: () => void;
    platform?: string;
  }) {}

  current(): QuickChatShortcutState {
    return this.state;
  }

  /** Replace the chord. `null`, or a chord that cannot be a system-wide key, leaves none registered,
   *  and so does any chord off macOS, where there is no panel for it to open. */
  set(chord: string | null): QuickChatShortcutState {
    this.release();
    const offered = platformCapabilities(this.deps.platform ?? "darwin").quickChatPanel;
    const accelerator = chord === null || !offered ? null : acceleratorForChord(chord, this.deps.platform);
    if (accelerator === null) return (this.state = { chord: null, registered: false });
    let registered = false;
    try { registered = this.deps.register(accelerator, this.deps.press); } catch { /* an accelerator Electron cannot parse */ }
    if (registered) this.held = accelerator;
    return (this.state = { chord, registered });
  }

  /** Give the chord back to the system. */
  release(): void {
    if (this.held !== null) this.deps.unregister(this.held);
    this.held = null;
  }
}
