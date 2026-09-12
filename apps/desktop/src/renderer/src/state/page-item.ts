import { PAGE_REF_IDS, type DestinationPageKind, type Item } from "@realm/contracts";

/**
 * The `Item` an app-level page is handed, built rather than stored.
 *
 * These pages stopped being layout items: opening one used to split a pane, zoom it and leave a row
 * in the sidebar, so reading your notifications rearranged the workspace. They are an overlay now
 * (`pageOverlay`). But the page COMPONENTS are unchanged, because what they want from an `Item` is a
 * kind, a refId and the space to read from — never a row — and handing them one built on the spot is
 * cheaper than teaching eight pages a second way to be mounted.
 *
 * Lives in `state/` rather than beside the overlay component because the store needs the id too: a
 * notification landing on the feed selects a row keyed by the page's item id, and both sides have to
 * mean the same string.
 */
export type PageTarget = { kind: Item["kind"]; refId: string; spaceId: string };

/** Stable across renders, and deliberately: the pages key radio groups off it
 *  (`name={`library-tab-${item.id}`}`), and an id that changed every frame would reset the checked
 *  tab on each one. */
export const pageItemId = (kind: Item["kind"], refId: string): string => `page:${kind}:${refId}`;

export function pageItemOf(page: PageTarget): Item {
  return {
    id: pageItemId(page.kind, page.refId),
    spaceId: page.spaceId,
    kind: page.kind,
    title: PAGE_LABEL[page.kind] ?? "Page",
    refId: page.refId,
    sortOrder: 0, pinned: false, archived: false,
    createdAt: 0, updatedAt: 0,
  };
}

/** What a destination page's overlay is, from its kind alone. */
export const destinationTarget = (kind: DestinationPageKind, spaceId: string): PageTarget =>
  ({ kind, refId: PAGE_REF_IDS[kind], spaceId });

/** The overlay bar's own title. The pages render their own `h1` too, and that is not a duplication
 *  worth removing: the bar names what the overlay IS while the page's heading names what it is
 *  SHOWING — "Settings" over a page whose heading is the space you are configuring. */
export const PAGE_LABEL: Partial<Record<Item["kind"], string>> = {
  "agents-page": "Agents",
  "library-page": "Library",
  "connections-page": "Connections",
  "notifications-page": "Notifications",
  "schedules-page": "Scheduled tasks",
  "settings-page": "Settings",
  "space-page": "Overview",
  "profile-page": "Profile",
};
