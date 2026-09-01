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
    profileMemoryDocs: { p1: "Work-wide standing instruction." },
    ...overrides,
  });
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><LibraryPage item={pageItem(spaceId)} visible /></StoreContext.Provider>);
  return { store, api, ...r };
}

describe("the Library page (Plan 12 W4)", () => {
  it("wears the page pattern: head, a Skills · Memory rail, Skills first", async () => {
    await mount();
    expect(screen.getByRole("heading", { name: "Library" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Skills" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Memory" })).not.toBeChecked();
  });

  it("the Skills tab IS the shared grouped panel — same groups, same disclosures, no fork", async () => {
    await mount();
    // The shared panel's mandatory disclosure and the scope groups, exactly as the space page shows them.
    expect(await screen.findByText(/isolates this space's Claude sessions/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Everywhere" })).getByText("mac")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "This space" })).getByText("mine")).toBeInTheDocument();
  });

  it("reads from the ITEM's space, never the active one — a page opened from another space keeps its vantage", async () => {
    const { api } = await mount({}, "s2"); // active space stays s1 (boot default)
    await waitFor(() => expect(api.calls).toContain("listSkills:s2"));
    expect(api.calls).not.toContain("listSkills:s1");
    expect(screen.getByText(/seen from Homework/)).toBeInTheDocument();
  });

  it("Memory: the space doc sits under This space with its editor; the profile doc under From Work with the override toggle", async () => {
    await mount();
    fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
    const thisSpace = await screen.findByRole("region", { name: "This space" });
    expect(within(thisSpace).getByRole("textbox", { name: "Space memory document" })).toBeInTheDocument();
    const fromWork = await screen.findByRole("region", { name: "From Work" });
    expect(within(fromWork).getByRole("switch", { name: "Work memory in this space" })).toBeChecked();
    expect(within(fromWork).getByText(/injected before this space's own memory/)).toBeInTheDocument();
  });

  it("the inherited doc's toggle writes THIS space's override — never the profile doc (named mutant: toggle writing the defining scope)", async () => {
    const { api } = await mount();
    fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
    fireEvent.click(await screen.findByRole("switch", { name: "Work memory in this space" }));
    await waitFor(() => expect(api.calls).toContain("setProfileDocEnabled:s1=false"));
    expect(api.calls.some((c) => c.startsWith("setProfileMemory"))).toBe(false);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Work memory in this space" })).not.toBeChecked());
    // The doc itself did not move.
    expect(api.data.profileMemoryDocs.p1).toBe("Work-wide standing instruction.");
  });

  it("'Edit in profile…' is the PRIMARY affordance and jumps to the profile page's Memory tab (Plan 14 W2)", async () => {
    const { store } = await mount();
    fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit in profile…" }));
    await waitFor(() => expect(store.getState().items.some((i) => i.kind === "profile-page")).toBe(true));
    expect(store.getState().profilePageTab.p1).toBe("memory");
    // A jump, not the inline editor.
    expect(screen.queryByRole("textbox", { name: "Work memory document" })).toBeNull();
  });

  it("Edit here: the inline fallback editor names its reach, and saving writes the PROFILE doc via memory.setProfile — the space doc untouched", async () => {
    const { api } = await mount();
    fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit here…" }));
    expect(screen.getByText("Defined in Work. Changes here apply to every space of Work.")).toBeInTheDocument();
    const editor = await screen.findByRole("textbox", { name: "Work memory document" });
    await waitFor(() => expect(api.calls).toContain("getProfileMemory:p1"));
    fireEvent.change(editor, { target: { value: "New profile-wide rule." } });
    // Scoped to the inherited group: the space doc's own editor (MemoryPanel) has a Save memory too.
    fireEvent.click(within(screen.getByRole("region", { name: "From Work" })).getByRole("button", { name: "Save memory" }));
    await waitFor(() => expect(api.data.profileMemoryDocs.p1).toBe("New profile-wide rule."));
    expect(api.calls).toContain(`setProfileMemory:p1:${"New profile-wide rule.".length}`);
    // Never the space doc's wire.
    expect(api.calls.some((c) => c.startsWith("setMemory:"))).toBe(false);
    expect(api.data.memoryDocs.s1 ?? "").toBe("");
  });

  it("says so when the page's space is gone, like every page pane", async () => {
    const api = fakeApi();
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><LibraryPage item={item("lib-x", "sGone", { kind: "library-page", refId: PAGE_REF_IDS["library-page"] })} visible /></StoreContext.Provider>);
    expect(screen.getByText("This page's space no longer exists.")).toBeInTheDocument();
  });
});
