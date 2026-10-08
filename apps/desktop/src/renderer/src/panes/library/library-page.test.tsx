import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS } from "@realm/contracts";
import { LibraryPage } from "./LibraryPage";
import { StoreContext, createAppStore } from "../../state/store";
import { space, fakeApi, fakeMemoryRepo, item, skillRow, type FakeData } from "../../state/store.test-fakes";

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

  /* ── Memory: every space of the profile, not just the one the page was opened from ── */
  const memoryTab = async (overrides: FakeData = {}) => {
    const r = await mount({ memoryDocs: { s1: "# Versed rules\n\nUse pnpm.", s2: "" }, ...overrides });
    fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
    await screen.findByRole("textbox", { name: "Versed memory document" });
    return r;
  };

  it("Memory lists every space of the profile, the page's own space open with its editor", async () => {
    /* THE mutant: the old page — one space's document, named as if it were the Library's. */
    const { api } = await memoryTab({
      spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework"), space("s9", "p2", "Elsewhere")],
    });
    const list = document.querySelector(".memory-spaces")!;
    const names = [...list.querySelectorAll(".memory-space-name")].map((n) => n.textContent);
    expect(names).toEqual(["Versed", "Homework"]);
    // Another profile's space is not this window's to show.
    expect(names).not.toContain("Elsewhere");
    await waitFor(() => expect(api.calls).toContain("getMemory:s2"));
    // The shut space is one line: its name and what its document says — here, that nothing is written.
    const homework = within(list as HTMLElement).getByRole("button", { name: /Homework/ });
    expect(homework).toHaveAttribute("aria-expanded", "false");
    expect(homework).toHaveTextContent("Nothing written yet");
    // The page's own space is marked as such, and its line names what its document is about.
    expect(within(list as HTMLElement).getByRole("button", { name: /Versed/ })).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector(".page-vantage")?.textContent).toBe("Work");
  });

  it("a space opened from the list edits THAT space's document, and no other", async () => {
    const { api } = await memoryTab();
    fireEvent.click(screen.getByRole("button", { name: /Homework/ }));
    const doc = await screen.findByRole("textbox", { name: "Homework memory document" });
    // One open at a time: opening Homework folds Versed.
    expect(screen.queryByRole("textbox", { name: "Versed memory document" })).toBeNull();
    fireEvent.change(doc, { target: { value: "Cite every source." } });
    fireEvent.blur(doc);
    await waitFor(() => expect(api.data.memoryDocs.s2).toBe("Cite every source."));
    expect(api.data.memoryDocs.s1).toBe("# Versed rules\n\nUse pnpm.");
  });

  it("the profile's document leads, edited here, and lands on the PROFILE — never a space's", async () => {
    const { api } = await memoryTab();
    const doc = await screen.findByRole("textbox", { name: "Work memory document" });
    expect(doc).toHaveValue("Work-wide standing instruction.");
    fireEvent.change(doc, { target: { value: "New profile-wide rule." } });
    fireEvent.blur(doc);
    await waitFor(() => expect(api.data.profileMemoryDocs.p1).toBe("New profile-wide rule."));
    expect(api.calls.some((c) => c.startsWith("setMemory:"))).toBe(false);
  });

  it("a space's switch for the profile's memory writes THAT space's override — never the profile doc (named mutant: toggle writing the defining scope)", async () => {
    const { api } = await memoryTab();
    fireEvent.click(await screen.findByRole("switch", { name: "Work memory in Versed" }));
    await waitFor(() => expect(api.calls).toContain("setProfileDocEnabled:s1=false"));
    expect(api.calls.some((c) => c.startsWith("setProfileMemory"))).toBe(false);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Work memory in Versed" })).not.toBeChecked());
    expect(api.data.profileMemoryDocs.p1).toBe("Work-wide standing instruction.");
  });

  it("leads with who the memory reaches, from the channel table", async () => {
    await memoryTab();
    expect(screen.getByText("Every new Claude and Codex session starts with Work's memory, then its own space's.")).toBeInTheDocument();
  });

  it("shuts a space to a line that says what its document is about", async () => {
    await memoryTab();
    fireEvent.click(screen.getByRole("button", { name: /Versed/ }));
    const line = await screen.findByRole("button", { name: /Versed/ });
    expect(line).toHaveAttribute("aria-expanded", "false");
    // The heading's marks are off: the line says what the document says.
    expect(line.querySelector(".memory-space-gist")!.textContent).toBe("Versed rules");
  });

  it("says so when the page's space is gone, like every page pane", async () => {
    const api = fakeApi();
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><LibraryPage item={item("lib-x", "sGone", { kind: "library-page", refId: PAGE_REF_IDS["library-page"] })} visible /></StoreContext.Provider>);
    expect(screen.getByText("This page's space no longer exists.")).toBeInTheDocument();
  });
});

describe("LibraryPage · memory repo", () => {
  it("lists the profile's memory repo under Every space", async () => {
    await mount({ memoryRepos: { p1: fakeMemoryRepo() } });
    fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
    expect(await screen.findByRole("heading", { name: "Memory repo" })).toBeInTheDocument();
    expect(await screen.findByText("/realm-home/memory/repos/profile-p1")).toBeInTheDocument();
  });
});
