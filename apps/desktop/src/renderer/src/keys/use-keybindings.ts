import { useEffect, useMemo, useRef } from "react";
import type { StoreApi } from "zustand";
import {
  ALWAYS_SWALLOWED_CHORDS, DEFAULT_KEYBINDINGS, commandForChord, type Keybinding,
} from "@realm/contracts";
import type { AppState } from "../state/store";
import { chordFromEvent } from "./chord";
import { appCommands, keyContext } from "./commands";

/**
 * The window-level keyboard, driven by rules instead of by code.
 *
 * Bind once at the app root. Every keystroke takes the same four steps — what chord is this, what is
 * happening right now, what does the user's file say that runs, and is there something to run — and
 * there is no per-binding guard left anywhere, because a guard is now a `when` clause in the file.
 *
 * Two things it will NOT do, both for the same reason (a key Realm eats and does nothing with is a
 * key the user cannot use for anything else):
 *
 *  - A chord whose winning rule unbinds it (`command: ""`) is not consumed.
 *  - A chord bound to a command with no runner — an id from a newer Realm in an older one's file, or
 *    a `script.<id>.run` naming a script THIS space does not define — is not consumed either. The
 *    resolver takes any id on purpose; this is where "any id" stops being a promise Realm can keep,
 *    and the honest response is to let the keystroke through rather than swallow it silently. Note
 *    the script case is settled by asking the server, not by the id's shape: a well-formed id for
 *    another space's script is exactly the case that must NOT become a dead key.
 *
 * `ALWAYS_SWALLOWED_CHORDS` is the one exception, and it is about ⌘W reaching Electron's default
 * menu — see the constant for why a dead key beats a closed window.
 */
export function useKeybindings(store: StoreApi<AppState>, rules: readonly Keybinding[] = DEFAULT_KEYBINDINGS): void {
  const commands = useMemo(() => appCommands(store), [store]);
  /* The rules live in a ref so a keymap arriving from the server (or being edited in Settings) does
     not tear down and re-add the window listener. The listener is registered once per store; what it
     reads changes underneath it. */
  const live = useRef(rules);
  useEffect(() => { live.current = rules; }, [rules]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // someone closer to the target already consumed it
      const chord = chordFromEvent(e);
      if (chord === null) return;
      if (ALWAYS_SWALLOWED_CHORDS.includes(chord)) e.preventDefault();
      const command = commandForChord(live.current, chord, keyContext(store.getState(), e.target));
      if (command === null) return;
      const run = commands[command];
      if (run) { e.preventDefault(); run(); return; }
      /* Project scripts are the one open-ended half of the id namespace: `appCommands` is a fixed
         catalogue and a space can define scripts at any time, so they cannot be in it. Parse rather
         than prefix-match, so only a well-formed `script.<id>.run` is claimed, and swallow the key
         only once the store confirms this space owns that script — a binding left over from another
         space has to reach the browser rather than becoming a dead key. */
      /* Project scripts are the one open-ended half of the id namespace: `appCommands` is a fixed
         catalogue and a space can define scripts at any time, so they cannot be in it. The check is
         SYNCHRONOUS against the store's copy of this space's scripts, because `preventDefault` after
         an await is a no-op — asking the server here would swallow the key first and learn whether it
         should have second. A binding naming another space's script therefore reaches the browser,
         which is the honest outcome for a key this space cannot service. */
      const state = store.getState();
      if (!state.ownsScriptCommand(command)) return;
      e.preventDefault();
      state.run(async () => { await state.runScriptCommand(command); });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, commands]);
}
