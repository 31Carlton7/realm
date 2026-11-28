import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chordsForCommand, displayKeyChord, type Item } from "@realm/contracts";
import { spaceColor } from "@realm/ui";
import { useApp, useAppStore, useProfileSpaces, type SpacePageTab } from "../../state/store";
import { useResolvedMode } from "../../theme/useTheme";
import { listedSessions, orderSpaces, type SessionRow, type SidebarState } from "./model";

/** The store slices `model.ts` reads, memoised so a derivation re-runs only when one of them moves. */
export function useSidebarState(): SidebarState {
  const spaces = useApp((s) => s.spaces);
  const profiles = useApp((s) => s.profiles);
  const activeProfileId = useApp((s) => s.activeProfileId);
  const activeSpaceId = useApp((s) => s.activeSpaceId);
  const items = useApp((s) => s.items);
  const heldSpaces = useApp((s) => s.heldSpaces);
  const allItems = useApp((s) => s.allItems);
  const sessions = useApp((s) => s.sessions);
  const allSessions = useApp((s) => s.allSessions);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const sessionSpace = useApp((s) => s.sessionSpace);
  const sessionUpdatedAt = useApp((s) => s.sessionUpdatedAt);
  const sessionActivityAt = useApp((s) => s.sessionActivityAt);
  const quickChatId = useApp((s) => (s.quickChat && !s.quickChat.keptIn ? s.quickChat.sessionId : null));
  return useMemo(() => ({ spaces, profiles, activeProfileId, activeSpaceId, items, heldSpaces, allItems, sessions, allSessions, sessionStatus, sessionSpace, sessionUpdatedAt, sessionActivityAt, quickChatId }),
    [spaces, profiles, activeProfileId, activeSpaceId, items, heldSpaces, allItems, sessions, allSessions, sessionStatus, sessionSpace, sessionUpdatedAt, sessionActivityAt, quickChatId]);
}

/** The active profile's spaces, in rail order. */
export function useOrderedSpaces() {
  const spaces = useProfileSpaces();
  const byActivity = useApp((s) => s.sidebarActivityOrder);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const sessionSpace = useApp((s) => s.sessionSpace);
  const sessionActivityAt = useApp((s) => s.sessionActivityAt);
  return useMemo(() => orderSpaces(spaces, byActivity, { sessionStatus, sessionSpace, sessionActivityAt }),
    [spaces, byActivity, sessionStatus, sessionSpace, sessionActivityAt]);
}

/** The rows of the active profile: what the space's Sessions and Recent are drawn from. */
export function useProfileRows(state: SidebarState): SessionRow[] {
  const spaces = useProfileSpaces();
  return useMemo(() => {
    const mine = new Set(spaces.map((sp) => sp.id));
    return listedSessions(state).filter((r) => mine.has(r.spaceId));
  }, [state, spaces]);
}

/** A quiet beat before re-reading a space's items, so a burst of changes is one read. */
export const ALL_ITEMS_SETTLE_MS = 250;

/**
 * Keep `allItems` current while the sidebar is on screen.
 *
 * The window hears `items.changed` for the space it is in and nothing else, so another space's rows
 * would otherwise be as old as the last time the palette opened. Read once on mount. After that the
 * room on screen is put in from its own list, which the window already holds; another space is read
 * alone (`items.list`), a beat after it settles, when one of its sessions is new to the window (a
 * session made anywhere arrives in `sessionSpace`) or changes status (a turn ending is when it gets
 * its title); and every space is read again when the spaces themselves change. Returns the read of
 * every space, for the sidebar's own writes to another space's rows.
 */
export function useAllItemsFresh(): () => void {
  const store = useAppStore();
  const refreshAllItems = useApp((s) => s.refreshAllItems);
  const run = useApp((s) => s.run);
  const items = useApp((s) => s.items);
  const spaces = useApp((s) => s.spaces);
  const sessionSpace = useApp((s) => s.sessionSpace);
  const status = useApp((s) => s.sessionStatus);
  const refresh = useCallback(() => run(() => refreshAllItems()), [run, refreshAllItems]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** What the next beat reads: every space, or these. */
  const owed = useRef<{ all: boolean; spaces: Set<string> }>({ all: false, spaces: new Set() });
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const { all, spaces: ids } = owed.current;
      owed.current = { all: false, spaces: new Set() };
      if (all) { refresh(); return; }
      for (const id of ids) run(() => store.getState().refreshSpaceItems(id));
    }, ALL_ITEMS_SETTLE_MS);
  }, [refresh, run, store]);
  const owe = useCallback((spaceId: string | null | undefined) => {
    if (!spaceId) return;
    owed.current.spaces.add(spaceId);
    flush();
  }, [flush]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; refresh(); return; }
    owed.current.all = true;
    flush();
  }, [spaces, refresh, flush]);
  // The room on screen, from the list the window holds (which carries a few rows of other spaces too,
  // and only the room's own are its whole list). An empty one cannot be told from a list not read yet
  // (a space switch clears it first), so that one is read.
  useEffect(() => {
    const { activeSpaceId } = store.getState();
    if (!activeSpaceId) return;
    const own = items.filter((i) => i.spaceId === activeSpaceId);
    if (own.length > 0) store.getState().putSpaceItems(activeSpaceId, own);
    else owe(activeSpaceId);
  }, [items, store, owe]);
  const seen = useRef({ status, sessionSpace });
  useEffect(() => {
    const was = seen.current;
    seen.current = { status, sessionSpace };
    if (was.status === status && was.sessionSpace === sessionSpace) return;
    const active = store.getState().activeSpaceId;
    for (const id of Object.keys(sessionSpace)) {
      if (was.status[id] === status[id] && id in was.sessionSpace) continue;
      if (sessionSpace[id] !== active) owe(sessionSpace[id]);
    }
  }, [status, sessionSpace, store, owe]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return refresh;
}

/** The user's own chord for a command, as it prints — or nothing for a command they unbound. */
export function useChord(command: string): string | undefined {
  const keybindings = useApp((s) => s.keybindings);
  return useMemo(() => {
    const chord = chordsForCommand(keybindings, command)[0];
    return chord ? displayKeyChord(chord) : undefined;
  }, [keybindings, command]);
}

/** A space's colour as the face on screen can carry it (`spaceColor`'s contrast clamp). */
export function useSpaceTint(hex: string | undefined): string | undefined {
  const themePref = useApp((s) => s.themePref);
  const mode = useResolvedMode(themePref);
  return hex ? spaceColor(hex, mode) : undefined;
}

/**
 * Open an item from any space.
 *
 * A session goes through `revealSession`, the one path every list of sessions takes. Anything else —
 * a pinned document or site in another space — still needs its own room on screen first.
 */
export function useOpenAnywhere(): (item: Item) => void {
  const revealSession = useApp((s) => s.revealSession);
  const revealItem = useApp((s) => s.revealItem);
  const run = useApp((s) => s.run);
  // Both read a space not read yet before opening in it, so any item opens where it is, from any list.
  return useCallback((item: Item) => run(async () => {
    if (item.kind === "session") await revealSession(item.refId, item.spaceId);
    else await revealItem(item.id, item.spaceId);
  }), [revealSession, revealItem, run]);
}

/** A new session in a given space — an empty space's New session. */
export function useNewSessionIn(): (spaceId: string) => void {
  const newSessionInstant = useApp((s) => s.newSessionInstant);
  const run = useApp((s) => s.run);
  // The space named outright — the create actions take one now that there is no room.
  return useCallback((spaceId: string) => run(async () => {
    await newSessionInstant(null, undefined, spaceId);
  }), [newSessionInstant, run]);
}

/** A space's own page — the title's "···", a tile's menu, a pane bar's breadcrumb — on a given tab, or on
 *  whichever it last showed. */
export function useOpenSpacePage(): (spaceId: string, tab?: SpacePageTab) => void {
  const openSpacePage = useApp((s) => s.openSpacePage);
  // Any space of the profile has a page to show — there is no room to walk into first.
  return useCallback((spaceId: string, tab?: SpacePageTab) => openSpacePage(spaceId, tab), [openSpacePage]);
}

/** Put a session row away, from whichever space it is in. */
export function useArchiveAnywhere(refreshAll: () => void): (item: Item) => void {
  const archiveItem = useApp((s) => s.archiveItem);
  const run = useApp((s) => s.run);
  // One path for every space's row: the view is the window's, so its pane (if any) closes first.
  return useCallback((item: Item) => run(async () => {
    await archiveItem(item.id, true);
    refreshAll();
  }), [archiveItem, run, refreshAll]);
}

/** `Date.now()`, again each minute: what a list of "5m"s needs to stay true while it is open. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
