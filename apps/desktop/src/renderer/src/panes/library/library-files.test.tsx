import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LIBRARY_PAGE_SIZE, PAGE_REF_IDS, type LibraryEntry } from "@realm/contracts";
import { LibraryPage } from "./LibraryPage";
import { groupByDay } from "./LibraryFiles";
import { createAppStore, StoreContext } from "../../state/store";
import { fakeApi, item, type FakeData } from "../../state/store.test-fakes";

afterEach(() => cleanup());

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
    // reader trying to remember where something came from.
    expect(screen.getByText("Made in The parser rewrite")).toBeTruthy();
    expect(screen.getByText("Uploaded to Design review")).toBeTruthy();
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

  it("opens a file the documents pane can render, and does not pretend to open one it cannot", async () => {
    const { api } = await mount({ artifacts: [
      file({ id: "report.md" }),
      file({ id: "archive.zip", ext: "zip", path: "/tmp/archive.zip" }),
    ] });
    const zip = await screen.findByTitle("/tmp/archive.zip");
    fireEvent.click(zip);
    expect(api.calls.some((c) => c.startsWith("openDocumentPath"))).toBe(false);
    fireEvent.click(screen.getByTitle("/tmp/report.md"));
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("openDocumentPath"))).toBe(true));
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
