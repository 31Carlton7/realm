import { PAGE_REF_IDS, type Item } from "@realm/contracts";

/**
 * What a window last showed of one space: the item whose pane had the keyboard there, and the page
 * over it if one was up. Going back to the space puts exactly this back — never the space's newest
 * session, which is whatever ran last in the background while the person was somewhere else.
 *
 * `itemId` is null for a page left up over a space with nothing focused in it. A screen with neither
 * is never recorded.
 */
export type SpaceScreen = { itemId: string | null; page: { kind: Item["kind"]; refId: string } | null };

/** By space id. */
export type SpaceScreens = Record<string, SpaceScreen>;

/** Keyed like the window's view (`viewSettingKey`): a window opened for one space keeps its own. */
export const screensSettingKey = (profileId: string, spaceId?: string | null): string =>
  spaceId ? `ui.spaceScreens:${profileId}:${spaceId}` : `ui.spaceScreens:${profileId}`;

const isPageKind = (kind: unknown): kind is Item["kind"] =>
  kind === "space-page" || (typeof kind === "string" && Object.hasOwn(PAGE_REF_IDS, kind));

export const sameScreen = (a: SpaceScreen | undefined, b: SpaceScreen): boolean =>
  a !== undefined && a.itemId === b.itemId && a.page?.kind === b.page?.kind && a.page?.refId === b.page?.refId;

/** The stored map, keeping only entries this build can put back. A page kind it does not know is
 *  dropped with its entry rather than shown as a blank overlay. */
export function parseSpaceScreens(raw: unknown): SpaceScreens {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const screens: SpaceScreens = {};
  for (const [spaceId, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    const { itemId, page } = entry as { itemId?: unknown; page?: { kind?: unknown; refId?: unknown } | null };
    const kind = page?.kind;
    const refId = page?.refId;
    const kept: SpaceScreen = {
      itemId: typeof itemId === "string" ? itemId : null,
      page: isPageKind(kind) && typeof refId === "string" ? { kind, refId } : null,
    };
    if (kept.itemId || kept.page) screens[spaceId] = kept;
  }
  return screens;
}
