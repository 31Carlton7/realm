import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LIBRARY_PAGE_SIZE, PAGE_REF_IDS, type LibraryEntry } from "@realm/contracts";
import { LibraryPage } from "./LibraryPage";
import { groupByDay } from "./LibraryFiles";
import { createAppStore, StoreContext } from "../../state/store";
import { resetThumbnailCache } from "../../components/use-thumbnail";
import { resetMediaCache } from "../session/media/use-media";
import { fakeApi, item, session, type FakeData } from "../../state/store.test-fakes";

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

  it("narrows by scope and by kind, and asks the SERVER to do it", async () => {
    /* The mutant: filter the loaded page in the renderer. That answers correctly only for the rows
       already fetched, so a filter over a paged list would quietly show a page's worth of matches
       and call it the whole answer. */
    const { api } = await mount({ artifacts: [
      file({ id: "report.md" }),
      file({ id: "shot.png", kind: "upload" }),
    ] });
    await screen.findByText("report.md");
    fireEvent.click(screen.getByRole("button", { name: "Uploaded" }));
    await waitFor(() => expect(api.calls.some((c) => c.includes(":upload:"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "This space" }));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("libraryArtifacts:s1:"))).toBe(true));
  });

  it("asks main for a picture only where the picture IS the file", async () => {
    /* The mutant: drop the type gate and thumbnail every tile. Correct on screen, and it puts one
       `qlmanage` child process behind every card — sixty per page of this grid — for marks nobody
       looks at. The gate is the whole reason the grid stays cheap to scroll. */
    const realm = bridge();
    await mount({ artifacts: [
      file({ id: "shot.png", ext: "png", path: "/tmp/shot.png" }),
      file({ id: "theme.css", ext: "css", path: "/tmp/theme.css" }),
    ] });
    await screen.findByText("shot.png");
    await waitFor(() => expect(realm.attachmentThumbnail).toHaveBeenCalledWith("/tmp/shot.png"));
    expect(realm.attachmentThumbnail.mock.calls.map((c) => c[0])).not.toContain("/tmp/theme.css");
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
