import { AGENT_MARK_ATTR, AGENT_MARK_FRAME, chordsForCommand, displayKeyChord } from "@realm/contracts";
import { useMemo } from "react";
import type { StoreApi } from "zustand";
import { sessionForPick } from "../panes/browser/pick-target";
import { useApp, useAppStore, type AppState } from "../state/store";

/** The keybinding catalog's id for it (`KEY_COMMANDS`). */
export const SELECT_IN_REALM = "session.selectInRealm";

/**
 * Put the picker up for `sessionId`'s prompter — the + menu names its own — or for the session a web
 * pick would go to. Again while it is up, it comes down: ⌘⇧C is a toggle, as the web picker's button is.
 *
 * Refused while an agent is driving the window: the controlled-screen frame `markAct` draws is in this
 * document for exactly as long as one is acting in it, and a pick begun then — by a Return the agent
 * pressed on a focused menu row — would be the agent's, not the person's. The row refuses an agent's
 * click by itself (`data-no-agent`); this is what refuses its keys.
 */
export function startAppPick(store: StoreApi<AppState>, sessionId?: string): void {
  const s = store.getState();
  if (s.appPick) { s.setAppPick(null); return; }
  if (document.querySelector(`[${AGENT_MARK_ATTR}="${AGENT_MARK_FRAME}"]`)) {
    s.toast({ tone: "warning", text: "An agent is driving Realm's window. Select in Realm when it has finished." });
    return;
  }
  const target = sessionId ?? sessionForPick(s.items, s.layout, s.focusedLeafId)?.refId;
  if (!target) { s.toast({ text: "Nothing to send a part of Realm to — open a session pane first.", icon: "select" }); return; }
  s.setAppPick(target);
}

/** The + menu's row for a session's prompter: the pick goes to THIS prompter, and the hint beside it is
 *  the person's own chord for the command, so a rebinding in Settings ▸ Keys is what the menu says. */
export function useSelectInRealm(sessionId: string): { onSelect: () => void; kbd?: string } {
  const store = useAppStore();
  const chord = useApp((s) => chordsForCommand(s.keybindings, SELECT_IN_REALM)[0] ?? null);
  return useMemo(() => ({ onSelect: () => startAppPick(store, sessionId), kbd: chord ? displayKeyChord(chord) : undefined }), [store, sessionId, chord]);
}
