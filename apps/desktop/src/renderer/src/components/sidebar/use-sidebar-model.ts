import { useCallback, useEffect, useMemo, useRef } from "react";
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
  const allItems = useApp((s) => s.allItems);
  const sessions = useApp((s) => s.sessions);
  const allSessions = useApp((s) => s.allSessions);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const sessionSpace = useApp((s) => s.sessionSpace);
  const sessionUpdatedAt = useApp((s) => s.sessionUpdatedAt);
  const quickChatId = useApp((s) => s.quickChat?.sessionId ?? null);
  return useMemo(() => ({ spaces, profiles, activeProfileId, activeSpaceId, items, allItems, sessions, allSessions, sessionStatus, sessionSpace, sessionUpdatedAt, quickChatId }),
    [spaces, profiles, activeProfileId, activeSpaceId, items, allItems, sessions, allSessions, sessionStatus, sessionSpace, sessionUpdatedAt, quickChatId]);
}

/** The active profile's spaces, in section order. */
export function useOrderedSpaces() {
  const spaces = useProfileSpaces();
  const byActivity = useApp((s) => s.sidebarActivityOrder);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const sessionSpace = useApp((s) => s.sessionSpace);
  const sessionUpdatedAt = useApp((s) => s.sessionUpdatedAt);
  return useMemo(() => orderSpaces(spaces, byActivity, { sessionStatus, sessionSpace, sessionUpdatedAt }),
    [spaces, byActivity, sessionStatus, sessionSpace, sessionUpdatedAt]);
}

/** The rows of the active profile: what the sections and Recent are drawn from. */
export function useProfileRows(state: SidebarState): SessionRow[] {
  const spaces = useProfileSpaces();
  return useMemo(() => {
    const mine = new Set(spaces.map((sp) => sp.id));
    return listedSessions(state).filter((r) => mine.has(r.spaceId));
  }, [state, spaces]);
}

/** A quiet beat before re-reading every space's items, so a burst of changes is one read. */
export const ALL_ITEMS_SETTLE_MS = 250;

/**
 * Keep `allItems` current while the sidebar is on screen.
 *
 * The window hears `items.changed` for the space it is in and nothing else, so another space's rows
 * would otherwise be as old as the last time the palette opened. Read once on mount, and again — a
 * beat after it settles — whenever something says a row may have changed: this space's list, the
 * set of sessions the window knows about (a session made anywhere arrives in `sessionSpace`), or a
 * status (a turn ending is when a session in another space gets its title). Returns the read itself
 * for the sidebar's own writes to another space's rows.
 */
export function useAllItemsFresh(): () => void {
  const refreshAllItems = useApp((s) => s.refreshAllItems);
  const run = useApp((s) => s.run);
  const items = useApp((s) => s.items);
  const spaces = useApp((s) => s.spaces);
  const known = useApp((s) => Object.keys(s.sessionSpace).length);
  const status = useApp((s) => s.sessionStatus);
  const refresh = useCallback(() => run(() => refreshAllItems()), [run, refreshAllItems]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; refresh(); return; }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; refresh(); }, ALL_ITEMS_SETTLE_MS);
  }, [items, spaces, known, status, refresh]);
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
  // Every space of the profile is loaded, so any item opens where it is, from any section.
  return useCallback((item: Item) => run(async () => {
    if (item.kind === "session") await revealSession(item.refId, item.spaceId);
    else await revealItem(item.id, item.spaceId);
  }), [revealSession, revealItem, run]);
}

/** A new session in a given space — a section's +. */
export function useNewSessionIn(): (spaceId: string, worktree?: boolean) => void {
  const newSessionInstant = useApp((s) => s.newSessionInstant);
  const newSessionInWorktree = useApp((s) => s.newSessionInWorktree);
  const run = useApp((s) => s.run);
  // The section's own space, named outright — the create actions take one now that there is no room.
  return useCallback((spaceId: string, worktree = false) => run(async () => {
    await (worktree ? newSessionInWorktree(null, spaceId) : newSessionInstant(null, undefined, spaceId));
  }), [newSessionInstant, newSessionInWorktree, run]);
}

/** A space's own page — "Show more", a section's ⋯, a pane bar's breadcrumb — on a given tab, or on
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
