import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { sessionEvent } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";
import { reduceAll } from "./transcript-model";

/**
 * Reveal in Finder from a path in the transcript, end to end through the pane: the path goes to main
 * as the agent wrote it, with the session's working directory beside it, and a reveal that found
 * nothing says so.
 */

const CWD = "/Users/me/Realm/school";
const ITEMS = { s1: [item("i1", "s1", { kind: "session", title: "Cheatsheet", refId: "se1" })] };

async function mount(text: string, reveal: (path: string, base?: string) => Promise<boolean>) {
  vi.stubGlobal("window", Object.assign(window, { realm: { ...window.realm, files: { reveal: vi.fn(reveal) } } }));
  const api = fakeApi({ items: ITEMS, sessions: [session("se1", "s1", { title: "Cheatsheet", cwd: CWD })] });
  const store = createAppStore(api); await store.getState().boot();
  store.setState({ transcripts: { se1: { lastSeq: 1, t: reduceAll([
    sessionEvent("assistant_text", { messageId: "m1", text }),
  ]) } } });
  await store.getState().openItem("i1");
  render(<StoreContext.Provider value={store}><SessionPane item={ITEMS.s1[0]!} visible /></StoreContext.Provider>);
  return { store, reveal: window.realm.files!.reveal as ReturnType<typeof vi.fn> };
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
    await waitFor(() => expect(store.getState().error).toBe("Nothing is at out/fit.py. It may have been moved or deleted."));
  });

  it("raises nothing when the reveal found it", async () => {
    const { store, reveal } = await mount("I wrote `out/fit.py`.", async () => true);
    await revealFrom("out/fit.py");
    await waitFor(() => expect(reveal).toHaveBeenCalled());
    expect(store.getState().error).toBeNull();
  });
});
