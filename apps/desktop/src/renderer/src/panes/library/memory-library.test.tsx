import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { PAGE_REF_IDS, type MemoryLibraryFile, type MemoryLibrarySource } from "@realm/contracts";
import { LibraryPage } from "./LibraryPage";
import { linkWikiLinks, withoutTitle } from "./MemoryLibrary";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, type FakeData } from "../../state/store.test-fakes";

/* The reader and the editor are the documents pane's, split out of the page's chunk; their first
   import is a transform of ProseMirror and CodeMirror. Taken once, so each test times the page. */
beforeAll(async () => {
  await Promise.all([import("../documents/CodeEditor"), import("../documents/RichTextEditor")]);
}, 60_000);
afterEach(() => { vi.unstubAllGlobals(); });

const REPO = "realm-repo-profile-p1";
const source = (o: Partial<MemoryLibrarySource> & Pick<MemoryLibrarySource, "id" | "group" | "label">): MemoryLibrarySource => ({
  path: `/x/${o.id}`, spaceId: null, external: o.group !== "realm", creatable: o.group === "realm", count: 0, pointed: true, by: `${o.label} is read.`, ...o,
});
const SOURCES = [
  source({ id: REPO, group: "realm", label: "Memory repo", path: "/realm-home/memory/repos/profile-p1", by: "Sessions in every space start with its MEMORY.md." }),
  source({ id: "claude-user", group: "claude", label: "User memory", path: "/home/.claude/CLAUDE.md", by: "Claude Code loads it in every session." }),
];
const memory = (o: Partial<MemoryLibraryFile> & Pick<MemoryLibraryFile, "sourceId" | "rel" | "title">): MemoryLibraryFile => ({
  id: `${o.sourceId}:${o.rel}`, path: `/x/${o.rel}`, displayPath: `/x/${o.rel}`, description: null, type: null, folder: null, index: false, updatedAt: Date.now() - 3_600_000, size: 10, match: null,
  text: o.body ?? "", body: "", frontmatter: [], links: [], readBy: [], external: false, writable: true, deletable: true, note: null, ...o,
});
const files = (): MemoryLibraryFile[] => [
  memory({
    sourceId: REPO, rel: "creators.md", title: "Creator campaign", description: "Who runs the spring creator campaign", type: "project",
    body: "The briefs live in the shared Drive; see [[contacts]].\n", text: "---\nname: Creator campaign\n---\n\nThe briefs live in the shared Drive; see [[contacts]].\n",
    frontmatter: [{ key: "name", value: "Creator campaign" }, { key: "description", value: "Who runs the spring creator campaign" },
      { key: "metadata.type", value: "project" }, { key: "metadata.source", value: "realm:session/abc" }],
    links: [{ target: "contacts", id: `${REPO}:contacts.md` }], updatedAt: Date.now() - 60_000,
    readBy: [{ who: "Claude", where: "in Versed", how: "as its own memory" }, { who: "Other agents", where: "in Versed", how: "through Realm's memory tools" }],
  }),
  memory({ sourceId: REPO, rel: "contacts.md", title: "Contacts", description: "Maya runs partnerships", body: "- Maya runs partnerships\n" }),
  memory({ sourceId: "claude-user", rel: "CLAUDE.md", title: "House rules", description: "Prefer small PRs.", body: "Prefer small PRs.\n", text: "# House rules\n\nPrefer small PRs.\n",
    path: "/Users/me/.claude/CLAUDE.md", displayPath: "~/.claude/CLAUDE.md", external: true, readBy: [{ who: "Claude", where: "in every space", how: null }], updatedAt: Date.now() - 86_400_000 }),
];

async function mount(data: FakeData = {}) {
  const api = fakeApi({ memoryLibrarySources: SOURCES, memoryFiles: files(), ...data });
  const store = createAppStore(api);
  await store.getState().boot();
  store.getState().setLibraryTab("s1", "memory");
  const pageItem = item("lib-s1", "s1", { kind: "library-page", title: "Library", refId: PAGE_REF_IDS["library-page"] });
  render(<StoreContext.Provider value={store}><LibraryPage item={pageItem} visible /></StoreContext.Provider>);
  await screen.findByRole("heading", { name: "Creator campaign", level: 2 });
  return { api, store };
}

const reader = () => screen.getByRole("region", { name: "Memory" });
const list = () => screen.getByRole("region", { name: "Memories" });

describe("the Library's Memory section", () => {
  it("lists every memory under one head, the sources grouped by whose they are, the newest read", async () => {
    await mount();
    expect(screen.getByRole("heading", { name: "Memory", level: 1 })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Where memory is kept" });
    expect(within(within(nav).getByRole("region", { name: "Realm" })).getByRole("button", { name: /Memory repo\s*2/ })).toBeInTheDocument();
    expect(within(within(nav).getByRole("region", { name: "Claude" })).getByRole("button", { name: /User memory\s*1/ })).toBeInTheDocument();
    const rows = within(list()).getAllByRole("button").filter((b) => b.classList.contains("memory-row"));
    expect(rows.map((r) => r.querySelector(".memory-row-title")!.textContent)).toEqual(["Creator campaign", "Contacts", "House rules"]);
    // Where each is kept, in the list's few words — an agent's own file says whose it is.
    expect(rows[2]!.querySelector(".memory-row-place")!.textContent).toBe("Claude · User memory");
    expect(rows[0]).toHaveAttribute("aria-current", "true");
    // The reader: the description, the frontmatter as properties, who reads it, the file.
    expect(within(reader()).getByText("Who runs the spring creator campaign")).toBeInTheDocument();
    const props = reader().querySelector(".memory-props")!;
    expect(props.textContent).toContain("TypeProject");
    expect(props.textContent).toContain("Claude in Versed, as its own memory");
    expect(props.textContent).toContain("Other agents in Versed, through Realm's memory tools");
    expect(props.textContent).toContain("sourcerealm:session/abc");
    // THE MUTANT: the name and type repeated as properties under the title that already says them.
    expect(props.textContent).not.toContain("Creator campaign");
    await waitFor(() => expect(reader().querySelector(".documents-rich-surface")?.textContent).toContain("The briefs live in the shared Drive"));
  });

  it("narrows to a source from the column, says how agents reach it, and the section's row brings every source back", async () => {
    const { api } = await mount();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Where memory is kept" })).getByRole("button", { name: /User memory/ }));
    await waitFor(() => expect(api.calls).toContain("memoryLibraryList:p1:claude-user:"));
    expect(await screen.findByRole("heading", { name: "User memory", level: 1 })).toBeInTheDocument();
    expect(within(list()).getByText("Claude Code loads it in every session.")).toBeInTheDocument();
    await screen.findByRole("heading", { name: "House rules", level: 2 });
    // One lit row in the column: the source, not the section above it.
    expect(screen.getByRole("radio", { name: "Memory" }).closest("label")).not.toHaveAttribute("data-selected");
    fireEvent.click(screen.getByRole("radio", { name: "Memory" }));
    expect(await screen.findByRole("heading", { name: "Memory", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Memory" }).closest("label")).toHaveAttribute("data-selected");
  });

  it("names an index by its folder once, and shows a file's path from the home folder with the whole of it a hover away", async () => {
    await mount({ memoryFiles: [...files(), memory({ sourceId: REPO, rel: "spaces/stora/MEMORY.md", title: "Index · Stora", description: "2 memories", folder: "Stora", index: true, updatedAt: Date.now() - 172_800_000 })] });
    const row = within(list()).getAllByRole("button").find((b) => b.querySelector(".memory-row-title")?.textContent === "Index · Stora")!;
    expect(row.querySelector(".memory-row-line")!.textContent).toBe("2 memories");
    // THE MUTANT: "Memory repo · Stora" under a title that already says Stora.
    expect(row.querySelector(".memory-row-place")!.textContent).toBe("Memory repo");
    fireEvent.click(within(list()).getByText("House rules"));
    await screen.findByRole("heading", { name: "House rules", level: 2 });
    const path = reader().querySelector(".memory-path")!;
    expect(path.textContent).toBe("~/.claude/CLAUDE.md");
    expect(path).toHaveAttribute("title", "/Users/me/.claude/CLAUDE.md");
    expect(path.querySelector(".memory-path-name")!.textContent).toBe("CLAUDE.md");
  });

  it("searches as it is typed, shows the line that matched, and says when nothing does", async () => {
    const { api } = await mount();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search memory" }), { target: { value: "drive" } });
    await waitFor(() => expect(api.calls).toContain("memoryLibraryList:p1::drive"));
    await waitFor(() => expect(within(list()).getAllByRole("button").filter((b) => b.classList.contains("memory-row"))).toHaveLength(1));
    expect(within(list()).getByText(/The briefs live in the shared Drive/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search memory" }), { target: { value: "zzz" } });
    expect(await within(list()).findByText("No memory matches “zzz”.")).toBeInTheDocument();
  });

  it("opens the memory a [[link]] names", async () => {
    await mount();
    const link = await waitFor(() => {
      const a = reader().querySelector<HTMLAnchorElement>(".documents-rich-surface a");
      if (!a) throw new Error("no link drawn yet");
      return a;
    });
    expect(link.textContent).toBe("contacts");
    fireEvent.click(link);
    expect(await screen.findByRole("heading", { name: "Contacts", level: 2 })).toBeInTheDocument();
  });

  it("edits the whole file and writes it as one save", async () => {
    const { api } = await mount();
    fireEvent.click(within(reader()).getByRole("button", { name: "Edit" }));
    const view = await waitFor(() => {
      const el = reader().querySelector<HTMLElement>(".cm-editor");
      const v = el && EditorView.findFromDOM(el);
      if (!v) throw new Error("no editor yet");
      return v;
    });
    expect(view.state.doc.toString()).toBe("---\nname: Creator campaign\n---\n\nThe briefs live in the shared Drive; see [[contacts]].\n");
    act(() => { view.dispatch({ changes: { from: view.state.doc.length, insert: "Logins are in 1Password.\n" } }); });
    fireEvent.click(within(reader()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.calls).toContain(`memoryLibraryWrite:${REPO}:creators.md:false`));
    expect(api.data.memoryFiles.find((f) => f.rel === "creators.md")!.text).toContain("Logins are in 1Password.");
    await waitFor(() => expect(within(reader()).getByRole("button", { name: "Edit" })).toBeInTheDocument());
  });

  it("asks before writing a file outside Realm, once, and names whose it is", async () => {
    const { api } = await mount();
    fireEvent.click(within(list()).getByText("House rules"));
    await screen.findByRole("heading", { name: "House rules", level: 2 });
    fireEvent.click(within(reader()).getByRole("button", { name: "Edit" }));
    const view = await waitFor(() => {
      const v = EditorView.findFromDOM(reader().querySelector<HTMLElement>(".cm-editor")!);
      if (!v) throw new Error("no editor yet");
      return v;
    });
    act(() => { view.dispatch({ changes: { from: view.state.doc.length, insert: "Squash.\n" } }); });
    fireEvent.click(within(reader()).getByRole("button", { name: "Save" }));
    // THE MUTANT: write at once — Claude's own file changed with nobody asked.
    const ask = await within(reader()).findByRole("group", { name: "Write CLAUDE.md" });
    expect(ask).toHaveTextContent("CLAUDE.md is Claude's own file, outside Realm. Write your change into it?");
    expect(api.calls.some((c) => c.startsWith("memoryLibraryWrite"))).toBe(false);
    fireEvent.click(within(ask).getByRole("button", { name: "Write it" }));
    await waitFor(() => expect(api.calls).toContain("memoryLibraryWrite:claude-user:CLAUDE.md:true"));
  });

  it("names what Delete does — a commit in the repo, the Trash outside it — and does it only when told", async () => {
    const { api } = await mount();
    fireEvent.click(within(reader()).getByRole("button", { name: "Delete Creator campaign" }));
    const ask = within(reader()).getByRole("group", { name: "Delete Creator campaign" });
    expect(ask).toHaveTextContent("Delete creators.md? It is removed from the memory repo with a commit, and its line leaves MEMORY.md.");
    expect(api.calls.some((c) => c.startsWith("memoryLibraryDelete"))).toBe(false);
    fireEvent.click(within(ask).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.calls).toContain(`memoryLibraryDelete:${REPO}:creators.md:false`));

    fireEvent.click(within(list()).getByText("House rules"));
    await screen.findByRole("heading", { name: "House rules", level: 2 });
    fireEvent.click(within(reader()).getByRole("button", { name: "Delete House rules" }));
    const trash = within(reader()).getByRole("group", { name: "Delete House rules" });
    expect(trash).toHaveTextContent("It moves to the Trash");
    fireEvent.click(within(trash).getByRole("button", { name: "Move to Trash" }));
    await waitFor(() => expect(api.calls).toContain("memoryLibraryDelete:claude-user:CLAUDE.md:true"));
  });

  it("writes a new memory into the page's own space's folder by default, and reads it once made", async () => {
    const { api } = await mount();
    fireEvent.click(within(list()).getByRole("button", { name: "New memory" }));
    const form = await screen.findByRole("form", { name: "New memory" });
    expect(within(form).getByRole("combobox", { name: "Where" })).toHaveDisplayValue("Memory repo · Versed");
    expect([...within(form).getByRole("combobox", { name: "Where" }).querySelectorAll("option")].map((o) => o.textContent))
      .toEqual(["Memory repo · every space", "Memory repo · Versed", "Memory repo · Homework"]);
    const save = within(form).getByRole("button", { name: "Save memory" });
    expect(save).toBeDisabled();
    fireEvent.change(within(form).getByRole("textbox", { name: "Name" }), { target: { value: "Spring logins" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Description" }), { target: { value: "Where the campaign's logins are kept" } });
    fireEvent.change(within(form).getByRole("combobox", { name: "Type" }), { target: { value: "reference" } });
    fireEvent.click(save);
    await waitFor(() => expect(api.calls).toContain(`memoryLibraryCreate:${REPO}:s1:Spring logins`));
    expect(await screen.findByRole("heading", { name: "Spring logins", level: 2 })).toBeInTheDocument();
  });
});

describe("withoutTitle", () => {
  it("leaves out the opening heading the head already shows, and only that", () => {
    expect(withoutTitle("# House rules\n\nPrefer small PRs.\n", "House rules")).toBe("Prefer small PRs.\n");
    expect(withoutTitle("# Other\n\nText\n", "House rules")).toBe("# Other\n\nText\n");
    expect(withoutTitle("Text first\n# House rules\n", "House rules")).toBe("Text first\n# House rules\n");
  });
});

describe("linkWikiLinks", () => {
  it("draws a [[link]] as a link to what was written, and leaves fenced code alone", () => {
    expect(linkWikiLinks("See [[projects/pay day]].\n```\n[[not a link]]\n```\n")).toBe("See [projects/pay day](<projects/pay day>).\n```\n[[not a link]]\n```\n");
  });
});

describe("Profile settings ▸ Memory", () => {
  it("lands the Library on its Memory section", async () => {
    const store = createAppStore(fakeApi());
    await store.getState().boot();
    await store.getState().openMemoryLibrary();
    expect(store.getState().libraryTab.s1).toBe("memory");
    expect(store.getState().pageOverlay).toMatchObject({ kind: "library-page" });
  });
});
