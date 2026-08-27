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
  // ⌘1…⌘9 → nth space.
  {
    match: (e) => e.key >= "1" && e.key <= "9" && mod(e, { meta: true }),
    run: (s, e) => { const sp = s.spaces[Number(e.key) - 1]; if (sp) s.run(() => s.selectSpace(sp.id)); },
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
  // ⌘T → new terminal.
  {
    match: (e) => e.key.toLowerCase() === "t" && mod(e, { meta: true }),
    run: (s) => s.run(() => s.newTerminal()),
  },
  // ⌘N → new session sheet.
  {
    match: (e) => e.key.toLowerCase() === "n" && mod(e, { meta: true }),
    run: (s) => s.openSheet({ kind: "new-session" }),
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
      if (s.sheet || s.paletteOpen) { if (b.alwaysPrevent) e.preventDefault(); return; }
      if (isEditableTarget(e.target) && !b.inInputs) { if (b.alwaysPrevent) e.preventDefault(); return; }
      e.preventDefault();
      b.run(s, e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);
}
