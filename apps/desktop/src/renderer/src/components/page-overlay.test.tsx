import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { allItems, PAGE_REF_IDS } from "@realm/contracts";
/* The pane components register themselves by side effect (`panes/index.ts`); the overlay renders
   through the same registry, so a test that never imports them gets the placeholder. */
import "../panes";
import { PageOverlay } from "./PageOverlay";
import { Destinations } from "./sidebar/Destinations";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item, type FakeData } from "../state/store.test-fakes";

async function mount(overrides: FakeData = {}) {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(
    <StoreContext.Provider value={store}>
      <Destinations />
      <PageOverlay />
    </StoreContext.Provider>,
  );
  return { api, store, ...r };
}

const overlay = () => screen.queryByRole("dialog", { name: /Library|Settings|Notifications|Connections|Agents|Scheduled tasks/ });

afterEach(() => cleanup());

describe("app-level pages over the workspace", () => {
  it("draws nothing until a destination is opened", async () => {
    await mount();
    expect(overlay()).toBeNull();
  });

  it("opens from the sidebar row and takes no item, no leaf, no sidebar entry", async () => {
    /* The complaint this answers: "I don't like that it even adds to the sidebar at all." These were
       layout items — each open split a pane, zoomed it, and left a row in the Open list. */
    const { store, api } = await mount();
    const layout = allItems(store.getState().layout!);
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(await screen.findByRole("dialog", { name: "Library" })).toBeInTheDocument();
    expect(store.getState().items.some((i) => i.kind === "library-page")).toBe(false);
    expect(allItems(store.getState().layout!)).toEqual(layout);
    expect(api.calls.some((c) => c.startsWith("createItem:"))).toBe(false);
  });

  it("closes on the TRASH, because a page has nothing under it to keep", async () => {
    const { store } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close Settings" }));
    await waitFor(() => expect(overlay()).toBeNull());
    expect(store.getState().pageOverlay).toBeNull();
  });

  it("closes on Escape", async () => {
    const { store } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    await screen.findByRole("dialog", { name: "Library" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(store.getState().pageOverlay).toBeNull());
  });

  it("the row that opened it lights, and closes it when pressed again", async () => {
    // design.md: a lit control says the state and undoes it in the same click.
    const { store } = await mount();
    const row = () => screen.getByRole("button", { name: "Library" });
    fireEvent.click(row());
    await waitFor(() => expect(row()).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(row());
    await waitFor(() => expect(store.getState().pageOverlay).toBeNull());
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
      item("keep", "s1", { kind: "session", title: "A session", refId: "se1" }),
    ];
    const { api, store } = await mount({ items: { s1: stale } });
    await waitFor(() => expect(store.getState().items.map((i) => i.id)).toEqual(["keep"]));
    for (const id of ["p1", "p2", "p3"]) expect(api.calls).toContain(`deleteItem:${id}`);
    // …and only those: a session is an object with a transcript under it.
    expect(api.calls).not.toContain("deleteItem:keep");
  });
});
