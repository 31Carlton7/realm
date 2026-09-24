import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { sessionEvent } from "@realm/contracts";
import { createAppStore, StoreContext } from "../../state/store";
import { fakeApi, item } from "../../state/store.test-fakes";
import { SessionPanelActions } from "./SessionPane";
import { crumbsOf, fileSize, type BrowseRow } from "./SessionFiles";
import { reduceAll } from "./transcript-model";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const HOUR = 3_600_000;
const row = (name: string, over: Partial<BrowseRow> = {}): BrowseRow =>
  ({ path: name, name, isDir: false, size: 1024, mtimeMs: Date.now(), ...over });

/** The bridge, standing in for main's directory read. Records what it was asked for, so a test can
 *  assert WHICH folder the panel looked in — the panel's whole job is being pointed at the right one. */
function bridge(folders: Record<string, BrowseRow[]>) {
  const asked: { root: string; dir: string }[] = [];
  vi.stubGlobal("realm", {
    files: {
      reveal: vi.fn(),
      browse: async (root: string, dir: string) => {
        asked.push({ root, dir });
        return { dir, entries: folders[dir] ?? [], truncated: false };
      },
    },
  });
  return asked;
}

async function mount(folders: Record<string, BrowseRow[]>, opts: { workspace?: boolean } = {}) {
  const asked = bridge(folders);
  const api = fakeApi();
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
  return { store, asked, ...view };
}

const open = () => fireEvent.click(screen.getByRole("button", { name: "Files for A session" }));
const rowNames = () => [...document.querySelectorAll(".summary-row-name")].map((n) => n.textContent);

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

  it("says where it looked when there is nothing there", async () => {
    // Half the time the answer to "where did my file go" is that it went somewhere else, and an
    // empty panel that does not name the folder it read cannot say so.
    await mount({ "": [] });
    open();
    await waitFor(() => expect(screen.getByText(/Nothing in/)).toBeInTheDocument());
  });
});

describe("the browser's own arithmetic", () => {
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
