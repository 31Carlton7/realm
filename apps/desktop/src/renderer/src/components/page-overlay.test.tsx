import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS, type DestinationPageKind, type Item } from "@realm/contracts";
/* The pane components register themselves by side effect (`panes/index.ts`); the overlay renders
   through the same registry, so a test that never imports them gets the placeholder. */
import "../panes";
import { PageOverlay } from "./PageOverlay";
import { Rail } from "./sidebar/Rail";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item, type FakeData } from "../state/store.test-fakes";

async function mount(overrides: FakeData = {}) {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(
    <StoreContext.Provider value={store}>
      <Rail />
      <PageOverlay />
    </StoreContext.Provider>,
  );
  return { api, store, ...r };
}

const overlay = () => screen.queryByRole("dialog", { name: /Library|Settings|Code review|Connections|Agents|Scheduled tasks/ });

afterEach(() => cleanup());

describe("app-level pages over the workspace", () => {

  it("draws no close in any page's bar — the page is left the way it was reached", async () => {
    /* The owner, 10-05: "Remove the close button in library, connections, sched tasks, and
       notification and profile and settings. (Can nav this with the sidebar)." Every destination page
       wears the one bar, so every one of them is asked. THE mutant: the × put back, on any of them. */
    const { store } = await mount();
    // Every destination there is, read off the contract: a page added or retired later is still asked.
    for (const kind of Object.keys(PAGE_REF_IDS) as DestinationPageKind[]) {
      act(() => store.getState().openDestinationPage(kind));
      const bar = document.querySelector(".page-overlay-bar")!;
      expect(bar, kind).not.toBeNull();
      expect(within(bar as HTMLElement).queryAllByRole("button"), kind).toEqual([]);
      expect(bar.querySelector("[title*='Close']"), kind).toBeNull();
    }
    act(() => store.getState().openProfilePage());
    expect(within(document.querySelector(".page-overlay-bar") as HTMLElement).queryAllByRole("button")).toEqual([]);
    act(() => store.getState().openSpacePage("s1"));
    expect(within(document.querySelector(".page-overlay-bar") as HTMLElement).queryAllByRole("button")).toEqual([]);
  });

  it("goes back from the rail's lit button, pressed again", async () => {
    // Connections takes the sidebar away, so the rail is the way back from it — a lit control says
    // the state and undoes it.
    const { store } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Connections" }));
    await screen.findByRole("dialog", { name: "Connections" });
    expect(screen.getByRole("button", { name: "Connections" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Connections" }));
    await waitFor(() => expect(overlay()).toBeNull());
    expect(store.getState().pageOverlay).toBeNull();
  });

  it("goes back to where you were on Escape, leaving the workspace under it as it was", async () => {
    const { store } = await mount();
    const before = { layout: store.getState().layout, focused: store.getState().focusedLeafId };
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    await screen.findByRole("dialog", { name: "Library" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(store.getState().pageOverlay).toBeNull());
    expect(store.getState().layout).toEqual(before.layout);
    expect(store.getState().focusedLeafId).toBe(before.focused);
  });

  it("shows ONE page at a time — a second destination replaces the first", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    await screen.findByRole("dialog", { name: "Library" });
    fireEvent.click(screen.getByRole("button", { name: "Connections" }));
    await screen.findByRole("dialog", { name: "Connections" });
    expect(screen.queryByRole("dialog", { name: "Library" })).toBeNull();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("hands the page a stable item id, so its tabs do not reset on every render", async () => {
    /* The pages key radio groups off `item.id` (`name={`library-tab-${item.id}`}`). An id minted per
       render would uncheck the selected tab on each one. */
    const { store } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    const dialog = await screen.findByRole("dialog", { name: "Library" });
    const radio = within(dialog).getByRole("radio", { name: "Skills" });
    fireEvent.click(radio);
    await waitFor(() => expect(within(dialog).getByRole("radio", { name: "Skills" })).toBeChecked());
    // A re-render from unrelated state must not disturb it.
    store.setState({ notificationsUnread: 3 });
    await waitFor(() => expect(within(dialog).getByRole("radio", { name: "Skills" })).toBeChecked());
  });
});

describe("the pages a previous version left in the layout", () => {
  it("are pruned at boot, so an upgraded home stops carrying them", async () => {
    /* THE MUTANT: ship the overlay and leave the old items alone. A home upgraded from the version
       where these were panes holds one per page it ever opened — in the layout, in the sidebar, and
       now never rendered. Their refIds are sentinels with nothing behind them, so pruning costs
       nothing (design.md: "there is nothing behind the item to lose"). */
    const stale = [
      item("p1", "s1", { kind: "library-page", title: "Library", refId: PAGE_REF_IDS["library-page"] }),
      item("p2", "s1", { kind: "settings-page", title: "Settings", refId: PAGE_REF_IDS["settings-page"] }),
      item("p3", "s1", { kind: "space-page", title: "Overview", refId: "s1" }),
      // A page retired since (v2): no longer a kind at all, and still a row an older home holds.
      item("p4", "s1", { kind: "notifications-page" as unknown as Item["kind"], title: "Notifications", refId: "00000000000000000000000003" }),
      item("keep", "s1", { kind: "session", title: "A session", refId: "se1" }),
    ];
    const { api, store } = await mount({ items: { s1: stale } });
    await waitFor(() => expect(store.getState().items.map((i) => i.id)).toEqual(["keep"]));
    for (const id of ["p1", "p2", "p3", "p4"]) expect(api.calls).toContain(`deleteItem:${id}`);
    // …and only those: a session is an object with a transcript under it.
    expect(api.calls).not.toContain("deleteItem:keep");
  });
});

describe("the page about you", () => {
  it("opens as an overlay like every other destination, its bar saying what it is", async () => {
    // The mutant this kills is a page kind with no registered component: the overlay would open
    // over the workspace and draw the placeholder under its bar.
    const { store } = await mount();
    act(() => store.getState().openDestinationPage("you-page"));
    const dialog = await screen.findByRole("dialog", { name: "You" });
    expect(within(dialog).getByRole("heading", { level: 1, name: "Carlton" })).toBeInTheDocument();
    expect(within(dialog.querySelector(".page-overlay-bar") as HTMLElement).getByText("You")).toBeInTheDocument();
  });
});

describe("how a page arrives", () => {
  it("at once when it takes or gives back the sidebar as it opens, rising in when it does not — decided as it opens", async () => {
    /* Connections from a session takes the spaces away in the frame it arrives (App.tsx,
       `useSidebarCut`), and the panes under the page take their width: through a page still fading in,
       they were seen doing it. So that page is drawn at once (`data-cut`, no entrance). The Library from
       a session leaves the sidebar where it is, and rises in as every page does. Held while the page is
       up, because an entrance plays once: re-deciding it later would take `animation: none` away and
       replay the rise over a page already there. THE MUTANTS: every page cut, none cut, or the cut
       re-decided at the next page. */
    const { store } = await mount();
    const page = () => document.querySelector(".page-overlay")!;
    act(() => store.getState().openDestinationPage("connections-page"));
    expect(page()).toHaveAttribute("data-cut");
    act(() => store.getState().openDestinationPage("library-page"));
    expect(page(), "the Library after Connections: up already, and still as it arrived").toHaveAttribute("data-cut");
    act(() => store.getState().closePageOverlay());
    act(() => store.getState().openDestinationPage("library-page"));
    expect(page()).not.toHaveAttribute("data-cut");
    act(() => store.getState().openDestinationPage("schedules-page"));
    expect(page(), "Scheduled after the Library: the page was already up").not.toHaveAttribute("data-cut");
  });
});
