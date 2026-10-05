import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FILES_OPEN_IN_KEY, sessionEvent, type InstalledEditor } from "@realm/contracts";
import { PathMenu } from "./PathMenu";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session, type FakeData } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";
import { reduceAll } from "./transcript-model";

/**
 * Reveal in Finder from a path in the transcript, end to end through the pane: the path goes to main
 * as the agent wrote it, with the session's working directory beside it, and a reveal that found
 * nothing says so.
 */

const CWD = "/Users/me/Realm/school";
const ITEMS = { s1: [item("i1", "s1", { kind: "session", title: "Cheatsheet", refId: "se1" })] };

async function mount(text: string, reveal: (path: string, base?: string) => Promise<boolean>, more: FakeData = {}) {
  vi.stubGlobal("window", Object.assign(window, { realm: { ...window.realm, files: { reveal: vi.fn(reveal) } } }));
  const api = fakeApi({ items: ITEMS, sessions: [session("se1", "s1", { title: "Cheatsheet", cwd: CWD })], ...more });
  const store = createAppStore(api); await store.getState().boot();
  store.setState({ transcripts: { se1: { lastSeq: 1, t: reduceAll([
    sessionEvent("assistant_text", { messageId: "m1", text }),
  ]) } } });
  await store.getState().openItem("i1");
  render(<StoreContext.Provider value={store}><SessionPane item={ITEMS.s1[0]!} visible /></StoreContext.Provider>);
  return { api, store, reveal: window.realm.files!.reveal as ReturnType<typeof vi.fn> };
}

const revealFrom = async (path: string) => {
  fireEvent.click(await waitFor(() => {
    const el = document.querySelector<HTMLElement>(`.md-path[data-path="${path}"]`);
    if (!el) throw new Error(`no path mark for ${path}`);
    return el;
  }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Reveal in Finder" }));
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Reveal in Finder on a path an agent wrote", () => {
  it("sends the path as written, with the session's working directory to resolve it against", async () => {
    // THE MUTANT: leave the directory behind. A relative path then has nothing to be relative to,
    // and main refuses it — the button does nothing, which is what it did for `~/…` before this.
    const { reveal } = await mount("Files are in `~/Realm/school/imported/m425a-cheatsheet/`.", async () => true);
    await revealFrom("~/Realm/school/imported/m425a-cheatsheet/");
    await waitFor(() => expect(reveal).toHaveBeenCalledWith("~/Realm/school/imported/m425a-cheatsheet/", CWD));
  });

  it("says so when nothing is there, instead of doing nothing", async () => {
    // THE MUTANT: ignore the answer. A path the agent named and has since moved reads as a dead button.
    const { store } = await mount("I wrote `out/fit.py`.", async () => false);
    await revealFrom("out/fit.py");
    await waitFor(() => expect(store.getState().toasts.at(-1)?.text).toBe("Nothing is at out/fit.py. It may have been moved or deleted."));
  });

  it("raises nothing when the reveal found it", async () => {
    const { store, reveal } = await mount("I wrote `out/fit.py`.", async () => true);
    await revealFrom("out/fit.py");
    await waitFor(() => expect(reveal).toHaveBeenCalled());
    expect(store.getState().toasts).toEqual([]);
  });

  it("opens a path in the editor the way Reveal finds it — against the session's directory", async () => {
    // THE MUTANT: drop the directory on the way to the editor. Main refuses a relative path with
    // nothing to resolve it against, so "Open in Cursor" on `out/fit.py` did nothing at all.
    const { api } = await mount("I wrote `out/fit.py`.", async () => true, { editors: [{ id: "cursor", name: "Cursor" }] });
    fireEvent.click(await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.md-path[data-path="out/fit.py"]');
      if (!el) throw new Error("no path mark for out/fit.py");
      return el;
    }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open in Cursor" }));
    await waitFor(() => expect(api.calls).toContain(`openInEditor:cursor:out/fit.py@${CWD}`));
  });
});

const CURSOR: InstalledEditor = { id: "cursor", name: "Cursor" };
const ZED: InstalledEditor = { id: "zed", name: "Zed" };

async function menu(path: string, overrides: FakeData = {}) {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  const anchor = document.createElement("span");
  document.body.appendChild(anchor);
  render(<StoreContext.Provider value={store}>
    <PathMenu path={path} anchorRef={{ current: anchor }} environmentId={null} cwd={null} onClose={() => {}} />
  </StoreContext.Provider>);
  return { api, store };
}

const items = () => screen.getAllByRole("menuitem").map((b) => b.textContent);

describe("the path menu's editor", () => {
  it("offers the first installed editor until someone chooses, and opens the path in it", async () => {
    const { api } = await menu("/repo/src/app.ts", { editors: [CURSOR, ZED] });
    expect(items()).toEqual(["Open app.ts", "Open in Cursor", "Reveal in Finder", "Copy path"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in Cursor" }));
    // THE label-only mutant: draw the item and send the path nowhere.
    await waitFor(() => expect(api.calls).toContain("openInEditor:cursor:/repo/src/app.ts"));
  });

  it("offers the editor the setting names, and none at all once it says Realm", async () => {
    await menu("/repo/src/app.ts", { editors: [CURSOR, ZED], settings: { [FILES_OPEN_IN_KEY]: "zed" } });
    expect(items()).toContain("Open in Zed");
    expect(items()).not.toContain("Open in Cursor");
  });

  it("offers nothing for an editor that is not installed — not the next one along", async () => {
    // The user chose Zed, not "any editor". THE fall-through mutant: offer Cursor instead.
    await menu("/repo/src/app.ts", { editors: [CURSOR], settings: { [FILES_OPEN_IN_KEY]: "zed" } });
    expect(items().some((t) => t?.startsWith("Open in"))).toBe(false);
  });

  it("opens a folder in the editor too, which is what an editor makes a workspace of", async () => {
    await menu("/repo/src/", { editors: [CURSOR] });
    expect(items()).toEqual(["Open in Cursor", "Reveal in Finder", "Copy path"]);
  });

  it("Realm hides the editor item even on a Mac that has one", async () => {
    await menu("/repo/src/app.ts", { editors: [CURSOR], settings: { [FILES_OPEN_IN_KEY]: "realm" } });
    expect(items()).toEqual(["Open app.ts", "Reveal in Finder", "Copy path"]);
  });
});
