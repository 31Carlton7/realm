import { itemIdOfLeaf, type Item } from "@realm/contracts";
import type { KeyContext } from "@realm/contracts";
import type { StoreApi } from "zustand";
import { startAppPick } from "../app-pick/start";
import type { AppState } from "../state/store";

/**
 * The app's two halves of the keybinding seam: what the context keys MEAN, and what each command id
 * DOES.
 *
 * Both live here rather than in the hook so the hook is twelve lines of plumbing, and both are
 * ordinary functions over the store so they can be driven from a test without a window.
 *
 * The rule this file holds: **every id in `KEY_COMMANDS` has a runner here.** A catalog entry with
 * nothing behind it is a shortcut a user can set in Settings and then watch do nothing — the honesty
 * rule applied to a list of choices. The converse is deliberately not true: the resolver takes any
 * command id, so a `script.<id>.run` with no runner yet is simply a chord Realm does not consume.
 */

/** A text field, textarea or rich-text editor — where a bare chord is typing, not a command. */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  // xterm focuses a hidden helper <textarea> inside its .xterm root whenever a terminal pane is
  // visible — without this exemption a focused terminal dead-keys every global binding (⌘W was even
  // consumed with no action). None of the meta/ctrl chords bound here conflict with terminal text
  // entry, so terminals are never "editable" for guard purposes.
  if (t.closest(".xterm")) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable;
}

/** Where the user's attention is, as the `when` language sees it. */
export function keyContext(s: AppState, target: EventTarget | null): KeyContext {
  const item = focusedItem(s);
  const sessionId = item?.kind === "session" ? item.refId : null;
  const sheetOpen = s.sheet !== null;
  /* A focused terminal is NOT an input, and the two keys are exclusive on purpose. xterm focuses a
     hidden <textarea> whenever a terminal pane is visible, so treating it as editable would dead-key
     every global chord in the app the moment someone clicked into a shell (measured once: ⌘W was
     consumed with no action at all). `isEditableTarget` already carries that exemption; this is the
     other half of it, published so a `when` clause can say "only in a terminal". */
  const terminalFocus = target instanceof HTMLElement && target.closest(".xterm") !== null;
  return {
    // The media viewer covers the window as the palette does: a pane behind it is not the one a chord
    // should split, close or move off — and a space switched under it would be shown nowhere.
    overlayOpen: s.paletteOpen || s.spacesOpen || sheetOpen || s.viewer !== null,
    paletteOpen: s.paletteOpen,
    spacesOpen: s.spacesOpen,
    sheetOpen,
    inputFocus: isEditableTarget(target),
    terminalFocus,
    paneFocus: item !== null,
    sessionFocus: sessionId !== null,
    sessionRunning: sessionId !== null && statusOf(s, sessionId) === "running",
  };
}

/**
 * Every command id → the thing it runs.
 *
 * Each entry reads `store.getState()` at the moment it fires rather than closing over a snapshot: a
 * keystroke acts on the app as it is when the key goes down, not as it was when the hook mounted.
 *
 * `run()` wraps exactly the actions that are async and can fail, matching what the palette already
 * does for the same calls — it is the store's own error surface, and an unwrapped
 * rejection here would be an unhandled promise instead of a toast.
 */
export function appCommands(store: StoreApi<AppState>): Readonly<Record<string, () => void>> {
  const get = () => store.getState();
  const withSession = (fn: (s: AppState, sessionId: string) => void) => () => {
    const s = get();
    const item = focusedItem(s);
    if (item?.kind === "session") fn(s, item.refId);
  };
  const focusPane = (dir: "left" | "right" | "up" | "down") => () => get().focusNeighbor(dir);
  const stepNav = (delta: number) => () => {
    const s = get();
    if (s.focusedLeafId) s.run(() => s.stepPaneNav(s.focusedLeafId!, delta));
  };
  const selectSpaceSlot = (n: number) => () => {
    const s = get();
    // The nth space OF THE ACTIVE PROFILE, which is the strip the user is looking at. Out of range is
    // a no-op rather than a wrap: ⌘9 in a profile with two spaces means nothing, and wrapping to the
    // second would move the app somewhere nobody asked to go.
    const space = s.profileSpaces()[n - 1];
    if (space) s.run(() => s.selectSpace(space.id));
  };

  return {
    "pane.splitRight": () => { const s = get(); s.run(() => s.splitNewSession("row")); },
    "pane.splitDown": () => { const s = get(); s.run(() => s.splitNewSession("col")); },
    // Layout-only, and never the window: a tab leaves its strip, a pane its split, and a session
    // alone closes nothing — the keyboard goes to its prompter (`closeIntent`). Where there is
    // nothing to close the ⌘W swallow in the hook keeps the key from reaching Electron.
    "pane.close": () => { const s = get(); s.run(() => s.closeInPane()); },
    "pane.toggleFocus": () => { const s = get(); s.run(() => s.toggleFocusPane()); },
    "pane.focusLeft": focusPane("left"),
    "pane.focusRight": focusPane("right"),
    "pane.focusUp": focusPane("up"),
    "pane.focusDown": focusPane("down"),
    "pane.navBack": stepNav(-1),
    "pane.navForward": stepNav(1),
    "pane.rename": () => { const s = get(); const item = focusedItem(s); if (item) s.requestRename(item.id); },
    "pane.newTab": () => { const s = get(); s.run(() => s.newTab()); },
    "pane.newTabFullView": () => { const s = get(); s.run(() => s.newTab(null, { full: true })); },

    "space.next": () => { const s = get(); s.run(() => s.nextSpace()); },
    "space.previous": () => { const s = get(); s.run(() => s.prevSpace()); },
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`space.select.${n}`, selectSpaceSlot(n)])),
    "space.open": () => { const s = get(); if (s.activeSpaceId) s.openSpacePage(s.activeSpaceId); },
    "spaces.toggle": () => { const s = get(); s.setSpacesOpen(!s.spacesOpen); },

    "session.new": () => { const s = get(); s.run(() => s.newSessionInstant()); },
    "session.newInWorktree": () => { const s = get(); s.run(() => s.newSessionInWorktree()); },
    /* Open-only, not a toggle, because closing a quick chat DELETES its session — the sidebar button
       means the same thing by the same name, and `openQuickChat` already no-ops when one is up. */
    "session.quickChat": () => { const s = get(); s.run(() => s.openQuickChat()); },
    "session.attachFiles": withSession((s, id) => s.run(() => s.attachFromPicker(id))),
    // Wherever the focus is: the pick goes to the session a web pick would (`startAppPick`).
    "session.selectInRealm": () => startAppPick(store),
    "session.dispatchDraft": withSession((s, id) => s.run(() => s.dispatchDraft(id))),
    /* The `when` clause already gates this on a running session, and the check is here as well
       because a user may bind the command with no clause at all — and "interrupt" on an idle agent
       would be a gesture that looks like it did something. */
    "session.interrupt": withSession((s, id) => { if (statusOf(s, id) === "running") s.run(() => s.interruptSession(id)); }),
    "terminal.toggle": withSession((s, id) => s.run(() => s.showSessionTerminal(id))),

    "terminal.new": () => { const s = get(); s.run(() => s.newTerminal()); },
    "browser.new": () => { const s = get(); s.run(() => s.newBrowser()); },
    "machine.connect": () => { const s = get(); s.run(() => s.newMachine()); },
    "documents.open": () => { const s = get(); s.run(() => s.openDocuments()); },
    // Opens the diff for the FOCUSED session's checkout. Nothing is focused, or the pane holds
    // something else: nothing happens, because there is no checkout to name.
    "diff.open": withSession((s, id) => {
      const environmentId = s.sessions[id]?.environmentId;
      if (environmentId) s.run(() => s.openDiff(environmentId));
    }),
    "palette.toggle": () => { const s = get(); s.setPaletteOpen(!s.paletteOpen); },
    /* ⌘P is the documents pane's search: one place where a file is found, opened, made and added to
       a message, rather than a palette that found a file and then opened a pane somewhere else. The
       id keeps its old name because people's own keybindings are stored against it. From ⌘⇧P's field
       it is still one keystroke across — the palette goes and the pane's search takes the keyboard. */
    "palette.files": () => { const s = get(); s.run(() => s.findInDocuments()); },
    "palette.grep": () => get().setPaletteOpen(true, "grep"),
    "sidebar.toggle": () => { const s = get(); s.run(() => s.toggleSidebar()); },
    "activity.open": () => { const s = get(); s.run(() => s.openActivity()); },
    "window.back": () => { const s = get(); s.run(() => s.stepWindow(-1)); },
    "window.forward": () => { const s = get(); s.run(() => s.stepWindow(1)); },
    "settings.open": () => get().openDestinationPage("settings-page"),
  };
}

/** The item in the focused leaf, or null when the leaf is empty. A peek's is its own row, which may
 *  be another profile's and so in no list of this window's. */
function focusedItem(s: AppState): Item | null {
  const id = itemIdOfLeaf(s.layout, s.focusedLeafId);
  if (id && s.peek?.item.id === id) return s.peek.item;
  return id ? s.items.find((i) => i.id === id) ?? null : null;
}

/** The live status if one has arrived, else the row's. Same precedence the palette and the pane use;
 *  the live map is ahead of the row between an event and the next refresh. */
const statusOf = (s: AppState, sessionId: string): string | undefined =>
  s.sessionStatus[sessionId] ?? s.sessions[sessionId]?.status;
