import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PAGE_REF_IDS, type ItemKind } from "@realm/contracts";
import type { ComponentType } from "react";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item, skillRow } from "../state/store.test-fakes";
import type { PaneProps } from "../panes/registry";
import { ConnectionsPage } from "../panes/connections/ConnectionsPage";
import { LibraryPage } from "../panes/library/LibraryPage";
import { NotificationsPage } from "../panes/notifications/NotificationsPage";
import { ProfilePage } from "../panes/profile/ProfilePage";
import { SettingsPage } from "../panes/settings/SettingsPage";
import { SpacePage } from "../panes/space/SpacePage";
import { YouPage } from "../panes/you/YouPage";

/**
 * No page pins its head (the owner, 10-05: "the header shouldn't be sticky at all").
 *
 * A head is pinned by structure as surely as by `position: sticky`: drawn above the column that
 * scrolls, it stays put while everything under it moves, which is what every page here did. So the
 * claim is about where the head IS — the first thing inside its page's scroller, which dissolves at
 * an end once there is something past it. jsdom scrolls nothing and measures nothing, so this holds
 * the structure; `audits-live.mjs` scrolls each page in the real window and watches its title go.
 */

afterEach(() => cleanup());

const PAGES: { name: string; kind: ItemKind; Page: ComponentType<PaneProps>; refId?: string; tab?: string }[] = [
  { name: "Settings", kind: "settings-page", Page: SettingsPage },
  { name: "Connections", kind: "connections-page", Page: ConnectionsPage },
  { name: "Library ▸ Files", kind: "library-page", Page: LibraryPage },
  { name: "Library ▸ Skills", kind: "library-page", Page: LibraryPage, tab: "Skills" },
  { name: "Library ▸ Memory", kind: "library-page", Page: LibraryPage, tab: "Memory" },
  { name: "You", kind: "you-page", Page: YouPage },
  { name: "Notifications", kind: "notifications-page", Page: NotificationsPage },
  { name: "a profile", kind: "profile-page", Page: ProfilePage },
  { name: "a space", kind: "space-page", Page: SpacePage, refId: "s1" },
];

async function mount(p: (typeof PAGES)[number]) {
  const store = createAppStore(fakeApi({ skills: { s1: [skillRow("mac")] } }));
  await store.getState().boot();
  const refId = p.refId ?? PAGE_REF_IDS[p.kind as keyof typeof PAGE_REF_IDS];
  render(<StoreContext.Provider value={store}><p.Page item={item("pg", "s1", { kind: p.kind, title: p.name, refId })} visible focused /></StoreContext.Provider>);
  if (p.tab) fireEvent.click(screen.getByRole("radio", { name: p.tab }));
  return screen.findByRole("heading", { level: 1 });
}

describe("a page's head scrolls with its page", () => {
  it.each(PAGES)("$name: the head is the first thing in the column, and the column dissolves", async (p) => {
    const title = await mount(p);
    const head = title.closest(".page-head")!;
    expect(head).not.toBeNull();
    // THE mutant: the head back above the column — a sibling of the body, or of the scroller.
    const column = head.closest(".page-content") as HTMLElement | null;
    expect(column, "the head stands outside the scroller, so it stays put while the page moves").not.toBeNull();
    expect(column!.firstElementChild).toBe(head);
    // The scroller it is in is the page's own, wearing the shared dissolve.
    expect(column!.hasAttribute("data-dissolve")).toBe(true);
  });
});
