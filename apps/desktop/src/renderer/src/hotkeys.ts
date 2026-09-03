import { useEffect } from "react";
import type { StoreApi } from "zustand";
import { itemIdOfLeaf } from "@realm/contracts";
import type { AppState, FocusDir } from "./state/store";

/**
 * Every window-level binding lives here, behind ONE guard policy:
 *   - a handled event (`defaultPrevented`) is never re-handled — overlays and inline editors
 *     (palette Escape, rename inputs) preventDefault what they consume;
 *   - while a sheet or the palette is open, the overlay owns the keyboard — no binding fires;
 *   - an editable target (input/textarea/contenteditable) swallows every binding except the ones
 *     that explicitly opt in via `inInputs` (Esc-to-interrupt must work from the composer).
 *
 * ⌘K is deliberately NOT here: it must toggle while the palette is open and while its own input has
 * focus — both of which this guard forbids — so it stays in usePaletteHotkey with its sheet-only guard.
 * ⌘⇧Space (the space overview) is out for exactly the same reason — see useSpacesHotkey.
 *
 * ⌘W and Electron: with no application menu of our own, Electron installs its default menu, whose
 * File → Close Window carries the ⌘W accelerator. Menu accelerators fire in the main process before
 * the renderer ever sees the keydown, so preventDefault here cannot win. The fix is in
 * apps/desktop/src/main/index.ts: an explicit application menu without a ⌘W item, which lets the
 * event reach this handler. preventDefault is still called unconditionally (belt and braces — a
 * regression in the menu should surface as a dead key, not a closed window).
 */

type Binding = {
  match: (e: KeyboardEvent) => boolean;
  run: (s: AppState, e: KeyboardEvent) => void;
  /** Fire even when the event target is an input/textarea/contenteditable. */
  inInputs?: boolean;
  /** preventDefault even when the guard swallows the action (⌘W must never bubble to Electron). */
  alwaysPrevent?: boolean;
};

export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  // xterm focuses a hidden helper <textarea> inside its .xterm root whenever a terminal pane is
  // visible — without this exemption a focused terminal dead-keys every global binding (⌘W was even
  // consumed with no action). None of the meta/ctrl chords bound here conflict with terminal text
  // entry, so terminals are never "editable" for guard purposes.
  if (t.closest(".xterm")) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable;
}

const mod = (e: KeyboardEvent, want: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean }) =>
  e.metaKey === !!want.meta && e.ctrlKey === !!want.ctrl && e.altKey === !!want.alt && e.shiftKey === !!want.shift;

const ARROWS: Record<string, FocusDir> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

/** The focused leaf's item, if the leaf holds one. */
const focusedItem = (s: AppState) => {
  const id = itemIdOfLeaf(s.layout, s.focusedLeafId);
  return id ? s.items.find((i) => i.id === id) ?? null : null;
};

const BINDINGS: Binding[] = [
  // ⌘\ split right / ⌘⇧\ split down. With shift, a US layout reports "|", so accept both keys and
  // let shift pick the direction.
  {
    match: (e) => (e.key === "\\" || e.key === "|") && e.metaKey && !e.ctrlKey && !e.altKey,
    run: (s, e) => s.run(() => s.splitFocused(e.shiftKey ? "col" : "row")),
  },
  // ⌘1…⌘9 → nth space OF THE ACTIVE PROFILE. Indexing the whole home made the binding both
  // incomplete (spaces 10+ were unreachable) and unstable (a drag in one profile resequenced every
  // other one's numbers); within a profile the nine slots match the strip you are looking at.
  {
    match: (e) => e.key >= "1" && e.key <= "9" && mod(e, { meta: true }),
    run: (s, e) => { const sp = s.profileSpaces()[Number(e.key) - 1]; if (sp) s.run(() => s.selectSpace(sp.id)); },
  },
  // ⌃Tab / ⌃⇧Tab → next / previous space.
  {
    match: (e) => e.key === "Tab" && e.ctrlKey && !e.metaKey && !e.altKey,
    run: (s, e) => s.run(() => (e.shiftKey ? s.prevSpace() : s.nextSpace())),
  },
  // ⌘⌥arrows → directional pane focus.
  {
    match: (e) => e.key in ARROWS && mod(e, { meta: true, alt: true }),
    run: (s, e) => s.focusNeighbor(ARROWS[e.key]!),
  },
  // ⌘W → close the focused pane (layout-only). Never the window; empty leaf = no-op.
  {
    match: (e) => e.key.toLowerCase() === "w" && mod(e, { meta: true }),
    alwaysPrevent: true,
    run: (s) => { const it = focusedItem(s); if (it) s.run(() => s.closeFromLayout(it.id)); },
  },
  // ⌘⇧F → focus the focused pane full-screen, or unfocus if it already is. The pane stays in its
  // group either way — this only changes how much of the space it gets (see groups.ts).
  {
    match: (e) => e.key.toLowerCase() === "f" && mod(e, { meta: true, shift: true }),
    run: (s) => s.run(() => s.toggleFocusPane()),
  },
  // ⌘⇧[ / ⌘⇧] → previous / next pane group. A US layout reports "{" and "}" with shift held, so both
  // the shifted and unshifted keys are accepted, exactly as ⌘⇧\ does above.
  {
    match: (e) => (e.key === "]" || e.key === "}") && mod(e, { meta: true, shift: true }),
    run: (s) => s.run(() => s.stepPaneGroup(1)),
  },
  {
    match: (e) => (e.key === "[" || e.key === "{") && mod(e, { meta: true, shift: true }),
    run: (s) => s.run(() => s.stepPaneGroup(-1)),
  },
  // ⌘[ / ⌘] → back / forward along the FOCUSED pane's own trail. Deliberately the same bracket pair
  // as group stepping one shift away: both are "move along a sequence", and the unshifted (smaller)
  // gesture is the smaller move — within one pane rather than between arrangements.
  {
    match: (e) => e.key === "[" && mod(e, { meta: true }),
    run: (s) => { const l = s.focusedLeafId; if (l) s.run(() => s.stepPaneNav(l, -1)); },
  },
  {
    match: (e) => e.key === "]" && mod(e, { meta: true }),
    run: (s) => { const l = s.focusedLeafId; if (l) s.run(() => s.stepPaneNav(l, 1)); },
  },
  // ⌘T → new terminal.
  {
    match: (e) => e.key.toLowerCase() === "t" && mod(e, { meta: true }),
    run: (s) => s.run(() => s.newTerminal()),
  },
  // ⌘B → collapse/restore the sidebar. No `inInputs`: ⌘B is bold in every rich text field on the
  // platform, and the composer is a rich editor — a global steal would break bolding in the one
  // place the hand most often is. The toggle button itself is always on screen in both states, so
  // the guard costs nothing but a click.
  {
    match: (e) => e.key.toLowerCase() === "b" && mod(e, { meta: true }),
    run: (s) => s.run(() => s.toggleSidebar()),
  },
  // ⌘N → new session, immediately (W3): no sheet, no questions — last-used agent, straight to the
  // hero prompter, which carries every choice.
  {
    match: (e) => e.key.toLowerCase() === "n" && mod(e, { meta: true }),
    run: (s) => s.run(() => s.newSessionInstant()),
  },
  // ⌘U → attach files to the focused session (Plan 12 W1 — the "+" menu's Add files, whose ⌘U label
  // is purely visual per the Menu contract; THIS is the one binding). `inInputs` for the same reason
  // ⌘J earns it: the hand that reaches for it is in the composer, an editable target the guard would
  // otherwise swallow — and ⌘U types nothing there.
  {
    match: (e) => e.key.toLowerCase() === "u" && mod(e, { meta: true }),
    inInputs: true,
    run: (s) => { const it = focusedItem(s); if (it?.kind === "session") s.run(() => s.attachFromPicker(it.refId)); },
  },
  // ⌘J → show/hide the focused session's terminal drawer (W4). `inInputs` on purpose: the two places
  // your hands ever are in a session pane are the composer (an editable target, which the guard would
  // otherwise swallow) and the drawer itself (exempted by isEditableTarget's .xterm clause) — a toggle
  // that only worked from neither would be dead. ⌘J types nothing in either.
  {
    match: (e) => e.key.toLowerCase() === "j" && mod(e, { meta: true }),
    inInputs: true,
    run: (s) => { const it = focusedItem(s); if (it?.kind === "session") s.run(() => s.toggleTerminalPanel(it.refId)); },
  },
  // ⌘⇧↩ → dispatch the focused session's draft (Plan 13 W2): one gesture creates a session, sends
  // the draft there, and brings the new pane in beside WITHOUT stealing focus. `inInputs` because it
  // fires FROM the composer — the one editable target the hand is in; plain ⌘↩ (send) stays the
  // composer's own handler, which deliberately ignores the shifted chord so it reaches us here.
  {
    match: (e) => e.key === "Enter" && mod(e, { meta: true, shift: true }),
    inInputs: true,
    run: (s) => { const it = focusedItem(s); if (it?.kind === "session") s.run(() => s.dispatchDraft(it.refId)); },
  },
  // Esc → interrupt the focused pane's running session (U-L9). Works from the composer.
  {
    match: (e) => e.key === "Escape" && mod(e, {}),
    inInputs: true,
    run: (s) => {
      const it = focusedItem(s);
      if (it?.kind === "session" && (s.sessionStatus[it.refId] ?? s.sessions[it.refId]?.status) === "running") {
        s.run(() => s.interruptSession(it.refId));
      }
    },
  },
];

/** Bind once at the app root. Owns every window-level shortcut except ⌘K (see above). */
export function useGlobalHotkeys(store: StoreApi<AppState>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // someone closer to the target already consumed it
      const s = store.getState();
      const b = BINDINGS.find((x) => x.match(e));
      if (!b) return;
      if (s.sheet || s.paletteOpen || s.spacesOpen) { if (b.alwaysPrevent) e.preventDefault(); return; }
      if (isEditableTarget(e.target) && !b.inInputs) { if (b.alwaysPrevent) e.preventDefault(); return; }
      e.preventDefault();
      b.run(s, e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);
}
