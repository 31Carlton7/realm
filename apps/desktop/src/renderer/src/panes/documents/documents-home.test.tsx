import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { findLeafOfItem, sessionEvent, type Environment, type LibraryEntry } from "@realm/contracts";

// The pane listens on the rpc singleton for file changes, which needs a real server port.
vi.mock("../../rpc/client", () => ({ rpc: () => ({ on: () => () => {} }) }));

import { DocumentsPane } from "./DocumentsPane";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { exited } from "../../components/popover-exit.test-fakes";
import { MediaViewer } from "../../components/viewer/MediaViewer";

/**
 * The documents pane's home (DocumentsHome.tsx): what a pane beside a session shows before a file
 * is open — the session's files, the Library's, search, New — and what each row does.
 */

const ROOT = "/Users/ada/work/yooo";
const ENV: Environment = { id: "env-s1", spaceId: "s1", path: ROOT, branch: "main", kind: "primary", portBlockStart: null, createdAt: 0, updatedAt: 0 };
const docsItem = item("i-docs", "s1", { kind: "documents", title: "Documents · yooo", refId: "docs1" });

/** One row of the Library index: a file a session wrote (`output`) or was given (`upload`). */
const art = (id: string, sessionId: string, path: string, ts: number, extra: Partial<LibraryEntry> = {}): LibraryEntry => {
  const name = path.split("/").pop()!;
  return { id, sessionId, spaceId: "s1", kind: "output", path, name, ext: name.split(".").pop()!.toLowerCase(), ts,
    sessionTitle: sessionId === "lead" ? "Pricing page" : "Onboarding copy", agentKind: "fake", ...extra };
};

/** The pane as a tab of the lead session's side pane — the way its bar's Documents button opens it —
 *  or, with `owned: false`, as a pane of its own. */
async function mount(o: { artifacts?: LibraryEntry[]; addedProfiles?: Record<string, string>; files?: Record<string, string>; checkout?: string[]; owned?: boolean } = {}) {
  const api = fakeApi({
    items: { s1: [item("i-lead", "s1", { kind: "session", refId: "lead", title: "Pricing page" }), docsItem] },
    sessions: [session("lead", "s1", { environmentId: ENV.id, cwd: ROOT, title: "Pricing page" })],
    environments: { s1: [ENV] },
    documentWorkspaces: { docs1: { id: "docs1", spaceId: "s1", environmentId: ENV.id, openPaths: [], activePath: null, createdAt: 0, updatedAt: 0 } },
    documentFiles: { docs1: { ...o.files } },
    artifacts: o.artifacts ?? [],
    addedProfiles: o.addedProfiles ?? {},
    projectFiles: { hits: (o.checkout ?? []).map((path) => ({ path, score: 1, segments: [{ text: path, match: false }] })), source: "git", truncated: false },
  });
  const store = createAppStore(api);
  await store.getState().boot();
  if (o.owned !== false) {
    await store.getState().openItem("i-lead");
    await store.getState().openInSidePane("lead", "i-docs");
  } else {
    await store.getState().openItem("i-docs");
  }
  const ui = render(<StoreContext.Provider value={store}><DocumentsPane item={docsItem} visible /><MediaViewer /></StoreContext.Provider>);
  return { api, store, ui };
}

/** The file names a section lists, in order. */
const namesIn = async (section: string) => {
  const region = await screen.findByRole("region", { name: section });
  return [...region.querySelectorAll(".docs-home-name")].map((n) => n.textContent);
};
const rowFor = (name: string) => screen.getAllByRole("button").find((b) => b.querySelector(".docs-home-name")?.textContent === name)!;

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => cleanup());

describe("the documents home", () => {
  it("lists what this session made and was given, then the Library's — each file once", async () => {
    await mount({ artifacts: [
      art("a1", "lead", "notes/plan.md", 100),
      art("a2", "lead", "notes/plan.md", 300),
      art("a3", "lead", "/Users/ada/Downloads/brief.pdf", 200, { kind: "upload" }),
      art("a4", "other", `${ROOT}/old.md`, 50),
      // The same file as the session's own plan, written by another session as an absolute path.
      art("a5", "other", `${ROOT}/notes/plan.md`, 40),
    ] });
    // THE MUTANTS: the session filter dropped (the Library's old.md listed as this session's), the
    // per-file collapse dropped (plan.md twice), or the cross-section dedupe dropped (plan.md again
    // under Library because another session also wrote it).
    expect(await namesIn("This session")).toEqual(["plan.md", "brief.pdf"]);
    expect(await namesIn("Library")).toEqual(["old.md"]);
    const session = screen.getByRole("region", { name: "This session" });
    expect([...session.querySelectorAll(".docs-home-detail")].map((d) => d.textContent)).toEqual(["notes", "Attached"]);
    expect(within(screen.getByRole("region", { name: "Library" })).getByText("Onboarding copy")).toBeTruthy();
  });

  it("lists a file the person added under the Library, as Added — and one added from the page over it, at once", async () => {
    /* One index, whichever surface reads it. THE mutant: the home asks again only when its session
       moves, so a file added from the Library page over this pane is missing until the agent next
       writes something. */
    const scan: LibraryEntry = { id: "f1", sessionId: null, spaceId: null, kind: "added", path: "/realm-home/library/p1/scan.pdf", name: "scan.pdf",
      ext: "pdf", ts: 90, sessionTitle: null, agentKind: null };
    const { store } = await mount({ artifacts: [scan], addedProfiles: { f1: "p1" } });
    expect(await namesIn("Library")).toEqual(["scan.pdf"]);
    expect(within(screen.getByRole("region", { name: "Library" })).getByText("Added")).toBeTruthy();
    expect(rowFor("scan.pdf").title).toContain("Added by you");
    await act(async () => { await store.getState().addLibraryFiles("p1", ["/Users/ada/Desktop/brief.md"]); });
    await waitFor(async () => expect(await namesIn("Library")).toEqual(["brief.md", "scan.pdf"]));
  });

  it("lists a picture the server found after the turn settled, though the transcript grew no block", async () => {
    const artifacts = [art("a1", "lead", "notes/plan.md", 100)];
    const { store } = await mount({ artifacts });
    // The session's transcript, as its own pane beside this one has it loaded.
    await act(() => store.getState().openSession("lead"));
    expect(await namesIn("This session")).toEqual(["plan.md"]);
    // The sweep's event lands after the settle and indexes the picture server-side.
    artifacts.push(art("a9", "lead", "/Users/ada/Realm/work/versed/decks/v1/01.png", 500));
    const made = { settledAt: 400, files: [{ path: "/Users/ada/Realm/work/versed/decks/v1/01.png", size: 9 }], totalFiles: 1 };
    act(() => store.getState().applySessionEvent({ seq: 9000, sessionId: "lead", event: sessionEvent("files_made", made, 450), ephemeral: false }));
    // THE mutant: the beat counting blocks alone, which a side-channel event never adds to.
    await waitFor(async () => expect(await namesIn("This session")).toEqual(["01.png", "plan.md"]));
  });

  it("says, in a brand-new session, that the agent's files will appear here — and still lists the Library", async () => {
    await mount({ artifacts: [art("a4", "other", `${ROOT}/old.md`, 50)] });
    const session = await screen.findByRole("region", { name: "This session" });
    expect(session.textContent).toContain("Files the agent writes or edits in this session, and files you attach to a message, appear here.");
    expect(await namesIn("Library")).toEqual(["old.md"]);
  });

  it("opens a file inside the checkout as a tab of the pane", async () => {
    const { api } = await mount({ artifacts: [art("a1", "lead", "notes/plan.md", 100)], files: { "notes/plan.md": "# Plan\n" } });
    await screen.findByRole("region", { name: "This session" });
    fireEvent.click(rowFor("plan.md"));
    await waitFor(() => expect(api.calls).toContain("readDocument:docs1:notes/plan.md"));
    expect(await screen.findByRole("tab", { name: /^plan/ })).toHaveAttribute("aria-selected", "true");
    // The home steps aside for the file, and stays one tab away.
    expect(screen.queryByRole("region", { name: "This session" })).toBeNull();
    expect(screen.getByRole("button", { name: "Files" })).toBeTruthy();
  });

  it("opens a file the pane cannot reach in the media viewer, which does not offer the pane", async () => {
    // A download the user attached: outside the checkout, so no tab could hold it. THE MUTANT: open
    // it as a tab anyway — the server refuses the path and the click ends in an error.
    const { api } = await mount({ artifacts: [art("a3", "lead", "/Users/ada/Downloads/brief.pdf", 200, { kind: "upload" })] });
    await screen.findByRole("region", { name: "This session" });
    fireEvent.click(rowFor("brief.pdf"));
    expect(await screen.findByRole("dialog", { name: "brief.pdf" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open in the documents pane" })).toBeNull();
    expect(api.calls.some((c) => c.startsWith("readDocument:"))).toBe(false);
  });

  it("opens a markdown file the session wrote OUTSIDE the space in the pane, rendered and read-only", async () => {
    /* The report: a REPORT.md in another worktree opened as Quick Look's grey picture of its source.
       THE MUTANTS: route an outside file to the viewer again (a dialog, no read), or open it editable
       (a toolbar, a contenteditable surface, a rename button, a "Saved" that claims a write). */
    const report = "/Users/ada/work/other-worktree/.verify/tool-rejection/REPORT.md";
    const { api } = await mount({ artifacts: [art("a1", "lead", report, 100)], files: { [report]: "# Tool rejection\n\nThe card **lands**.\n" } });
    await screen.findByRole("region", { name: "This session" });
    fireEvent.click(rowFor("REPORT.md"));
    await waitFor(() => expect(api.calls).toContain(`readDocument:docs1:${report}`));
    expect(await screen.findByRole("tab", { name: /^REPORT/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("dialog")).toBeNull();
    const surface = await waitFor(() => {
      const el = document.querySelector(".documents-editor .ProseMirror");
      if (!el?.querySelector("h1")) throw new Error("not drawn yet");
      return el;
    });
    expect(surface.querySelector("h1")!.textContent).toBe("Tool rejection");
    expect(surface.getAttribute("contenteditable")).toBe("false");
    expect(screen.queryByRole("button", { name: "Bold" })).toBeNull();
    expect(screen.getByText("Outside this space · read-only")).toBeTruthy();
    expect(screen.getByText("~/work/other-worktree/.verify/tool-rejection")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show in Finder" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Read-only");
    expect(document.querySelector("button.documents-name")).toBeNull();
  });

  it("opens source the session wrote outside the space highlighted and read-only, and never writes it", async () => {
    // THE MUTANT: a CodeEditor built without its read-only facets — the edit lands and autosaves.
    const script = "/Users/ada/work/other-worktree/apps/desktop/scripts/teams-vault-live.mjs";
    const { api, ui } = await mount({ artifacts: [art("a1", "lead", script, 100)], files: { [script]: "export const a = 1;\n" } });
    await screen.findByRole("region", { name: "This session" });
    fireEvent.click(rowFor("teams-vault-live.mjs"));
    const view = await waitFor(() => {
      const el = ui.container.querySelector(".cm-editor") as HTMLElement | null;
      const v = el ? EditorView.findFromDOM(el) : null;
      if (!v) throw new Error("no editor yet");
      return v;
    });
    expect(view.state.readOnly).toBe(true);
    expect(view.state.doc.toString()).toBe("export const a = 1;\n");
    expect(screen.getByText("Outside this space · read-only")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 800));
    expect(api.calls.some((c) => c.startsWith("writeDocument:"))).toBe(false);
  });

  it("says in the pane why an outside file cannot be shown, never an empty editor", async () => {
    // Recorded, then gone from disk. THE MUTANT: the read's failure left to an error far from the row.
    const gone = "/Users/ada/work/other-worktree/NOTES.md";
    await mount({ artifacts: [art("a1", "lead", gone, 100)] });
    await screen.findByRole("region", { name: "This session" });
    fireEvent.click(rowFor("NOTES.md"));
    const note = await waitFor(() => { const n = document.querySelector(".documents-unshown"); if (!n) throw new Error("no note"); return n; });
    expect(note.textContent).toContain("NOTES.md could not be read");
    expect(within(note as HTMLElement).getByRole("button", { name: "Show in Finder" })).toBeTruthy();
    expect(within(note as HTMLElement).getByRole("button", { name: "Open with the default app" })).toBeTruthy();
    expect(document.querySelector(".documents-editor")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a picture in the media viewer even inside the checkout, asked about in this session", async () => {
    /* Media is looked at in the viewer, with the session's prompter under it — a tab of Quick Look's
       render of a screenshot was the one way a picture opened without it. The pane is still a click
       away on the viewer's own bar. THE MUTANT: let a picture take the tab branch with the rest. */
    const { api, store } = await mount({ artifacts: [art("a4", "lead", "shots/hero.png", 300)] });
    await screen.findByRole("region", { name: "This session" });
    fireEvent.click(rowFor("hero.png"));
    expect(await screen.findByRole("dialog", { name: "hero.png" })).toBeTruthy();
    expect(store.getState().viewer).toMatchObject({ sessionId: "lead", files: [{ path: `${ROOT}/shots/hero.png`, inPane: true }] });
    expect(screen.getByRole("button", { name: "Open in the documents pane" })).toBeTruthy();
    expect(api.calls.some((c) => c.startsWith("readDocument:"))).toBe(false);
  });

  it("adds a file to the next message to the session, and takes it back out", async () => {
    const { store } = await mount({ artifacts: [art("a1", "lead", "notes/plan.md", 100)] });
    await screen.findByRole("region", { name: "This session" });
    const add = screen.getByRole("button", { name: "Add plan.md to the next message" });
    expect(add).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(add);
    // Through the prompter's own attachments, at the file's absolute path — not a list of its own.
    await waitFor(() => expect(store.getState().pendingAttachments.lead?.map((a) => a.path)).toEqual([`${ROOT}/notes/plan.md`]));
    expect(add).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(add);
    await waitFor(() => expect(store.getState().pendingAttachments.lead).toEqual([]));
  });

  it("takes a file the person added back out of the Library from its row — its menu or Delete — and nothing else", async () => {
    /* The same file offers the same things from every list that shows it. THE mutants: a menu with no
       Remove for an added file here, a Remove offered on the session's own file, or Delete that leaves
       the keyboard on nothing. */
    const scan: LibraryEntry = { id: "f1", sessionId: null, spaceId: null, kind: "added", path: "/realm-home/library/p1/scan.pdf", name: "scan.pdf",
      ext: "pdf", ts: 90, sessionTitle: null, agentKind: null };
    const memo: LibraryEntry = { ...scan, id: "f2", path: "/realm-home/library/p1/memo.md", name: "memo.md", ext: "md", ts: 80 };
    const { api, store } = await mount({ artifacts: [art("a1", "lead", "notes/plan.md", 100), scan, memo], addedProfiles: { f1: "p1", f2: "p1" } });
    expect(await namesIn("Library")).toEqual(["scan.pdf", "memo.md"]);
    const labels = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((b) => b.querySelector(".menu-label")!.textContent);
    fireEvent.contextMenu(rowFor("plan.md"));
    expect(labels(await screen.findByRole("menu", { name: "plan.md" }))).toEqual(["Open", "Reveal in Finder", "Copy path"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // The row's file is in the next message, and goes out of it with the file.
    fireEvent.click(screen.getByRole("button", { name: "Add scan.pdf to the next message" }));
    await waitFor(() => expect(store.getState().pendingAttachments.lead?.map((a) => a.path)).toEqual(["/realm-home/library/p1/scan.pdf"]));
    fireEvent.contextMenu(rowFor("scan.pdf"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Remove from Library/ }));
    await waitFor(async () => expect(await namesIn("Library")).toEqual(["memo.md"]));
    expect(api.calls).toContain("removeLibraryFiles:p1:/realm-home/library/p1/scan.pdf");
    expect(store.getState().pendingAttachments.lead).toEqual([]);
    // Delete on the row in focus does the same, and the keyboard moves on rather than falling to the page.
    rowFor("memo.md").focus();
    fireEvent.keyDown(rowFor("memo.md"), { key: "Backspace" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Library" })?.querySelector(".docs-home-name")).toBeFalsy());
    await waitFor(() => expect(document.activeElement).toBe(rowFor("plan.md")));
    // …onto the session's own file, which Delete leaves alone.
    fireEvent.keyDown(rowFor("plan.md"), { key: "Backspace" });
    expect(api.calls.filter((c) => c.startsWith("removeLibraryFiles:"))).toHaveLength(2);
  });

  it("in a pane of its own, lists no session and offers nothing to add a file to", async () => {
    await mount({ owned: false, artifacts: [art("a1", "lead", "notes/plan.md", 100)] });
    expect(await namesIn("Library")).toEqual(["plan.md"]);
    expect(screen.queryByRole("region", { name: "This session" })).toBeNull();
    expect(screen.queryByRole("button", { name: /to the next message/ })).toBeNull();
  });

  it("searches every list and the checkout's names, and Return opens the first", async () => {
    const { api } = await mount({
      artifacts: [art("a1", "lead", "notes/plan.md", 100), art("a4", "other", `${ROOT}/old.md`, 50)],
      files: { "notes/plan.md": "# Plan\n" },
      checkout: ["notes/plan.md", "docs/planning.md"],
    });
    await screen.findByRole("region", { name: "This session" });
    const field = screen.getByRole("searchbox", { name: "Search files" });
    fireEvent.change(field, { target: { value: "plan" } });
    // The checkout's own names, under the folder's name — minus the file this session already lists.
    expect(await namesIn("In yooo")).toEqual(["planning.md"]);
    expect(api.calls).toContain("libraryArtifacts:all:any:any:plan");
    expect(api.calls).toContain(`projectFiles:${ROOT}:plan`);
    // A list with nothing that matches is not drawn at all while searching.
    expect(screen.queryByRole("region", { name: "Library" })).toBeNull();
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.calls).toContain("readDocument:docs1:notes/plan.md"));
  });

  it("offers to make a typed name nothing here has, and Return makes exactly it", async () => {
    const { api } = await mount();
    const field = await screen.findByRole("searchbox", { name: "Search files" });
    fireEvent.change(field, { target: { value: "launch.md" } });
    expect(await screen.findByText("Create launch.md")).toBeTruthy();
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.calls).toContain("createDocumentFile:docs1:launch.md"));
    expect(await screen.findByRole("tab", { name: /^launch/ })).toHaveAttribute("aria-selected", "true");
    // Named already: the name field is for a file still called "untitled".
    expect(screen.queryByLabelText("Document name")).toBeNull();
  });

  it("goes back to the home from an open file, and back to the file from its tab", async () => {
    await mount({ artifacts: [art("a1", "lead", "notes/plan.md", 100)], files: { "notes/plan.md": "# Plan\n" } });
    await screen.findByRole("region", { name: "This session" });
    fireEvent.click(rowFor("plan.md"));
    const tab = await screen.findByRole("tab", { name: /^plan/ });
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(await screen.findByRole("region", { name: "This session" })).toBeTruthy();
    expect(tab).toHaveAttribute("aria-selected", "false");
    fireEvent.click(within(tab).getByTitle("notes/plan.md"));
    await waitFor(() => expect(screen.queryByRole("region", { name: "This session" })).toBeNull());
    expect(tab).toHaveAttribute("aria-selected", "true");
  });
});

describe("New › Code file…", () => {
  const openPrompt = async () => {
    await exited();
    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Code file…" }));
    return within(await screen.findByRole("dialog", { name: "New code file" }));
  };

  it("names the file by its language, and opens it in the code editor still to be named", async () => {
    const { api } = await mount();
    const prompt = await openPrompt();
    const name = prompt.getByRole("textbox", { name: "File name" }) as HTMLInputElement;
    expect(name.value).toBe("untitled.ts");
    // Picking a language rewrites the extension; the name is what decides the editor.
    fireEvent.click(prompt.getByRole("option", { name: /Python/ }));
    expect(name.value).toBe("untitled.py");
    expect(prompt.getByRole("option", { name: /Python/ })).toHaveAttribute("aria-selected", "true");
    expect(prompt.getByText("Opens in the code editor as Python")).toBeTruthy();
    fireEvent.click(prompt.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.calls).toContain("createDocumentFile:docs1:untitled.py"));
    // Opened, in the code editor, with the name field up — "untitled" is a name nobody chose.
    await waitFor(() => expect(document.querySelector(".documents-code")).not.toBeNull());
    expect(await screen.findByLabelText("Document name")).toHaveFocus();
  });

  it("takes a whole typed name as it is, and refuses one the folder already has", async () => {
    const { api } = await mount({ files: { "server.go": "package main\n" } });
    const prompt = await openPrompt();
    const name = () => prompt.getByRole("textbox", { name: "File name" }) as HTMLInputElement;
    fireEvent.change(name(), { target: { value: "server.go" } });
    // THE MUTANT: no check against the folder, and Create overwrites… or, at the server, fails with
    // an error the prompt never warned of.
    expect(prompt.getByText("server.go is already in this folder.")).toBeTruthy();
    expect(prompt.getByRole("button", { name: "Create" })).toBeDisabled();
    fireEvent.change(name(), { target: { value: "client.go" } });
    expect(prompt.getByRole("option", { name: /^Go/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(name(), { key: "Enter" });
    await waitFor(() => expect(api.calls).toContain("createDocumentFile:docs1:client.go"));
    expect(screen.queryByLabelText("Document name")).toBeNull();
  });
});

describe("asked from outside the pane", () => {
  it("⌘P puts the keyboard in the home's search, even from an open file", async () => {
    const { store } = await mount({ artifacts: [art("a1", "lead", "notes/plan.md", 100)], files: { "notes/plan.md": "# Plan\n" } });
    await screen.findByRole("region", { name: "This session" });
    fireEvent.click(rowFor("plan.md"));
    await screen.findByRole("tab", { name: /^plan/ });
    // The keyboard is in the session beside it, as it is when ⌘P is pressed from the prompter.
    act(() => store.getState().focusLeaf(findLeafOfItem(store.getState().layout!, "i-lead")!.id));
    await act(() => store.getState().findInDocuments());
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search files" })).toHaveFocus());
    // Taken, so the same pane mounting again later is not asked twice.
    expect(store.getState().documentsAsk).toBeNull();
  });

  it("shows a file at the line asked for, by the one route into the pane", async () => {
    const { store, ui } = await mount({ files: { "src/greet.ts": "one\ntwo\nthree\n" } });
    await screen.findByRole("searchbox", { name: "Search files" });
    await act(() => store.getState().openDocumentPath("src/greet.ts", ENV.id, null, { line: 2 }));
    const view = await waitFor(() => {
      const el = ui.container.querySelector(".cm-editor") as HTMLElement | null;
      const v = el ? EditorView.findFromDOM(el) : null;
      if (!v) throw new Error("no editor yet");
      return v;
    });
    await waitFor(() => expect(view.state.doc.lineAt(view.state.selection.main.anchor).number).toBe(2));
  });
});
