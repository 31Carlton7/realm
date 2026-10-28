import { describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PAGE_REF_IDS, memoryLearningKey } from "@realm/contracts";
import { ProfilePage } from "./ProfilePage";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, space, type FakeData } from "../../state/store.test-fakes";

const pageItem = (spaceId: string) =>
  item(`pg-profile-${spaceId}`, spaceId, { kind: "profile-page", title: "Profile", refId: PAGE_REF_IDS["profile-page"] });

/** Whose switch each stored row is: only the learning keys, out of everything else the page stores. */
const learningRows = (settings: Record<string, unknown>) => Object.fromEntries(Object.entries(settings).filter(([k]) => k.startsWith("memory.learning:")));

async function openMemory(overrides: FakeData = {}, spaceId = "s1") {
  const api = fakeApi(overrides); const store = createAppStore(api); await store.getState().boot();
  render(<StoreContext.Provider value={store}><ProfilePage item={pageItem(spaceId)} visible /></StoreContext.Provider>);
  fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
  return { api, store, toggle: await screen.findByRole("switch", { name: "Learn from sessions" }) };
}

describe("ProfilePage · Memory · Learn from sessions", () => {
  it("is on for a profile nobody has switched, and says what it spends", async () => {
    const { toggle } = await openMemory();
    expect(toggle).toBeChecked();
    const row = toggle.closest(".settings-row")!;
    expect(row).toHaveTextContent("the same frontier model as your sessions, on your account");
    // The model is no longer a small one, and the page must not say it is.
    expect(row).not.toHaveTextContent(/small model/i);
  });

  it("switches off for THIS profile, and stays off when the page comes back", async () => {
    const { api, toggle } = await openMemory();
    fireEvent.click(toggle);
    await waitFor(() => expect(api.calls).toContain(`setSetting:${memoryLearningKey("p1")}=false`));
    expect(toggle).not.toBeChecked();
    // THE MUTANT: writing the vantage space's id, or another profile's key — the server reads per profile.
    expect(learningRows(api.data.settings)).toEqual({ [memoryLearningKey("p1")]: false });

    cleanup();
    const again = await openMemory({ settings: api.data.settings });
    expect(again.toggle).not.toBeChecked();
  });

  it("switches the profile the page is about, not the one the window has open", async () => {
    const spaces = [space("s1", "p1", "Versed"), space("s2", "p2", "Homework")];
    const { api, store, toggle } = await openMemory({ spaces }, "s2");
    expect(store.getState().activeProfileId).toBe("p1");
    fireEvent.click(toggle);
    await waitFor(() => expect(learningRows(api.data.settings)).toEqual({ [memoryLearningKey("p2")]: false }));
  });

  it("reads each profile's own switch", async () => {
    const spaces = [space("s1", "p1", "Versed"), space("s2", "p2", "Homework")];
    const { toggle } = await openMemory({ spaces, settings: { [memoryLearningKey("p1")]: false } }, "s2");
    // s2 belongs to p2, whose switch nobody turned off.
    expect(toggle).toBeChecked();
    cleanup();
    expect((await openMemory({ spaces, settings: { [memoryLearningKey("p1")]: false } }, "s1")).toggle).not.toBeChecked();
  });
});
