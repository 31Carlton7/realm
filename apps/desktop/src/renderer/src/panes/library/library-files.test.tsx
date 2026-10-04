import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LIBRARY_PAGE_SIZE, PAGE_REF_IDS, type LibraryEntry } from "@realm/contracts";
import { LibraryPage } from "./LibraryPage";
import { groupByDay } from "./LibraryFiles";
import { createAppStore, StoreContext } from "../../state/store";
import { resetThumbnailCache } from "../../components/use-thumbnail";
import { breakableName } from "../../components/FileCard";
import { allOnScreen } from "../../components/on-screen.test-fakes";
import { resetMediaCache } from "../session/media/use-media";
import { fakeApi, item, session, space, type FakeData } from "../../state/store.test-fakes";

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
    // "Made" and "uploaded" are the same file to the filesystem and very different facts to a
    // reader trying to remember where something came from. The sentence is the accessible name; the
    // glyph beside the title is how it reads on screen.
    expect(screen.getByText("Made in The parser rewrite")).toBeTruthy();
    expect(screen.getByText("Uploaded to Design review")).toBeTruthy();
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
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Uploaded by you" }));
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
    fireEvent.click(screen.getByRole("button", { name: /Uploaded by you/ }));
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
  /** Open the card for `path` and wait for the preview's own stat to land. */
  async function openCard(path: string) {
    fireEvent.click(await screen.findByTitle(path));
    return screen.findByRole("dialog");
  }

  it("opens a preview for EVERY file, not only the ones the documents pane can render", async () => {
    /* The mutant: keep the old `if (isOpenableArtifact) openDocumentPath` on the card. It leaves the
       archive — and every binary, image and unknown type in a real home — as a box that takes a
       click and does nothing, with nothing on screen to say why. */
    bridge();
    await mount({ artifacts: [file({ id: "archive.zip", ext: "zip", path: "/tmp/archive.zip" })] });
    fireEvent.click(await screen.findByTitle("/tmp/archive.zip"));
    expect(await screen.findByRole("dialog", { name: "archive.zip" })).toBeTruthy();
  });

  it("routes the preview's Open the same way a session summary does, and no other way", async () => {
    /* The one rule this preview exists to keep: a file must not open two different ways depending on
       which list it was reached from. `isOpenableArtifact` IS the summary's `documentKindFor(path)
       !== "unsupported"`, so a `.md` goes to the documents pane and a `.zip` goes to the OS. */
    const realm = bridge();
    const { api } = await mount({ artifacts: [
      file({ id: "report.md", path: "/tmp/report.md" }),
      file({ id: "archive.zip", ext: "zip", path: "/tmp/archive.zip" }),
    ] });
    await openCard("/tmp/report.md");
    fireEvent.click(await screen.findByRole("button", { name: "Open in the documents pane" }));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("openDocumentPath"))).toBe(true));

    await openCard("/tmp/archive.zip");
    fireEvent.click(await screen.findByRole("button", { name: "Open with the default app" }));
    await waitFor(() => expect(realm.openAttachment).toHaveBeenCalledWith("/tmp/archive.zip"));
  });

  it("wears Finder's own icon on Reveal in Finder, and falls back rather than waiting on it", async () => {
    /* The mark is Apple's, so it is read off THIS machine at runtime rather than shipped with the
       app. A machine that cannot produce it (or has not yet) still gets a usable menu — the item
       draws Realm's folder glyph instead of holding the menu back for a picture. */
    bridge();
    await mount({ artifacts: [file({ id: "report.md", path: "/tmp/report.md" })] });
    await openCard("/tmp/report.md");
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    const item = await screen.findByRole("menuitem", { name: "Reveal in Finder" });
    await waitFor(() => expect(item.querySelector("img.menu-icon-img")).not.toBeNull());

    // THE MUTANT: draw the slot only on the item that has an icon. Every other label then starts
    // 24px to its left and the menu reads as broken rather than as emphasised.
    const copyPath = screen.getByRole("menuitem", { name: "Copy path" });
    expect(copyPath.querySelector(".menu-icon")).not.toBeNull();
  });

  it("saves a copy, reveals and copies the path through the bridge that can do all three", async () => {
    /* The mutant: reach for `media.reveal`. That gate admits only what a media element can decode,
       so revealing a `.md` would silently do nothing — which is exactly what the transcript's path
       menu and the empty diff pane were doing before `files.reveal` existed. */
    const realm = bridge();
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mount({ artifacts: [file({ id: "report.md", path: "/tmp/report.md" })] });
    await openCard("/tmp/report.md");

    for (const label of ["Save a copy…", "Reveal in Finder", "Copy path"]) {
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: label }));
    }
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
    const sheet = await openCard("/tmp/far.md");
    fireEvent.click(within(sheet).getByRole("button", { name: "Made in The other space" }));
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
    const sheet = await openCard("/tmp/orphan.md");
    expect(await within(sheet).findByText(/that session is gone/)).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: /Made in A session since deleted/ })).toBeNull();
  });

  it("expands into the transcript's own lightbox, and Escape comes back to the preview", async () => {
    /* Two things at once. The lightbox is the transcript's — a second image viewer here would be a
       fork of the one component this whole preview exists to reuse. And it REPLACES the sheet rather
       than stacking on it: both listen for Escape on `window` in the capture phase and the sheet is
       mounted first, so drawing them together made one press close both and turned "expand" into a
       one-way trip out of the preview. */
    bridge({ media: { stat: async (c: readonly string[]) => c.map((path) => ({ path, mime: "image/png", kind: "image", size: 4096 })),
                      poster: async () => null, reveal: vi.fn(), open: vi.fn() } });
    await mount({ artifacts: [file({ id: "shot.png", ext: "png", path: "/tmp/shot.png", kind: "upload" })] });
    await openCard("/tmp/shot.png");
    fireEvent.click(await screen.findByRole("button", { name: "Expand" }));

    await waitFor(() => expect(document.querySelector(".media-lightbox")).toBeTruthy());
    expect(document.querySelector(".sheet")).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".media-lightbox")).toBeNull());
    expect(await screen.findByRole("dialog", { name: "shot.png" })).toBeTruthy();
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
