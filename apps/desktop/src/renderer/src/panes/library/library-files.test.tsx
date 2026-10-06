import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LIBRARY_PAGE_SIZE, PAGE_REF_IDS, type LibraryEntry } from "@realm/contracts";
import { LibraryPage } from "./LibraryPage";
import { groupByDay } from "./LibraryFiles";
import { createAppStore, StoreContext } from "../../state/store";
import { resetThumbnailCache } from "../../components/use-thumbnail";
import { breakableName, FileCard } from "../../components/FileCard";
import { allOnScreen } from "../../components/on-screen.test-fakes";
import { resetMediaCache } from "../session/media/use-media";
import { fakeApi, item, session, space, type FakeData } from "../../state/store.test-fakes";
import { MediaViewer } from "../../components/viewer/MediaViewer";
import { Toasts } from "../../components/Toasts";

/** The preload bridge, as the preview and the cards see it. jsdom has none, so every capability the
 *  Library offers has to be stubbed here — and a stub that is MISSING is itself the interesting case,
 *  since the whole rule is that a button is drawn only where the thing behind it exists. */
function bridge(over: Record<string, unknown> = {}) {
  const files = {
    stat: vi.fn(async (path: string) => ({ path, size: 2048, mtimeMs: 1_700_000_000_000 })),
    preview: vi.fn(async () => null),
    reveal: vi.fn(async (_path: string) => undefined),
    saveCopy: vi.fn(async (_path: string) => "/Users/me/Downloads/report.md"),
    finderIcon: vi.fn(async () => "data:image/png;base64,FINDER"),
  };
  const realm = {
    files,
    attachmentThumbnail: vi.fn(async (_path: string) => "data:image/png;base64,AAAA"),
    openAttachment: vi.fn(async (_path: string) => undefined),
    // Nothing is media unless a case says so: `useMediaFiles` aligns its answers positionally.
    media: { stat: vi.fn(async (c: readonly string[]) => c.map(() => null)), poster: vi.fn(async () => null), reveal: vi.fn(), open: vi.fn() },
    ...over,
  };
  vi.stubGlobal("window", Object.assign(window, { realm }));
  return realm as typeof realm & { files: typeof files };
}

beforeEach(() => { resetThumbnailCache(); resetMediaCache(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const DAY = 86_400_000;
const file = (over: Partial<LibraryEntry> & { id: string }): LibraryEntry => ({
  sessionId: "se1", spaceId: "s1", kind: "output", path: `/tmp/${over.id}`, name: over.id,
  ext: "md", ts: 1_700_000_000_000, sessionTitle: "The parser rewrite", agentKind: "claude", ...over,
});

async function mount(over: FakeData = {}) {
  const api = fakeApi(over);
  const store = createAppStore(api);
  await store.getState().boot();
  render(
    <StoreContext.Provider value={store}>
      <LibraryPage item={item("i1", "s1", { kind: "library-page", refId: PAGE_REF_IDS["library-page"], title: "Library" })} visible />
      <MediaViewer />
    </StoreContext.Provider>,
  );
  return { api, store };
}

describe("grouping files by day", () => {
  const now = new Date("2026-09-08T12:00:00").getTime();

  it("groups CONSECUTIVE runs, so two runs a year apart never merge under one heading", () => {
    /* The mutant: key a Map by the label. "September 8" renders the same words in two different
       years, and a keyed map would file last year's files under this year's heading. */
    const groups = groupByDay([
      file({ id: "a", ts: now }),
      file({ id: "b", ts: now - 365 * DAY }),
      file({ id: "c", ts: now - 2 * DAY }),
    ], now);
    expect(groups.map((g) => g.entries.map((e) => e.id))).toEqual([["a"], ["b"], ["c"]]);
  });

  it("names today, yesterday and this week the way a person asks about them", () => {
    const groups = groupByDay([file({ id: "a", ts: now }), file({ id: "b", ts: now - DAY })], now);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday"]);
  });
});

describe("the Library's file browser", () => {
  it("leads with Files, and lists what each file is and where it came from", async () => {
    await mount({ artifacts: [
      file({ id: "report.md" }),
      file({ id: "shot.png", kind: "upload", ext: "png", sessionTitle: "Design review" }),
    ] });
    expect(await screen.findByText("report.md")).toBeTruthy();
    // "Made" and "attached" are the same file to the filesystem and very different facts to a
    // reader trying to remember where something came from. The sentence is the accessible name; the
    // glyph beside the title is how it reads on screen.
    expect(screen.getByText("Made in The parser rewrite")).toBeTruthy();
    expect(screen.getByText("Attached to Design review")).toBeTruthy();
    /* The mutant: put "Made in " back in the VISIBLE span. jsdom cannot measure the ellipsis, but it
       can hold the rule that produced it — the session title is the row's only unbounded item and
       nothing fixed-width may share its element and take the slack first. */
    expect([...document.querySelectorAll(".library-tile-session")].map((e) => e.textContent))
      .toEqual(["The parser rewrite", "Design review"]);
  });

  it("tells an empty index apart from a search that matched nothing", async () => {
    const { api } = await mount({ artifacts: [file({ id: "report.md" })] });
    fireEvent.change(screen.getByLabelText("Search files"), { target: { value: "zzz" } });
    // "Nothing here yet" over a home with four hundred files is a lie about the app, not about the
    // search — so the two emptinesses get different words, decided by the unfiltered `total`.
    expect(await screen.findByText("No file here matches that.")).toBeTruthy();
    expect(api.calls.some((c) => c.startsWith("libraryArtifacts:") && c.endsWith(":zzz"))).toBe(true);
  });

  it("narrows by kind of file from the tabs, and asks the SERVER to do it", async () => {
    /* The mutant: filter the loaded page in the renderer. That answers correctly only for the rows
       already fetched, so a filter over a paged list would quietly show a page's worth of matches
       and call it the whole answer. */
    const { api } = await mount({ artifacts: [
      file({ id: "report.md" }),
      file({ id: "shot.png", ext: "png" }),
    ] });
    await screen.findByText("report.md");
    const tabs = screen.getByRole("group", { name: "Kind of file" });
    expect(within(tabs).getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(tabs).getByRole("button", { name: "Images" }));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("libraryArtifacts:") && c.includes(":image:"))).toBe(true));
    await waitFor(() => expect(screen.queryByText("report.md")).toBeNull());
    expect(screen.getByText("shot.png")).toBeTruthy();
    expect(within(tabs).getByRole("button", { name: "Images" })).toHaveAttribute("aria-pressed", "true");
  });

  it("narrows by space and by who made it from the filter menu, and says so where the tabs are", async () => {
    /* The two rarer narrowings live behind one button — and a list that is shorter than it should be
       has to say why. THE mutants: a narrowing with no chip (the list just shrinks), or a chip that
       does not undo it. */
    const { api } = await mount({ artifacts: [
      file({ id: "report.md" }),
      file({ id: "shot.png", kind: "upload" }),
    ] });
    await screen.findByText("report.md");
    const filter = screen.getByRole("button", { name: "Filter files" });
    expect(filter).not.toHaveAttribute("data-on");
    fireEvent.click(filter);
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Attached by you" }));
    await waitFor(() => expect(api.calls.some((c) => c.includes(":upload:"))).toBe(true));
    // The menu leaves on a short fade (design.md: a menu has no entrance, and exits quietly).
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Filter files" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "In this space" }));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("libraryArtifacts:s1:upload:"))).toBe(true));
    expect(screen.getByRole("button", { name: "Filter files" })).toHaveAttribute("data-on");
    // Said where the tabs are, and undone from there.
    const chip = screen.getByRole("button", { name: /In this space/ });
    fireEvent.click(chip);
    await waitFor(() => expect(api.calls.at(-1)).toMatch(/^libraryArtifacts:all:upload:/));
    fireEvent.click(screen.getByRole("button", { name: /Attached by you/ }));
    await waitFor(() => expect(api.calls.at(-1)).toMatch(/^libraryArtifacts:all:any:/));
    expect(screen.getByRole("button", { name: "Filter files" })).not.toHaveAttribute("data-on");
  });

  it("means every space of the window's profile by every space, and no other profile's", async () => {
    /* Profiles are separate homes (Plan 27). THE mutant: a query with no profile, which the server
       answers with every profile's files — a Work window listing what School's sessions made. */
    const { api } = await mount({
      spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework"), space("s9", "p2", "Elsewhere")],
      artifacts: [file({ id: "ours.md" }), file({ id: "theirs.md", spaceId: "s9", sessionId: "se9" })],
    });
    expect(await screen.findByText("ours.md")).toBeTruthy();
    expect(screen.queryByText("theirs.md")).toBeNull();
    expect(api.calls).toContain("libraryArtifactsProfile:p1");
  });

  it("lays the files out as tiles or as rows, and remembers which", async () => {
    // THE mutant: a view that is component state, so the Library forgets it every time it opens.
    const { api, store } = await mount({ artifacts: [file({ id: "report.md" })] });
    await screen.findByText("report.md");
    expect(store.getState().libraryView).toBe("grid");
    expect(document.querySelector(".library-tile")).not.toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Rows" }));
    await waitFor(() => expect(document.querySelector(".library-row")).not.toBeNull());
    expect(document.querySelector(".library-tile")).toBeNull();
    expect(api.calls).toContain("setSetting:ui.libraryView=list");
    // The row says what the tile says: the name, where it came from, and when.
    const row = document.querySelector(".library-row")!;
    expect(row.querySelector(".library-row-name")!.textContent).toBe("report.md");
    expect(within(row as HTMLElement).getByText("Made in The parser rewrite")).toBeTruthy();
    expect(row.querySelector(".library-row-time")!.textContent).not.toBe("");
  });

  it("opens on the view it was left in", async () => {
    await mount({ artifacts: [file({ id: "report.md" })], settings: { "ui.libraryView": "list" } });
    await screen.findByText("report.md");
    expect(document.querySelector(".library-row")).not.toBeNull();
    expect(screen.getByRole("radio", { name: "Rows" })).toBeChecked();
  });

  it("walks the tiles with the arrow keys, by where they are on screen", async () => {
    /* jsdom lays nothing out, so the tiles are given the boxes a three-column grid would: a, b, c
       across the top, d, e, f under them. THE mutants: step by DOM order (Down from b lands on d,
       the first tile below rather than the one under it), or let Right off the end of a row wrap
       into the next one. */
    await mount({ artifacts: ["a", "b", "c", "d", "e", "f"].map((id, i) => file({ id: `${id}.md`, ts: 1_700_000_000_000 - i })) });
    await screen.findByText("f.md");
    const tiles = [...document.querySelectorAll<HTMLElement>(".library-tile")];
    const boxes: [number, number][] = [[0, 0], [200, 0], [400, 0], [0, 200], [200, 200], [400, 200]];
    tiles.forEach((t, i) => {
      const [x, y] = boxes[i]!;
      t.getBoundingClientRect = () => ({ left: x, top: y, right: x + 180, bottom: y + 180, width: 180, height: 180, x, y, toJSON() {} }) as DOMRect;
      t.scrollIntoView = () => {};
    });
    tiles[1]!.focus();
    fireEvent.keyDown(tiles[1]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(tiles[4]);
    fireEvent.keyDown(tiles[4]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tiles[3]);
    fireEvent.keyDown(tiles[3]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(tiles[0]);
    // The end of a row is the end: Right from c does not wrap round to d.
    tiles[2]!.focus();
    fireEvent.keyDown(tiles[2]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tiles[2]);
  });

  it("asks main for a picture only where the picture IS the file", async () => {
    /* The mutant: drop the type gate and thumbnail every tile. Correct on screen, and it puts one
       `qlmanage` child process behind every card — sixty per page of this grid — for marks nobody
       looks at. The gate is the whole reason the grid stays cheap to scroll.
       Both cards are on screen: this case is about WHICH cards ask. When a card asks is the card's
       own question (file-card.test.tsx). */
    const realm = bridge();
    allOnScreen();
    await mount({ artifacts: [
      file({ id: "shot.png", ext: "png", path: "/tmp/shot.png" }),
      file({ id: "theme.css", ext: "css", path: "/tmp/theme.css" }),
    ] });
    await screen.findByText("shot.png");
    // At CARD size: the picture fills a ~200px field on a 2× display, and the 96px tile mark the
    // composer's chips use would be a smear there.
    await waitFor(() => expect(realm.attachmentThumbnail).toHaveBeenCalledWith("/tmp/shot.png", "card"));
    expect(realm.attachmentThumbnail.mock.calls.map((c) => c[0])).not.toContain("/tmp/theme.css");
  });

  it("lays every file out on one square — the picture edge to edge, or the name over its glyph", async () => {
    /* Codex's tile, with one improvement: the picture's name comes up over it rather than being lost.
       THE mutants: a picture tile that keeps the glyph's layout (a thumbnail in a well under the
       name), or a glyph tile with no name at its head. */
    bridge();
    allOnScreen();
    await mount({ artifacts: [
      file({ id: "shot.png", ext: "png", path: "/tmp/shot.png" }),
      file({ id: "notes.md", ext: "md", path: "/tmp/notes.md" }),
    ] });
    await screen.findByText("notes.md");
    const cards = [...document.querySelectorAll(".library-tile")];
    expect(cards).toHaveLength(2);
    await waitFor(() => expect(cards[0]).toHaveAttribute("data-thumb"));
    expect(cards[0]!.children[0]).toHaveClass("library-tile-thumb");
    expect(cards[0]!.querySelector(".library-tile-caption .library-tile-name")!.textContent).toBe("shot.png");
    expect(cards[0]!.querySelector(".library-tile-mark")).toBeNull();
    expect(cards[1]).not.toHaveAttribute("data-thumb");
    expect(cards[1]!.children[0]).toHaveClass("library-tile-name");
    expect(cards[1]!.children[1]).toHaveClass("library-tile-art");
    expect(cards[1]!.querySelector(".library-tile-art .library-tile-mark")).not.toBeNull();
  });

  it("wraps a long name between its words and keeps its extension whole", () => {
    // THE mutant: break anywhere, which is how Codex's own tile ends up with "…pd" over "f".
    const { container } = render(<span>{breakableName("NextGen_Fellows_2026_application.pdf")}</span>);
    const span = container.firstElementChild!;
    expect(span.textContent).toBe("NextGen_Fellows_2026_application.pdf");
    expect(span.querySelectorAll("wbr")).toHaveLength(3);
    expect([...span.childNodes].filter((n) => n.nodeType === 3).at(-1)!.textContent).toBe("application.pdf");
  });
});

describe("previewing a file from the Library", () => {
  /** Open the card for `path` and wait for the viewer's own stat to land. */
  async function openCard(path: string) {
    fireEvent.click(await screen.findByTitle(path));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("button", { name: "Close" });
    return dialog;
  }

  it("routes the viewer's Open the same way a session summary does, and no other way", async () => {
    /* The one rule the viewer keeps from the preview it replaced: a file must not open two different
       ways depending on which list it was reached from. `isOpenableArtifact` IS the summary's
       `documentKindFor(path) !== "unsupported"`, so a `.md` goes to the documents pane and a `.zip`
       goes to the OS. */
    const realm = bridge();
    const { api } = await mount({ artifacts: [
      file({ id: "report.md", path: "/tmp/report.md" }),
      file({ id: "archive.zip", ext: "zip", path: "/tmp/archive.zip" }),
    ] });
    await openCard("/tmp/report.md");
    fireEvent.click(await screen.findByRole("button", { name: "Open in the documents pane" }));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("openDocumentPath"))).toBe(true));
    // Going to the pane is leaving the viewer.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await openCard("/tmp/archive.zip");
    fireEvent.click(await screen.findByRole("button", { name: "Open with the default app" }));
    await waitFor(() => expect(realm.openAttachment).toHaveBeenCalledWith("/tmp/archive.zip"));
  });

  it("draws Reveal in Finder as Realm's folder, at the weight of the glyphs beside it", async () => {
    /* Finder's own icon was right in the preview's MENU, where a row is found by its picture. In the
       viewer's row of quiet marks the full-colour face was the one that shouted. THE MUTANT: put the
       face back — the button grows an <img>, and the head reads as an advert for the Finder. */
    const realm = bridge();
    await mount({ artifacts: [file({ id: "report.md", path: "/tmp/report.md" })] });
    const dialog = await openCard("/tmp/report.md");
    const reveal = within(dialog).getByRole("button", { name: "Reveal in Finder" });
    expect(reveal.querySelector("svg")).not.toBeNull();
    expect(reveal.querySelector("img")).toBeNull();
    expect(realm.files.finderIcon).not.toHaveBeenCalled();
  });

  it("saves a copy, reveals and copies the path through the bridge that can do all three", async () => {
    /* The mutant: reach for `media.reveal`. That gate admits only what a media element can decode,
       so revealing a `.md` would silently do nothing — which is exactly what the transcript's path
       menu and the empty diff pane were doing before `files.reveal` existed. */
    const realm = bridge();
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mount({ artifacts: [file({ id: "report.md", path: "/tmp/report.md" })] });
    const dialog = await openCard("/tmp/report.md");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save a copy…" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Reveal in Finder" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy path" }));
    expect(realm.files.saveCopy).toHaveBeenCalledWith("/tmp/report.md");
    expect(realm.files.reveal).toHaveBeenCalledWith("/tmp/report.md");
    expect(writeText).toHaveBeenCalledWith("/tmp/report.md");
  });

  it("goes to the session a file came from, switching space when it lives in another one", async () => {
    /* The mutant: call `openItem` on the id found in the ACTIVE space's items. The Library's default
       scope is every space in the profile, so most of what it lists was made somewhere else, and a
       jump that never switches space is a button that lands on nothing for exactly those rows. */
    bridge();
    const { api, store } = await mount({
      sessions: [session("se2", "s2", { title: "The other space" })],
      items: { s1: [item("i1", "s1")], s2: [item("i2", "s2", { kind: "session", refId: "se2" })] },
      artifacts: [file({ id: "far.md", path: "/tmp/far.md", sessionId: "se2", spaceId: "s2", sessionTitle: "The other space" })],
    });
    const dialog = await openCard("/tmp/far.md");
    fireEvent.click(within(dialog).getByRole("button", { name: "Made in The other space" }));
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    // The switch is only half of it: the session's own pane has to end up in the layout, or the jump
    // has left the user in a space they did not ask for with nothing opened.
    await waitFor(() => expect(JSON.stringify(store.getState().layout)).toContain("i2"));
    expect(api.calls).toContain("listItems:s2");
  });

  it("names a session that is gone instead of drawing a jump to it", async () => {
    /* A file outlives the session that made it — that is the whole reason the index joins the title
       at read time. A button here would switch space and land on nothing, which is a worse way to
       learn the session is gone than the sentence that replaces it. */
    bridge();
    await mount({ artifacts: [file({ id: "orphan.md", path: "/tmp/orphan.md", sessionId: "deleted", sessionTitle: "A session since deleted" })] });
    const dialog = await openCard("/tmp/orphan.md");
    expect(await within(dialog).findByText(/that session is gone/)).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /Made in A session since deleted/ })).toBeNull();
  });

  it("opens a picture straight into the viewer, with the page's other files beside it", async () => {
    /* There is no sheet in front of the picture any more, and nothing to expand: the card opens the
       viewer, which IS the picture at the window's size. The page's other files are its siblings, in
       the page's order, so → walks the grid the way the eye just did. */
    bridge({ media: { stat: async (c: readonly string[]) => c.map((path) => ({ path, mime: "image/png", kind: "image", size: 4096 })),
                      poster: async () => null, reveal: vi.fn(), open: vi.fn() } });
    const { store } = await mount({ artifacts: [
      file({ id: "shot.png", ext: "png", path: "/tmp/shot.png", kind: "upload", ts: 2 }),
      file({ id: "notes.md", path: "/tmp/notes.md", ts: 1 }),
    ] });
    await openCard("/tmp/shot.png");
    await waitFor(() => expect(document.querySelector(".media-viewer-img")).not.toBeNull());
    expect(store.getState().viewer!.files.map((f) => f.path)).toEqual(["/tmp/shot.png", "/tmp/notes.md"]);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens a file the person added like any other, saying it was added and offering its app, not the documents pane", async () => {
    /* An added file lives in Realm's own folder, in no checkout. THE mutants: the viewer naming a
       session that does not exist ("Made in null"), a jump to it, or Open in the documents pane — which
       the server refuses for a file outside the workspace. */
    bridge();
    await mount({
      artifacts: [file({ id: "notes.md", kind: "added", path: "/realm-home/library/p1/notes.md", sessionId: null, spaceId: null, sessionTitle: null, agentKind: null })],
      addedProfiles: { "notes.md": "p1" },
    });
    const dialog = await openCard("/realm-home/library/p1/notes.md");
    expect(within(dialog).getByText("Added by you")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /Added by you|Made in|Attached to/ })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Open in the documents pane" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Open with the default app" })).toBeTruthy();
  });

  it("draws no actions at all for a file that is no longer on disk", async () => {
    /* The index records what a session DID, not what survived it. Three buttons that each fail in
       turn is a worse way to learn the file is gone than one sentence saying so. */
    bridge({ files: { stat: vi.fn(async () => null), preview: vi.fn(async () => null), reveal: vi.fn(), saveCopy: vi.fn() } });
    await mount({ artifacts: [file({ id: "report.md", path: "/tmp/report.md" })] });
    await openCard("/tmp/report.md");
    expect(await screen.findByText("This file is no longer on disk.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open in the documents pane" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("asks for exactly one page, and for the next one only when the list is scrolled to it", async () => {
    /* The page is deliberately NOT a store slice and deliberately NOT one big fetch: the whole
       reason the server keeps an `artifacts` index is that folding every transcript to answer this
       does not scale, and pulling the whole index into the renderer would give that back. */
    const many = Array.from({ length: LIBRARY_PAGE_SIZE + 5 }, (_, i) =>
      file({ id: `f${String(i).padStart(3, "0")}.md`, ts: 1_700_000_000_000 - i }));
    // jsdom has no IntersectionObserver, and the pager is built on one — stubbing it as "never
    // intersects" is what makes this assertion about the FIRST page meaningful.
    vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
    const { api } = await mount({ artifacts: many });
    await screen.findByText("f000.md");
    expect(document.querySelectorAll(".library-tile")).toHaveLength(LIBRARY_PAGE_SIZE);
    expect(api.calls.filter((c) => c.startsWith("libraryArtifacts:"))).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});

/** A file as a drop hands it over: backed by a path, which is how Electron names a file from the Finder. */
const dropped = (path: string) => Object.assign(new File(["x"], path.split("/").pop()!), { path });
/** Files held over `el` and let go, the way a Finder drag arrives: its types carry "Files". */
function dropOn(el: Element, files: File[]) {
  const dataTransfer = { types: ["Files"], files, dropEffect: "none" };
  fireEvent.dragEnter(el, { dataTransfer });
  fireEvent.dragOver(el, { dataTransfer });
  fireEvent.drop(el, { dataTransfer });
}
const toastTexts = (store: { getState(): { toasts: { text: string }[] } }) => store.getState().toasts.map((t) => t.text);

describe("adding files to the Library", () => {
  it("adds what the picker chose and lists it as any file is — with a quiet Added, in All and in its kind's tab", async () => {
    /* The owner, 10-05: "an add button so the user can upload files to realm". THE mutants: an Add
       that never reaches the server, a page that does not ask again once it has (the files are added
       and not shown), or a tile that names a session for a file no session holds. */
    const { api, store } = await mount({
      artifacts: [file({ id: "plan.md", ts: 1 })],
      pickFiles: [
        { path: "/Users/me/Desktop/shot.png", mime: "image/png", name: "shot.png", size: 10 },
        { path: "/Users/me/Desktop/brief.pdf", mime: "application/pdf", name: "brief.pdf", size: 10 },
      ],
    });
    await screen.findByText("plan.md");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.calls).toContain("addLibraryFiles:p1:/Users/me/Desktop/shot.png,/Users/me/Desktop/brief.pdf"));
    const tile = (await screen.findByText("shot.png")).closest(".library-tile")!;
    expect(tile.querySelector(".library-tile-session")!.textContent).toBe("Added");
    expect(within(tile as HTMLElement).getByText("Added by you")).toHaveClass("visually-hidden");
    expect(screen.getByText("brief.pdf")).toBeTruthy();
    expect(toastTexts(store)).toContain("Added 2 files to the Library.");
    const tabs = screen.getByRole("group", { name: "Kind of file" });
    fireEvent.click(within(tabs).getByRole("button", { name: "Images" }));
    await waitFor(() => expect(screen.queryByText("plan.md")).toBeNull());
    expect(screen.getByText("shot.png")).toBeTruthy();
    expect(screen.queryByText("brief.pdf")).toBeNull();
    // And the filter has a name for them, beside the session's own two.
    fireEvent.click(screen.getByRole("button", { name: "Filter files" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: "Added by you" })).toBeTruthy();
  });

  it("takes files dropped anywhere on the page, lit while they are held over it, and says which it cannot add", async () => {
    // THE mutants: no drop target (the files land nowhere), or a file with no place on disk dropped silently.
    const { api, store } = await mount({ artifacts: [file({ id: "plan.md", ts: 1 })] });
    await screen.findByText("plan.md");
    const page = document.querySelector(".library-files")!;
    const dataTransfer = { types: ["Files"], files: [dropped("/Users/me/notes.md"), new File(["x"], "clip.png")], dropEffect: "none" };
    fireEvent.dragEnter(page, { dataTransfer });
    expect(document.querySelector(".library-drop")?.textContent).toBe("Drop to add to the Library");
    fireEvent.dragOver(page, { dataTransfer });
    fireEvent.drop(page, { dataTransfer });
    expect(document.querySelector(".library-drop")).toBeNull();
    await waitFor(() => expect(api.calls).toContain("addLibraryFiles:p1:/Users/me/notes.md"));
    expect(await screen.findByText("notes.md")).toBeTruthy();
    expect(toastTexts(store)).toEqual(expect.arrayContaining(["Only files on this Mac can be added: clip.png.", "Added notes.md to the Library."]));
  });

  it("asks before a dropped folder's files come in, and copies them only when told to", async () => {
    /* A folder is a question, not a copy. THE mutants: its files copied on the drop, an offer that never
       appears, or an Add on it that does not ask for the folder's files. */
    const { api } = await mount({
      addFolders: { "/Users/me/shots": { files: ["/Users/me/shots/a.png", "/Users/me/shots/b.png"], bytes: 2048, subfolders: 1 } },
    });
    await screen.findByText(/Nothing here yet/);
    dropOn(document.querySelector(".library-files")!, [dropped("/Users/me/shots")]);
    const offer = await screen.findByRole("group", { name: "Add the files in a folder" });
    expect(offer.textContent).toContain("“shots” is a folder of 2 files (2.0 KB). Add them to the Library? The folders inside it are left out.");
    expect(api.calls.filter((c) => c.startsWith("addLibraryFiles:"))).toEqual(["addLibraryFiles:p1:/Users/me/shots"]);
    expect(screen.queryByText("a.png")).toBeNull();
    fireEvent.click(within(offer).getByRole("button", { name: "Add 2 files" }));
    await waitFor(() => expect(api.calls).toContain("addLibraryFiles:p1:folders:/Users/me/shots"));
    expect(await screen.findByText("a.png")).toBeTruthy();
    expect(screen.getByText("b.png")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Add the files in a folder" })).toBeNull();
  });

  it("leaves a folder where it is on Not now", async () => {
    const { api } = await mount({ addFolders: { "/Users/me/shots": { files: ["/Users/me/shots/a.png"], bytes: 10, subfolders: 0 } } });
    await screen.findByText(/Nothing here yet/);
    dropOn(document.querySelector(".library-files")!, [dropped("/Users/me/shots")]);
    const offer = await screen.findByRole("group", { name: "Add the files in a folder" });
    expect(offer.textContent).toContain("“shots” is a folder of 1 file (10 B). Add it to the Library?");
    fireEvent.click(within(offer).getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("group", { name: "Add the files in a folder" })).toBeNull();
    expect(api.calls.filter((c) => c.startsWith("addLibraryFiles:"))).toEqual(["addLibraryFiles:p1:/Users/me/shots"]);
  });

  it("lands on what came in: a tab that would hide a new file goes back to All", async () => {
    // Making a thing lands you in it (design.md). THE mutant: the file is added under the Images tab and
    // the page goes on showing only images, so the PDF just added is nowhere to be seen.
    await mount({ artifacts: [file({ id: "old.png", ext: "png", ts: 1 })],
      pickFiles: [{ path: "/Users/me/brief.pdf", mime: "application/pdf", name: "brief.pdf", size: 1 }] });
    await screen.findByText("old.png");
    const tabs = screen.getByRole("group", { name: "Kind of file" });
    fireEvent.click(within(tabs).getByRole("button", { name: "Images" }));
    await waitFor(() => expect(within(tabs).getByRole("button", { name: "Images" })).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("brief.pdf")).toBeTruthy();
    expect(within(tabs).getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  });

  it("says nothing and adds nothing when the picker is cancelled", async () => {
    const { api, store } = await mount({ artifacts: [file({ id: "plan.md" })] });
    await screen.findByText("plan.md");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.calls).toContain("pickFiles"));
    expect(api.calls.some((c) => c.startsWith("addLibraryFiles:"))).toBe(false);
    expect(store.getState().toasts).toEqual([]);
  });
});

describe("taking a file back out of the Library", () => {
  /** A file the person added, as the index lists one: Realm's copy under the profile, in no session. */
  const added = (name: string, ts: number): LibraryEntry => ({
    id: `F-${name}`, sessionId: null, spaceId: null, kind: "added", path: `/realm-home/library/p1/${name}`, name,
    ext: name.split(".").pop()!, ts, sessionTitle: null, agentKind: null,
  });
  const ofP1 = (entries: LibraryEntry[]) => Object.fromEntries(entries.filter((e) => e.kind === "added").map((e) => [e.id, "p1"]));
  /** The page with the window's toasts under it, so a toast's Undo is pressed as a person presses it. */
  async function mountWithToasts(artifacts: LibraryEntry[], over: FakeData = {}) {
    const api = fakeApi({ artifacts, addedProfiles: ofP1(artifacts), ...over });
    const store = createAppStore(api);
    await store.getState().boot();
    render(
      <StoreContext.Provider value={store}>
        <LibraryPage item={item("i1", "s1", { kind: "library-page", refId: PAGE_REF_IDS["library-page"], title: "Library" })} visible />
        <MediaViewer />
        <Toasts />
      </StoreContext.Provider>,
    );
    return { api, store };
  }
  const names = () => [...document.querySelectorAll(".library-file .library-tile-name")].map((n) => n.textContent);
  const tileOf = (name: string) => screen.getByText(name).closest<HTMLElement>(".library-tile")!;
  const rowsOf = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((b) => b.querySelector(".menu-label")!.textContent);
  const toast = () => waitFor(() => { const t = document.querySelector<HTMLElement>(".toast"); expect(t).not.toBeNull(); return t!; });
  async function removeFromMenu(name: string) {
    fireEvent.click(screen.getByRole("button", { name: `More for ${name}` }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Remove from Library/ }));
  }

  it("ends an added file's menu — at a right-click or under its ⋯ — with Remove from Library, and a session's file's without it", async () => {
    /* THE mutants: the row offered for a session's file, which is its work and not the Library's to let
       go of, or a menu that only one of the two ways in opens. */
    await mountWithToasts([added("hero.png", 3), file({ id: "plan.md", ts: 2 })]);
    await screen.findByText("hero.png");
    fireEvent.contextMenu(tileOf("hero.png"), { clientX: 40, clientY: 50 });
    const menu = await screen.findByRole("menu", { name: "hero.png" });
    expect(rowsOf(menu)).toEqual(["Open", "Reveal in Finder", "Copy path", "Remove from Library"]);
    expect(within(menu).getByRole("menuitem", { name: /^Remove from Library/ })).toHaveAttribute("title", "Deletes Realm's own copy. The file you added it from stays where it is.");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "More for plan.md" }));
    expect(rowsOf(await screen.findByRole("menu", { name: "plan.md" }))).toEqual(["Open", "Reveal in Finder", "Copy path"]);
  });

  it("takes it out at once — nothing asked — says so with an Undo, and the Undo puts it back where it was", async () => {
    /* THE mutants: a question in front of the removal (it comes back with a click, so a confirm would
       guard nothing — design.md), a toast with no way back, or a file that comes back somewhere else. */
    const { api, store } = await mountWithToasts([added("a.md", 3), added("b.png", 2), added("c.pdf", 1)]);
    await screen.findByText("b.png");
    await removeFromMenu("b.png");
    await waitFor(() => expect(names()).toEqual(["a.md", "c.pdf"]));
    expect(api.calls).toContain("removeLibraryFiles:p1:/realm-home/library/p1/b.png");
    const said = await toast();
    expect(said).toHaveTextContent("Removed b.png from the Library.");
    fireEvent.click(within(said).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(names()).toEqual(["a.md", "b.png", "c.pdf"]));
    expect(api.calls.some((c) => c.startsWith("restoreLibraryFiles:removal:"))).toBe(true);
    // The offer taken, the toast goes with it.
    await waitFor(() => expect(store.getState().toasts).toEqual([]));
  });

  it("takes the file in focus out on Delete — or the Finder's ⌘⌫ — and hands the keyboard to the one after it", async () => {
    /* THE mutants: Delete ignored on the grid, or the focus dropped on the page with the tile, so the
       next Delete does nothing and the keyboard is lost. */
    await mountWithToasts([added("a.md", 3), added("b.md", 2), added("c.md", 1)]);
    await screen.findByText("b.md");
    tileOf("b.md").focus();
    fireEvent.keyDown(tileOf("b.md"), { key: "Backspace" });
    await waitFor(() => expect(names()).toEqual(["a.md", "c.md"]));
    await waitFor(() => expect(document.activeElement).toBe(tileOf("c.md")));
    fireEvent.keyDown(tileOf("c.md"), { key: "Backspace", metaKey: true });
    await waitFor(() => expect(names()).toEqual(["a.md"]));
    // The last one goes back to the one before it.
    await waitFor(() => expect(document.activeElement).toBe(tileOf("a.md")));
  });

  it("leaves a session's file alone on Delete, and its ⋯'s keys to the ⋯", async () => {
    const { api } = await mountWithToasts([file({ id: "plan.md", ts: 2 }), added("mine.md", 1)]);
    await screen.findByText("plan.md");
    tileOf("plan.md").focus();
    fireEvent.keyDown(tileOf("plan.md"), { key: "Backspace" });
    fireEvent.keyDown(tileOf("plan.md"), { key: "Delete" });
    fireEvent.keyDown(screen.getByRole("button", { name: "More for mine.md" }), { key: "Backspace" });
    expect(api.calls.some((c) => c.startsWith("removeLibraryFiles:"))).toBe(false);
    expect(names()).toEqual(["plan.md", "mine.md"]);
  });

  it("opens the file's menu from the keyboard, on Shift-F10 or the menu key", async () => {
    await mountWithToasts([added("hero.png", 1)]);
    await screen.findByText("hero.png");
    tileOf("hero.png").focus();
    fireEvent.keyDown(tileOf("hero.png"), { key: "F10", shiftKey: true });
    expect(rowsOf(await screen.findByRole("menu", { name: "hero.png" }))).toContain("Remove from Library");
  });

  it("is the page's empty state again once the last file is gone", async () => {
    await mountWithToasts([added("only.md", 1)]);
    await screen.findByText("only.md");
    await removeFromMenu("only.md");
    expect(await screen.findByText(/^Nothing here yet\./)).toBeTruthy();
  });

  it("takes the file off a prompter that has it as a chip, and puts the chip back where it was with the undo", async () => {
    /* A chip naming a file that is gone would fail the next send whole. THE mutants: the chip left in
       the prompter, or an undo that leaves it off — or puts it back at the end of the row. */
    const hero = added("hero.png", 1);
    const { store } = await mountWithToasts([hero]);
    await screen.findByText("hero.png");
    const chip = (path: string, name: string) => ({ path, mime: "image/png", name, size: 1 });
    act(() => { store.setState({ pendingAttachments: { se1: [chip("/tmp/a.png", "a.png"), chip(hero.path, "hero.png"), chip("/tmp/b.png", "b.png")] } }); });
    await removeFromMenu("hero.png");
    await waitFor(() => expect(store.getState().pendingAttachments["se1"]!.map((a) => a.name)).toEqual(["a.png", "b.png"]));
    const said = await toast();
    expect(said).toHaveTextContent("Removed hero.png from the Library. It's gone from the message you're writing, too.");
    fireEvent.click(within(said).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(store.getState().pendingAttachments["se1"]!.map((a) => a.name)).toEqual(["a.png", "hero.png", "b.png"]));
  });

  it("says which sent messages lose the file", async () => {
    const hero = added("hero.png", 1);
    const sent = file({ id: "se1:7:hero", kind: "upload", path: hero.path, name: "hero.png", ext: "png", ts: 2 });
    await mountWithToasts([sent, hero]);
    await screen.findAllByText("hero.png");
    // Listed twice — as attached to the message, and as added — and only the second is the Library's own.
    const [asSent, asAdded] = screen.getAllByRole("button", { name: "More for hero.png" });
    fireEvent.click(asSent!);
    expect(rowsOf(await screen.findByRole("menu", { name: "hero.png" }))).not.toContain("Remove from Library");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(asAdded!);
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Remove from Library/ }));
    expect(await toast()).toHaveTextContent("Removed hero.png from the Library. It's gone from the message it was sent with, too.");
    // The Library's listing of it as attached goes with the copy.
    await waitFor(() => expect(names()).toEqual([]));
  });

  it("moves the viewer on when the file on show is removed from it, and back to the file with the undo", async () => {
    /* THE mutants: a Remove the viewer does not offer for an added file, or a viewer left on a file
       that is no longer anywhere. */
    bridge();
    const { store } = await mountWithToasts([added("a.md", 3), added("b.md", 2), file({ id: "plan.md", ts: 1 })]);
    fireEvent.click(await screen.findByTitle("/realm-home/library/p1/a.md"));
    const dialog = await screen.findByRole("dialog", { name: "a.md" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Remove from Library/ }));
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveAttribute("aria-label", "b.md"));
    expect(store.getState().viewer!.files.map((f) => f.name)).toEqual(["b.md", "plan.md"]);
    fireEvent.click(within(await toast()).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveAttribute("aria-label", "a.md"));
    expect(store.getState().viewer!.files.map((f) => f.name)).toEqual(["a.md", "b.md", "plan.md"]);
    // A session's file in the same viewer has no such row.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveAttribute("aria-label", "plan.md"));
    fireEvent.click(await within(screen.getByRole("dialog")).findByRole("button", { name: "More actions" }));
    await screen.findByRole("menuitem", { name: "Copy path" });
    expect(screen.queryByRole("menuitem", { name: /^Remove from Library/ })).toBeNull();
  });

  it("closes the viewer when the only file it held is removed", async () => {
    bridge();
    await mountWithToasts([added("only.md", 1)]);
    fireEvent.click(await screen.findByTitle("/realm-home/library/p1/only.md"));
    const dialog = await screen.findByRole("dialog", { name: "only.md" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Remove from Library/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await toast()).toHaveTextContent("Removed only.md from the Library.");
  });

  it("draws the picture again for a file added back where a removed one was", async () => {
    /* A sent message's tile keeps showing a copy's path whatever happens to it. THE mutant: an add that
       leaves the window's picture cache alone — the tile asked while the copy was gone, holds "no
       picture", and never asks again, so the file is back and every tile of it is a glyph. */
    const realm = bridge();
    allOnScreen();
    const { store } = await mountWithToasts([added("hero.png", 1)], {
      pickFiles: [{ path: "/Users/me/Desktop/hero.png", mime: "image/png", name: "hero.png", size: 1 }] });
    await screen.findByText("hero.png");
    const { container } = render(
      <StoreContext.Provider value={store}>
        <FileCard path="/realm-home/library/p1/hero.png" name="hero.png" type="image" title="sent" onOpen={() => {}} />
      </StoreContext.Provider>,
    );
    await waitFor(() => expect(container.querySelector("img.library-tile-thumb")).not.toBeNull());
    realm.attachmentThumbnail.mockImplementation(async () => null as unknown as string);
    await removeFromMenu("hero.png");
    await waitFor(() => expect(container.querySelector("img.library-tile-thumb")).toBeNull());
    realm.attachmentThumbnail.mockImplementation(async () => "data:image/png;base64,AGAIN");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(container.querySelector("img.library-tile-thumb")?.getAttribute("src")).toBe("data:image/png;base64,AGAIN"));
  });

  it("keeps the page where it was: a file taken out of the second page leaves both pages showing", async () => {
    /* THE mutant: ask again for the first page only, as a filter change does — the list is cut back to
       sixty under someone who had scrolled past them, and their place is gone. */
    const sentinels: { cb: IntersectionObserverCallback; el: Element }[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(private cb: IntersectionObserverCallback) {}
      observe(el: Element) { sentinels.push({ cb: this.cb, el }); }
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    });
    const many = Array.from({ length: LIBRARY_PAGE_SIZE + 5 }, (_, i) => added(`f${String(i).padStart(3, "0")}.md`, 1_700_000_000_000 - i));
    await mountWithToasts(many);
    await screen.findByText("f000.md");
    act(() => { for (const s of sentinels.filter((o) => o.el.classList.contains("library-more"))) s.cb([{ isIntersecting: true, target: s.el } as IntersectionObserverEntry], {} as IntersectionObserver); });
    await screen.findByText("f064.md");
    await removeFromMenu("f062.md");
    await waitFor(() => expect(screen.queryByText("f062.md")).toBeNull());
    expect(document.querySelectorAll(".library-tile")).toHaveLength(LIBRARY_PAGE_SIZE + 4);
    expect(screen.getByText("f064.md")).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
