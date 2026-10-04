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
    await waitFor(() => expect((store.getState().pageOverlay?.kind === "profile-page")).toBe(true));
    expect(store.getState().profilePageTab.p1).toBe("memory");
    // A jump, not the inline editor.
    expect(screen.queryByRole("textbox", { name: "Work memory document" })).toBeNull();
  });

  it("shows what the inherited doc SAYS, and offers no second editor for it", async () => {
    /* The row answers "what am I inheriting" without a trip, and the document is edited in one place:
       its own profile's page. THE mutants: the row with nothing but a character count (the reader has
       to leave to learn what travels), or a second, inline editor for the same document. */
    const { api } = await mount();
    fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
    const fromWork = await screen.findByRole("region", { name: "From Work" });
    expect(within(fromWork).getByText("Work-wide standing instruction.")).toBeInTheDocument();
    expect(within(fromWork).queryByRole("textbox")).toBeNull();
    expect(within(fromWork).queryByRole("button", { name: /Edit here/ })).toBeNull();
    expect(api.calls.some((c) => c.startsWith("setProfileMemory"))).toBe(false);
  });

  it("leads with who the memory reaches, from the channel table, and the space it is about", async () => {
    await mount();
    fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
    expect(await screen.findByText("Every new Claude and Codex session in Versed starts with what is written here.")).toBeInTheDocument();
  });

  it("says so when the page's space is gone, like every page pane", async () => {
    const api = fakeApi();
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><LibraryPage item={item("lib-x", "sGone", { kind: "library-page", refId: PAGE_REF_IDS["library-page"] })} visible /></StoreContext.Provider>);
    expect(screen.getByText("This page's space no longer exists.")).toBeInTheDocument();
  });
});
