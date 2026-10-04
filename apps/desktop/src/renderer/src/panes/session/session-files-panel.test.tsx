import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { sessionEvent } from "@realm/contracts";
import { createAppStore, SETTING_FILES_VIEW, StoreContext } from "../../state/store";
import { fakeApi, item } from "../../state/store.test-fakes";
import { resetThumbnailCache } from "../../components/use-thumbnail";
import { allOnScreen } from "../../components/on-screen.test-fakes";
import { resetMediaCache } from "./media/use-media";
import { SessionPanelActions } from "./SessionPane";
import { crumbsOf, fileSize, typeOf, type BrowseRow } from "./SessionFiles";
import { reduceAll } from "./transcript-model";

beforeEach(() => { resetThumbnailCache(); resetMediaCache(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const HOUR = 3_600_000;
const row = (name: string, over: Partial<BrowseRow> = {}): BrowseRow =>
  ({ path: name, name, isDir: false, size: 1024, mtimeMs: Date.now(), ...over });

/** The bridge, standing in for main's directory read. Records what it was asked for, so a test can
 *  assert WHICH folder the panel looked in — the panel's whole job is being pointed at the right one.
 *  It also mints a picture for anything a card asks about, and calls every file a picture when the
 *  lightbox asks — which of them get ASKED is what the cases below are about. */
function bridge(folders: Record<string, BrowseRow[]>) {
  const asked: { root: string; dir: string }[] = [];
  const attachmentThumbnail = vi.fn(async (_path: string, _size?: string) => "data:image/png;base64,AAAA");
  vi.stubGlobal("realm", {
    files: {
      reveal: vi.fn(),
      browse: async (root: string, dir: string) => {
        asked.push({ root, dir });
        return { dir, entries: folders[dir] ?? [], truncated: false };
      },
    },
    attachmentThumbnail,
    media: { stat: async (c: readonly string[]) => c.map((path) => ({ path, mime: "image/png", kind: "image", size: 4096 })),
             poster: async () => null, reveal: vi.fn(), open: vi.fn() },
  });
  return { asked, attachmentThumbnail };
}

/** `settings` is the home's settings table, shared by reference: hand the same object to a second
 *  mount and it boots from what the first one wrote, which is what a relaunch is. */
async function mount(folders: Record<string, BrowseRow[]>, opts: { workspace?: boolean; settings?: Record<string, unknown> } = {}) {
  const { asked, attachmentThumbnail } = bridge(folders);
  const api = fakeApi({ settings: opts.settings });
  const store = createAppStore(api);
  await store.getState().boot();
  const spaceId = store.getState().spaces[0]!.id;
  store.setState({
    transcripts: { se1: { lastSeq: 0, t: reduceAll([sessionEvent("user_message", { text: "hi", attachments: [] })]) } },
    sessions: { ...store.getState().sessions, se1: { ...(store.getState().sessions.se1 ?? {}), id: "se1", environmentId: opts.workspace ? "env1" : null } as never },
    environments: opts.workspace ? { env1: { id: "env1", spaceId, path: "/checkout", branch: null, kind: "primary", portBlockStart: null, createdAt: 0, updatedAt: 0 } } : {},
  });
  const view = render(
    <StoreContext.Provider value={store}>
      <SessionPanelActions item={item("i9", spaceId, { kind: "session", refId: "se1", title: "A session" })} keep={Number.POSITIVE_INFINITY} />
    </StoreContext.Provider>,
  );
  return { store, api, asked, attachmentThumbnail, ...view };
}

const open = () => fireEvent.click(screen.getByRole("button", { name: "Files for A session" }));
const rowNames = () => [...document.querySelectorAll(".summary-row-name")].map((n) => n.textContent);
const cards = () => [...document.querySelectorAll<HTMLElement>(".session-files .library-tile")];
const cardNames = () => cards().map((c) => c.querySelector(".library-tile-name")?.textContent);
const gridSwitch = () => screen.getByRole("button", { name: "Show as a grid" });

describe("the session file browser", () => {
  it("is offered for every session, unlike the summary", async () => {
    /* The summary hides itself until the transcript has something in it. This one cannot: the case
       it exists for is a file that never appears in a transcript at all — written by a script, zipped
       by a shell line — so a button gated on the transcript would be missing exactly when it matters. */
    await mount({});
    expect(screen.getByRole("button", { name: "Files for A session" })).toBeInTheDocument();
  });

  it("lists what is on disk, newest first, grouped by day", async () => {
    /* Pinned to the middle of a day, because the offsets below are hours and the buckets are DAYS.
       Run at 00:43 and the file stamped an hour ago is genuinely yesterday, so this failed every
       night between midnight and 03:00 — a test that is wrong about the clock rather than about the
       panel, and the kind that teaches people to re-run a red suite instead of reading it. */
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-03-12T12:00:00"));
    const now = Date.now();
    await mount({
      "": [
        row("handwriting-starter.zip", { mtimeMs: now - HOUR }),
        row("blank-handwriting-sheet.pdf", { mtimeMs: now - 3 * HOUR }),
        row("old-notes.md", { mtimeMs: now - 50 * HOUR }),
      ],
    });
    open();
    await waitFor(() => expect(rowNames()).toEqual(["handwriting-starter.zip", "blank-handwriting-sheet.pdf", "old-notes.md"]));
    // The Library's own day vocabulary, because "Today" has to mean one thing in this app.
    const heads = [...document.querySelectorAll(".summary-head")].map((h) => h.textContent);
    expect(heads[0]).toContain("Today");
    expect(heads.at(-1)).toMatch(/Yesterday|day/i);
  });

  it("reads the SPACE's folder, which is where a generated file lands", async () => {
    const { asked, store } = await mount({ "": [row("out.pdf")] });
    open();
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    expect(asked[0]!.root).toBe(store.getState().spaces[0]!.folderPath);
    expect(asked[0]!.dir).toBe("");
  });

  it("offers the checkout as a second root when the session has one", async () => {
    await mount({ "": [row("out.pdf")] }, { workspace: true });
    open();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Workspace" })).toBeInTheDocument());
    expect(screen.getByRole("radio", { name: "Space" })).toBeInTheDocument();
  });

  it("…and no such control when there is only one folder to show", async () => {
    // Two names for one directory is a control that does nothing but ask what the difference is.
    const { asked } = await mount({ "": [row("out.pdf")] });
    open();
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("descends into a folder and walks back out by its crumbs", async () => {
    const { asked } = await mount({
      "": [row("sheet", { isDir: true, size: 0 })],
      sheet: [row("sheet/blank.pdf", { name: "blank.pdf" })],
    });
    open();
    await waitFor(() => expect(rowNames()).toEqual(["sheet"]));
    fireEvent.click(screen.getByRole("button", { name: /sheet/ }));
    await waitFor(() => expect(rowNames()).toEqual(["blank.pdf"]));
    expect(asked.at(-1)!.dir).toBe("sheet");

    /* The crumbs: the root is a button, and the folder you are IN is not — it is where you are, which
       is a statement rather than a place to go. */
    const crumbs = [...document.querySelectorAll<HTMLElement>(".files-crumb")];
    expect(crumbs.map((c) => c.tagName)).toEqual(["BUTTON", "SPAN"]);
    fireEvent.click(crumbs[0]!);
    await waitFor(() => expect(asked.at(-1)!.dir).toBe(""));
  });

  it("opens a file the way the summary would — the documents pane, or the sheet for what it cannot edit", async () => {
    /* One file, one door. A `.md` reached from here and the same `.md` reached from the summary must
       not open two different ways, so both go through the same three answers. */
    const { store } = await mount({ "": [row("notes.md"), row("bundle.zip")] });
    open();
    await waitFor(() => expect(rowNames()).toContain("bundle.zip"));
    fireEvent.click(screen.getByRole("button", { name: /bundle\.zip/ }));
    await waitFor(() => expect(store.getState().sheet).toMatchObject({ kind: "artifact" }));
    expect((store.getState().sheet as { path: string }).path).toContain("bundle.zip");
  });

  it("opens a picture in the transcript's lightbox, over the panel rather than instead of it", async () => {
    /* The third of the summary's three answers, and the one nothing exercised: a zip is `other`
       whichever way its type is read, so the case above passed while every screenshot went to the
       sheet. THE MUTANT: hand `artifactTypeOf` the whole name again. */
    const { store } = await mount({ "": [row("shot.png")] });
    open();
    await waitFor(() => expect(rowNames()).toEqual(["shot.png"]));
    fireEvent.click(screen.getByRole("button", { name: /shot\.png/ }));
    await waitFor(() => expect(document.querySelector(".media-lightbox")).not.toBeNull());
    expect(store.getState().sheet).toBeNull();
    expect(document.querySelector(".session-files")).not.toBeNull();
  });

  it("says where it looked when there is nothing there", async () => {
    // Half the time the answer to "where did my file go" is that it went somewhere else, and an
    // empty panel that does not name the folder it read cannot say so.
    await mount({ "": [] });
    open();
    await waitFor(() => expect(screen.getByText(/Nothing in/)).toBeInTheDocument());
  });
});

describe("the session file browser, laid out as cards", () => {
  it("switches from the panel's head, names itself the same way in both states, and survives a relaunch", async () => {
    /* One switch, and its state is `aria-pressed` alone: design.md's rule is that a toggle names its
       state OR carries the flag, never both, so the NAME has to hold still while the flag moves.
       Then the relaunch — the same settings table booted by a second store, which is all a
       relaunch is to the renderer. THE MUTANTS: drop the `setSetting` (the layout reverts to rows
       on every launch), read the row back as anything but "grid" at boot, or flip the name. */
    const settings: Record<string, unknown> = {};
    const folders = { "": [row("notes.md"), row("bundle.zip")] };
    await mount(folders, { settings });
    open();
    await waitFor(() => expect(rowNames()).toEqual(["notes.md", "bundle.zip"]));
    expect(cards()).toEqual([]);
    expect(gridSwitch()).toHaveAttribute("aria-pressed", "false");
    expect(gridSwitch()).toHaveAttribute("title");

    fireEvent.click(gridSwitch());
    await waitFor(() => expect(cardNames()).toEqual(["notes.md", "bundle.zip"]));
    expect(rowNames()).toEqual([]);
    expect(gridSwitch()).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(settings[SETTING_FILES_VIEW]).toBe("grid"));

    cleanup();
    await mount(folders, { settings });
    open();
    await waitFor(() => expect(cardNames()).toEqual(["notes.md", "bundle.zip"]));
    expect(gridSwitch()).toHaveAttribute("aria-pressed", "true");

    // …and back, which is remembered the same way.
    fireEvent.click(gridSwitch());
    await waitFor(() => expect(rowNames()).toEqual(["notes.md", "bundle.zip"]));
    await waitFor(() => expect(settings[SETTING_FILES_VIEW]).toBe("list"));
  });

  it("keeps the day grouping, and each card says what its row said: a size, or that it is a folder", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-03-12T12:00:00"));
    const now = Date.now();
    await mount({ "": [
      row("handwriting-starter.zip", { size: 48 * 1024, mtimeMs: now - HOUR }),
      row("sheet", { isDir: true, size: 0, mtimeMs: now - 2 * HOUR }),
      row("old-notes.md", { mtimeMs: now - 50 * HOUR }),
    ] }, { settings: { [SETTING_FILES_VIEW]: "grid" } });
    open();
    await waitFor(() => expect(cardNames()).toEqual(["handwriting-starter.zip", "sheet", "old-notes.md"]));
    const heads = [...document.querySelectorAll(".summary-head")].map((h) => h.textContent);
    expect(heads).toHaveLength(2);
    expect(heads[0]).toContain("Today");
    // THE MUTANT: a folder's card showing its `size`, which is 0 by construction ("0 B").
    expect(cards().map((c) => c.querySelector(".library-tile-meta")?.textContent)).toEqual(["48 KB", "Folder", "1 KB"]);
    const folder = cards()[1]!;
    expect(folder.querySelector(".library-tile-mark[data-type='folder']")).not.toBeNull();
  });

  it("pictures only the files whose picture IS the file, at card size, from the path on disk", async () => {
    /* The Library's rule on the Library's card: an image asks main for a picture at CARD size, and
       a document or a folder keeps its glyph, small in the well. THE MUTANTS: hand `artifactTypeOf`
       the whole name again (every card is then `other` and nothing is pictured), or hand the card
       the ROW's path — relative to the root, so main is asked about a file that is not there. */
    const { attachmentThumbnail, store } = await mount({ "": [
      row("shot.png"), row("notes.md"), row("sheet", { isDir: true, size: 0 }),
    ] }, { settings: { [SETTING_FILES_VIEW]: "grid" } });
    allOnScreen();
    open();
    await waitFor(() => expect(cardNames()).toEqual(["shot.png", "notes.md", "sheet"]));
    const folderPath = store.getState().spaces[0]!.folderPath;
    await waitFor(() => expect(attachmentThumbnail).toHaveBeenCalledWith(`${folderPath}/shot.png`, "card"));
    expect(attachmentThumbnail).toHaveBeenCalledTimes(1);
    const [shot, notes, sheet] = cards();
    await waitFor(() => expect(shot!.querySelector(":scope > img.library-tile-thumb")).not.toBeNull());
    expect(shot).toHaveAttribute("data-thumb");
    expect(notes).not.toHaveAttribute("data-thumb");
    expect(notes!.querySelector(".library-tile-art .library-tile-mark[data-type='document']")).not.toBeNull();
    expect(sheet!.querySelector(".library-tile-art .library-tile-mark[data-type='folder']")).not.toBeNull();
  });

  it("descends into a folder from its card, and walks back out by the crumbs", async () => {
    const { asked } = await mount({
      "": [row("sheet", { isDir: true, size: 0 })],
      sheet: [row("sheet/blank.pdf", { name: "blank.pdf" })],
    }, { settings: { [SETTING_FILES_VIEW]: "grid" } });
    open();
    await waitFor(() => expect(cardNames()).toEqual(["sheet"]));
    fireEvent.click(cards()[0]!);
    await waitFor(() => expect(cardNames()).toEqual(["blank.pdf"]));
    expect(asked.at(-1)!.dir).toBe("sheet");
    fireEvent.click(document.querySelector<HTMLElement>("button.files-crumb")!);
    await waitFor(() => expect(cardNames()).toEqual(["sheet"]));
    expect(asked.at(-1)!.dir).toBe("");
  });

  for (const view of ["list", "grid"] as const) {
    it(`opens each kind of file the one way the panel opens it — ${view}`, async () => {
      /* The layout must not decide where a file goes: a card and a row reach the same `openRow`.
         Three kinds, three doors — the documents pane for what it can edit, the sheet for what it
         cannot, and the transcript's lightbox for a picture, which (like the summary's) leaves the
         panel open behind it. THE MUTANTS: give the card the Library's own door (a preview sheet for
         everything), or read the type off the whole name, which sent a screenshot to the sheet. */
      const { store, api } = await mount({ "": [row("notes.md"), row("bundle.zip"), row("shot.png")] },
        { settings: { [SETTING_FILES_VIEW]: view } });
      const names = () => (view === "grid" ? cardNames() : rowNames());
      const opener = (name: string) => (view === "grid"
        ? cards().find((c) => c.querySelector(".library-tile-name")?.textContent === name)!
        : screen.getByRole("button", { name: new RegExp(name.replace(".", "\\.")) }));
      // The pane bar's Files button TOGGLES, so it is pressed only when the panel is not already up.
      const ensureOpen = async () => {
        if (!document.querySelector(".session-files")) open();
        await waitFor(() => expect(names()).toEqual(["notes.md", "bundle.zip", "shot.png"]));
      };
      await ensureOpen();

      fireEvent.click(opener("shot.png"));
      await waitFor(() => expect(document.querySelector(".media-lightbox")).not.toBeNull());
      expect(store.getState().sheet).toBeNull();
      expect(document.querySelector(".session-files"), "the picture opens over the panel, not instead of it").not.toBeNull();
      // Where the key really lands: the lightbox takes focus when it opens.
      fireEvent.keyDown(document.querySelector(".media-lightbox")!, { key: "Escape" });
      await waitFor(() => expect(document.querySelector(".media-lightbox")).toBeNull());

      await ensureOpen();
      fireEvent.click(opener("bundle.zip"));
      await waitFor(() => expect(store.getState().sheet).toMatchObject({ kind: "artifact" }));
      expect((store.getState().sheet as { path: string }).path).toMatch(/\/bundle\.zip$/);

      store.getState().closeSheet();
      await ensureOpen();
      fireEvent.click(opener("notes.md"));
      await waitFor(() => expect(api.calls.some((c) => c.startsWith("openDocumentPath:") && c.endsWith("/notes.md"))).toBe(true));
      expect(store.getState().sheet).toBeNull();
    });
  }
});

describe("the browser's own arithmetic", () => {
  it("reads a file's type off its extension, not off its whole name", () => {
    // THE MUTANT: `artifactTypeOf(name)`. The table is keyed by extension, so every name missed it.
    expect(typeOf("shot.png")).toBe("image");
    expect(typeOf("Screen Recording.MOV")).toBe("video");
    expect(typeOf("notes.md")).toBe("document");
    expect(typeOf("Makefile")).toBe("other");
  });

  it("says sizes the way a person does", () => {
    expect(fileSize(400)).toBe("400 B");
    expect(fileSize(48 * 1024)).toBe("48 KB");
    expect(fileSize(3.25 * 1024 * 1024)).toBe("3.3 MB");
    expect(fileSize(2 * 1024 ** 3)).toBe("2.0 GB");
  });

  it("builds a trail that can be walked back", () => {
    expect(crumbsOf("space", "")).toEqual([{ label: "space", dir: "" }]);
    expect(crumbsOf("space", "sheet/out")).toEqual([
      { label: "space", dir: "" }, { label: "sheet", dir: "sheet" }, { label: "out", dir: "sheet/out" },
    ]);
  });
});
