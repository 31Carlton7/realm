import { useEffect, useMemo } from "react";
import type { StoreApi } from "zustand";
import { DEFAULT_KEYBINDINGS, type Keybinding } from "@realm/contracts";
import type { AppState } from "../state/store";
import { appCommands } from "./commands";

/**
 * The renderer's half of the menu bar (main/app-menu.ts).
 *
 * It tells main the person's keybindings whenever they load or change, so the menu shows the chords
 * they actually use and main hands exactly those keystrokes to the page. And it runs what the menu
 * sends back: a catalog command id, through the same runner the keystroke uses, so a click and a
 * chord cannot drift apart.
 *
 * A menu click is a deliberate act, so it ignores the `when` clauses that guard a keystroke — "Close
 * Pane" from the menu closes the pane even while the composer has focus, which is what a Mac menu
 * item does. The one exception is a modal sheet: a sheet owns the window until it is answered.
 */
export function useMenuBar(store: StoreApi<AppState>, rules: readonly Keybinding[] = DEFAULT_KEYBINDINGS): void {
  const commands = useMemo(() => appCommands(store), [store]);
  useEffect(() => { window.realm?.setMenuKeybindings?.([...rules]); }, [rules]);
  useEffect(() => window.realm?.onAppCommand?.((command) => {
    if (store.getState().sheet !== null) return;
    commands[command]?.();
  }), [store, commands]);
}
