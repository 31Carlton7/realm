import { useMemo } from "react";
import type { Item, Space } from "@realm/contracts";
import { useApp, type AppState } from "./store";
import { pageHidesSidebar } from "./page-item";

/**
 * What the sidebar reads now that every space of the profile is loaded at once (Plan 27): the spaces
 * as sections of one list, the pins across them, and the space the session in focus works in. Pure
 * functions of the store, plus hooks memoised on exactly the fields each one reads — the selectors
 * build fresh arrays, which `useApp` alone would re-render on every write in the app.
 */

/** One space of the window's profile and its sessions, newest first. */
export type SpaceSessions = { space: Space; sessions: Item[] };

type SessionClock = Pick<AppState, "sessionActivityAt" | "sessions">;

/** When a session's conversation last moved (`sessionActivityAt`), else its row's, else its making. */
function movedAt(s: SessionClock, item: Item): number {
  return s.sessionActivityAt[item.refId] ?? s.sessions[item.refId]?.activityAt ?? item.createdAt;
}

/** The active profile's spaces, in their own sort order. */
function profileSpaces(s: Pick<AppState, "spaces" | "activeProfileId">): Space[] {
  return s.activeProfileId === null ? [] : s.spaces.filter((sp) => sp.profileId === s.activeProfileId);
}

/** Every space of the active profile, in its sort order, each with its session items newest first.
 *  Archived sessions are left out: they belong to the space's own page, not the list. */
export function sessionsBySpace(s: Pick<AppState, "spaces" | "activeProfileId" | "items" | "sessions" | "sessionActivityAt">): SpaceSessions[] {
  return profileSpaces(s).map((space) => ({
    space,
    sessions: s.items.filter((i) => i.spaceId === space.id && i.kind === "session" && !i.archived)
      .sort((a, b) => movedAt(s, b) - movedAt(s, a)),
  }));
}

/** The user's pinned items across every space of the active profile — sessions, documents, sites —
 *  in the spaces' order, then each space's own. `items` holds the active profile's spaces and no
 *  other's, so the pins are already the profile's. */
export function pinnedItems(s: Pick<AppState, "spaces" | "activeProfileId" | "items">): Item[] {
  const order = profileSpaces(s).map((sp) => sp.id);
  return s.items.filter((i) => i.pinned && !i.archived)
    .sort((a, b) => order.indexOf(a.spaceId) - order.indexOf(b.spaceId) || a.sortOrder - b.sortOrder);
}

/** The current space: the space of the session in focus, else the one last current in this profile,
 *  else its first (see `AppState.activeSpaceId`). Where a new session goes when none was named. */
export function currentSpaceId(s: Pick<AppState, "activeSpaceId">): string | null {
  return s.activeSpaceId;
}

export function useSessionsBySpace(): SpaceSessions[] {
  const spaces = useApp((s) => s.spaces);
  const activeProfileId = useApp((s) => s.activeProfileId);
  const items = useApp((s) => s.items);
  const sessions = useApp((s) => s.sessions);
  const sessionActivityAt = useApp((s) => s.sessionActivityAt);
  return useMemo(() => sessionsBySpace({ spaces, activeProfileId, items, sessions, sessionActivityAt }),
    [spaces, activeProfileId, items, sessions, sessionActivityAt]);
}

export function usePinnedItems(): Item[] {
  const spaces = useApp((s) => s.spaces);
  const activeProfileId = useApp((s) => s.activeProfileId);
  const items = useApp((s) => s.items);
  return useMemo(() => pinnedItems({ spaces, activeProfileId, items }), [spaces, activeProfileId, items]);
}

export function useCurrentSpaceId(): string | null {
  return useApp(currentSpaceId);
}

/**
 * Whether the spaces sidebar is away: the person's own collapse, or a page that takes it away
 * (`PAGE_SHELL`) — unless they asked for it back on this page, which lasts exactly as long as the
 * page does (`sidebarOnPage` holds that page's own overlay, and the next page is a new one). The one
 * answer the shell, the sidebar, its toggle and a page's rail all read, so none of them can disagree
 * about whether the column is there.
 */
export function sidebarHidden(s: Pick<AppState, "sidebarCollapsed" | "pageOverlay" | "sidebarOnPage">): boolean {
  const page = s.pageOverlay;
  return page && pageHidesSidebar(page.kind) ? s.sidebarOnPage !== page : s.sidebarCollapsed;
}
