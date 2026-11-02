import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS } from "@realm/contracts";
import { LibraryPage } from "./LibraryPage";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, skillRow, type FakeData } from "../../state/store.test-fakes";

/** The pane as PaneHost mounts it: kind is the identity, refId the sentinel, spaceId the vantage. */
const pageItem = (spaceId: string) =>
  item(`lib-${spaceId}`, spaceId, { kind: "library-page", title: "Library", refId: PAGE_REF_IDS["library-page"] });

async function mount(overrides: FakeData = {}, spaceId = "s1") {
  const api = fakeApi({
    skills: { s1: [skillRow("mac"), skillRow("mine", { scope: { kind: "space", spaceId: "s1" } })], s2: [skillRow("mac")] },
    ...overrides,
  });
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><LibraryPage item={pageItem(spaceId)} visible /></StoreContext.Provider>);
  return { store, api, ...r };
}

describe("the Library page (Plan 12 W4)", () => {
  it("wears the page pattern: head, a Files · Skills · Memory rail, Files first", async () => {
    /* Files leads. Skills and memory are what you INSTALL into a space and change rarely; files are
       what the work produced, and they are the reason someone opens a Library at all. */
    await mount();
    // The head names the SECTION, as Settings' does — "Library" is the pane bar's word.
    expect(screen.getByRole("heading", { name: "Files", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Files" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Skills" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Memory" })).not.toBeChecked();
    // THE mutant: a title fixed at the first section's name.
    fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
    expect(await screen.findByRole("heading", { name: "Memory", level: 1 })).toBeInTheDocument();
  });

  it("the Skills tab IS the shared grouped panel — same groups, same disclosures, no fork", async () => {
    await mount();
    fireEvent.click(screen.getByRole("radio", { name: "Skills" }));
    // The shared panel's mandatory disclosure and the scope groups, exactly as the space page shows them.
    expect(await screen.findByText(/isolates this space's Claude sessions/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Everywhere" })).getByText("mac")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "This space" })).getByText("mine")).toBeInTheDocument();
  });

  it("reads from the ITEM's space, never the active one — a page opened from another space keeps its vantage", async () => {
    const { api } = await mount({}, "s2"); // active space stays s1 (boot default)
    fireEvent.click(screen.getByRole("radio", { name: "Skills" }));
    await waitFor(() => expect(api.calls).toContain("listSkills:s2"));
    expect(api.calls).not.toContain("listSkills:s1");
    // The vantage moved out of a sub-title paragraph and into the header beside the title, but it
    // is still the only place the page says WHICH space it is showing — so it is still asserted.
    expect(document.querySelector(".page-vantage")?.textContent).toBe("Homework");
  });

  it("says so when the page's space is gone, like every page pane", async () => {
    const api = fakeApi();
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><LibraryPage item={item("lib-x", "sGone", { kind: "library-page", refId: PAGE_REF_IDS["library-page"] })} visible /></StoreContext.Provider>);
    expect(screen.getByText("This page's space no longer exists.")).toBeInTheDocument();
  });
});
