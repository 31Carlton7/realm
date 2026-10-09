import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS } from "@realm/contracts";
import { SettingsPage } from "./SettingsPage";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session, type FakeData } from "../../state/store.test-fakes";

const pageItem = item("set-s1", "s1", { kind: "settings-page", title: "Settings", refId: PAGE_REF_IDS["settings-page"] });

/** Two spaces, an archived session in each and a live one beside them, and an archived row that is
 *  not a session. Only the two archived sessions belong on the page. */
const ITEMS = {
  s1: [
    item("a1", "s1", { kind: "session", title: "Port the importer", archived: true, refId: "se-a1", updatedAt: 1_000 }),
    item("l1", "s1", { kind: "session", title: "Still working", archived: false, refId: "se-l1", updatedAt: 9_000 }),
    item("t1", "s1", { kind: "terminal", title: "old shell", archived: true, refId: "t1", updatedAt: 5_000 }),
  ],
  s2: [item("a2", "s2", { kind: "session", title: "Trim the transcript", archived: true, refId: "se-a2", updatedAt: 3_000 })],
};
/** The sessions behind them, dated by when each conversation last moved — the order the page reads.
 *  The importer's row was written to last (its item was archived later), and still sorts below. */
const SESSIONS = [session("se-a1", "s1", { activityAt: 1_000, updatedAt: 8_000 }), session("se-l1", "s1", { activityAt: 9_000 }),
  session("se-a2", "s2", { activityAt: 3_000 })];

async function archived(overrides: FakeData = {}) {
  const api = fakeApi({ items: structuredClone(ITEMS), sessions: structuredClone(SESSIONS), ...overrides });
  const store = createAppStore(api);
  await store.getState().boot();
  render(<StoreContext.Provider value={store}><SettingsPage item={pageItem} visible /></StoreContext.Provider>);
  fireEvent.click(screen.getByRole("radio", { name: "Archived" }));
  return { api, store };
}

/** The page once its read has landed — each space's list is fetched on open. */
async function archivedList(overrides: FakeData = {}) {
  const mounted = await archived(overrides);
  await screen.findByRole("list", { name: "Archived sessions" });
  return mounted;
}

const list = () => within(screen.getByRole("list", { name: "Archived sessions" }));
const titles = () => list().getAllByRole("listitem").map((li) => li.querySelector(".settings-row-name")!.textContent);

describe("Settings ▸ Archived", () => {
  it("lists every space's archived sessions, newest first, each naming its space", async () => {
    // THE active-space mutant: read only the space that is open, and a session shelved in another
    // space last week is exactly the one this page cannot find.
    await archived();
    await waitFor(() => expect(titles()).toEqual(["Trim the transcript", "Port the importer"]));
    expect(list().getAllByRole("listitem")[0]!.textContent).toContain("Homework");
    expect(list().getAllByRole("listitem")[1]!.textContent).toContain("Versed");
  });

  it("Restore puts the session back in its space's list, and takes it off the page", async () => {
    const { api } = await archivedList();
    fireEvent.click(await list().findByRole("button", { name: "Restore Trim the transcript" }));
    await waitFor(() => expect(api.data.items.s2!.find((i) => i.id === "a2")?.archived).toBe(false));
    await waitFor(() => expect(titles()).toEqual(["Port the importer"]));
  });

  it("Delete asks a second time while the confirm preference is on, and only then deletes", async () => {
    const { api } = await archivedList();
    fireEvent.click(await list().findByRole("button", { name: "Delete Port the importer" }));
    // THE one-click mutant: delete on the first press with the preference on.
    expect(api.calls.filter((c) => c.startsWith("deleteItem:"))).toEqual([]);
    // Armed on this row only.
    expect(list().getByRole("button", { name: "Delete Trim the transcript" })).toBeInTheDocument();
    fireEvent.click(list().getByRole("button", { name: "Really delete Port the importer" }));
    await waitFor(() => expect(api.calls).toContain("deleteItem:a1"));
    await waitFor(() => expect(titles()).toEqual(["Trim the transcript"]));
  });

  it("deletes on the first press once the confirm preference is off", async () => {
    const { api } = await archivedList({ settings: { "ui.confirmDelete": false } });
    fireEvent.click(await list().findByRole("button", { name: "Delete Port the importer" }));
    await waitFor(() => expect(api.calls).toContain("deleteItem:a1"));
  });

  it("says what archiving is for when nothing is archived", async () => {
    await archived({ items: { s1: [item("l1", "s1", { kind: "session", title: "Still working", refId: "se-l1" })] } });
    expect(await screen.findByText(/No archived sessions/)).toBeInTheDocument();
  });
});
