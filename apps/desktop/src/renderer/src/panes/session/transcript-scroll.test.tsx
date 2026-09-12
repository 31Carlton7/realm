import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { sessionEvent } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";
import { reduceAll } from "./transcript-model";
import { SETTLE_MS } from "../scroll-memory";

/**
 * jsdom lays nothing out, so `scrollHeight` and `clientHeight` are 0 on every element and the
 * near-bottom test (`scrollHeight - scrollTop - clientHeight < 80`) is true everywhere: without
 * this, every scroller looks pinned to the bottom already and "the reader had scrolled up" is a
 * state no test could be in. Stage a geometry on `.transcript`, including a `scrollTop` that
 * actually stores what is written to it — jsdom's own is a permanent 0.
 */
function stageTranscript({ height, view, clamp = false }: { height: number; view: number;
  /** Refuse an offset the content cannot reach, the way a browser does. Off by default: the
   *  stick-to-bottom tests below read "the bottom" as `scrollHeight`, and clamping would move that
   *  goalpost for every one of them without telling anyone anything new. On for the one test that
   *  is ABOUT the clamp — a restore into a column whose media has not landed yet. */
  clamp?: boolean }) {
  let top = height;
  const mine = (el: unknown) => el instanceof HTMLElement && el.classList.contains("transcript");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return mine(this) ? height : 0; } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return mine(this) ? view : 0; } });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() { return mine(this) ? top : 0; },
    set(v: number) { if (mine(this)) top = clamp ? Math.max(0, Math.min(v, height - view)) : v; },
  });
  return {
    get top() { return top; },
    /** The reader dragging the bar, thumb and all: move it, then tell the component. */
    readerScrollsTo(v: number) { top = v; fireEvent.scroll(document.querySelector(".transcript")!); },
    /** A scroller that has just been built, parked wherever the caller says — the staged geometry
     *  outlives the element it describes, so a remount has to be told the box is a new one. No
     *  event: nothing is mounted yet to hear it. */
    reborn(at = 0) { top = at; },
    /** The log's media strips landing, several frames after its text (use-media resolves them
     *  through main). Until they do, the column is short and cannot hold a deep offset. */
    contentGrowsTo(h: number) { height = h; },
  };
}

/** The real ResizeObserver never fires in jsdom, and "the column grew" is the signal these tests
 *  are about. */
function stageObserver() {
  const callbacks: ResizeObserverCallback[] = [];
  vi.stubGlobal("ResizeObserver", class {
    cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.cb = cb; callbacks.push(cb); }
    observe() {}
    unobserve() {}
    disconnect() { const i = callbacks.indexOf(this.cb); if (i >= 0) callbacks.splice(i, 1); }
  } as unknown as typeof ResizeObserver);
  return { contentGrew() { act(() => { for (const cb of [...callbacks]) cb([], null as never); }); } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ["scrollHeight", "clientHeight", "scrollTop"]) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
});

const seeded = () => reduceAll([
  sessionEvent("user_message", { text: "what does this repo do", attachments: [] }),
  sessionEvent("assistant_text", { messageId: "m1", text: "a long answer" }),
]);

const pane = (store: ReturnType<typeof createAppStore>) => (
  <StoreContext.Provider value={store}>
    <SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "Session" })} visible />
  </StoreContext.Provider>
);

async function mountPane() {
  const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle" })] });
  const store = createAppStore(api);
  await store.getState().boot();
  store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 2, t: seeded() } } });
  const r = render(pane(store));
  return { api, store, ...r };
}

/** Another turn lands from the server — the same shape a peer's question or a late tool result has. */
function arrives(store: Awaited<ReturnType<typeof mountPane>>["store"], text: string) {
  store.setState({ transcripts: { se1: { lastSeq: 3, t: reduceAll([
    sessionEvent("user_message", { text: "what does this repo do", attachments: [] }),
    sessionEvent("assistant_text", { messageId: "m1", text: "a long answer" }),
    sessionEvent("assistant_text", { messageId: "m2", text }),
  ]) } } });
}

const box = () => screen.getByRole("textbox", { name: /message/i });

describe("stick-to-bottom", () => {
  it("a block arriving while the reader is halfway up raises the pill instead of yanking them down", async () => {
    const scroller = stageTranscript({ height: 4000, view: 600 });
    const { store } = await mountPane();
    scroller.readerScrollsTo(1200);
    arrives(store, "and here is more of it");
    await waitFor(() => expect(screen.getByRole("button", { name: /New messages/ })).toBeInTheDocument());
    expect(scroller.top).toBe(1200);
  });

  it("sending goes to the bottom even from halfway up, and stays there until the message lands", async () => {
    const scroller = stageTranscript({ height: 4000, view: 600 });
    const { api, store } = await mountPane();
    const sent: string[] = [];
    api.sendMessage = async (_id, text) => { sent.push(text); };

    scroller.readerScrollsTo(1200);
    fireEvent.change(box(), { target: { value: "and what about the server" } });
    fireEvent.keyDown(box(), { key: "Enter" });

    await waitFor(() => expect(sent).toEqual(["and what about the server"]));
    expect(scroller.top).toBe(4000);
    expect(screen.queryByRole("button", { name: /New messages/ })).toBeNull();

    // The send is a round trip: the block itself only exists once the server has echoed it back, and
    // the pin has to still be in force then — the pill here would mean the user was shown a notice
    // about their own message.
    arrives(store, "the server is a Fastify app");
    await waitFor(() => expect(scroller.top).toBe(4000));
    expect(screen.queryByRole("button", { name: /New messages/ })).toBeNull();
  });

  it("⌘⇧↩ dispatches into a new session, so it leaves this transcript where the reader parked it", async () => {
    const scroller = stageTranscript({ height: 4000, view: 600 });
    const { api } = await mountPane();
    const sent: string[] = [];
    api.sendMessage = async (_id, text) => { sent.push(text); };

    scroller.readerScrollsTo(1200);
    fireEvent.change(box(), { target: { value: "take this one away" } });
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true, shiftKey: true });

    expect(sent).toEqual([]); // the window-level dispatch binding owns this chord, not the prompter
    expect(scroller.top).toBe(1200);
  });
});

/**
 * What a space switch does to a session pane: `selectSpace` clears `items` and `sessions`, so every
 * pane in the space being left is unmounted, and coming back mounts a fresh one over a transcript
 * the store never threw away. Unmount/remount against one store is exactly that round trip — the
 * pane cannot tell the difference, because there is none.
 */
describe("coming back after a space switch", () => {
  it("puts the reader back where they were reading, and raises no pill for it", async () => {
    const scroller = stageTranscript({ height: 4000, view: 600 });
    const { store, unmount } = await mountPane();
    scroller.readerScrollsTo(1200);

    unmount();
    scroller.reborn(4000);
    render(pane(store));

    await waitFor(() => expect(scroller.top).toBe(1200));
    // Nothing arrived — the pane was rebuilt around the same log — so a notice about new messages
    // would be a lie about what just happened.
    expect(screen.queryByRole("button", { name: /New messages/ })).toBeNull();
  });

  it("restores the PIN too, not just the offset: the next block raises the pill instead of yanking", async () => {
    const scroller = stageTranscript({ height: 4000, view: 600 });
    const { store, unmount } = await mountPane();
    scroller.readerScrollsTo(1200);

    unmount();
    scroller.reborn(4000);
    render(pane(store));
    await waitFor(() => expect(scroller.top).toBe(1200));

    arrives(store, "and here is more of it");
    await waitFor(() => expect(screen.getByRole("button", { name: /New messages/ })).toBeInTheDocument());
    expect(scroller.top).toBe(1200);
  });

  it("a reader who was AT the bottom comes back at the bottom, still following", async () => {
    const scroller = stageTranscript({ height: 4000, view: 600 });
    const { store, unmount } = await mountPane();
    scroller.readerScrollsTo(1200);
    scroller.readerScrollsTo(4000); // and back down again before leaving

    unmount();
    scroller.reborn(4000);
    render(pane(store));

    arrives(store, "and here is more of it");
    await waitFor(() => expect(scroller.top).toBe(4000));
    expect(screen.queryByRole("button", { name: /New messages/ })).toBeNull();
  });

  /**
   * A transcript's media strips resolve through main, several frames after its text, so a pane that
   * has just come back has a SHORT column — and an offset it cannot hold is silently refused. The
   * restore therefore stays owed until it lands. These three cover the one way it lands and the two
   * ways it is abandoned.
   */
  async function readerReturnsToAShortColumn() {
    const ro = stageObserver();
    const scroller = stageTranscript({ height: 4000, view: 600, clamp: true });
    const { store, unmount } = await mountPane();
    scroller.readerScrollsTo(1200);

    unmount();
    scroller.reborn(0);
    scroller.contentGrowsTo(700);
    render(pane(store));
    await waitFor(() => expect(screen.getByRole("log")).toBeInTheDocument());
    expect(scroller.top).toBe(100); // clamped: everything the short column had to give
    return { scroller, mediaLands: () => { scroller.contentGrowsTo(4000); ro.contentGrew(); } };
  }

  it("waits for the media to land: a short column at mount does not strand the reader at the top", async () => {
    const { scroller, mediaLands } = await readerReturnsToAShortColumn();
    mediaLands();
    expect(scroller.top).toBe(1200);
    expect(screen.queryByRole("button", { name: /New messages/ })).toBeNull();
  });

  it("expires: a log that never grows back must not yank a reader who has moved on", async () => {
    const { scroller, mediaLands } = await readerReturnsToAShortColumn();
    // Past the deadline with the column still short — the media is not coming (a compaction, a
    // session whose files are gone). Whatever the column does AFTER that is no longer the restore's
    // business, even if it happens to grow.
    await new Promise((r) => setTimeout(r, SETTLE_MS + 50));
    mediaLands();
    expect(scroller.top).toBe(100);
  });

  it("expires the moment the reader reaches for the scroller themselves", async () => {
    const { scroller, mediaLands } = await readerReturnsToAShortColumn();
    fireEvent.wheel(document.querySelector(".transcript")!);
    mediaLands();
    expect(scroller.top).toBe(100);
  });

  it("a session nobody has scrolled opens at the newest message, as it always has", async () => {
    const scroller = stageTranscript({ height: 4000, view: 600 });
    const { store, unmount } = await mountPane();

    unmount();
    // At the TOP, so "it opened at the end" is a real assertion rather than a box that was already
    // there. Nothing was remembered for this session, so nothing may be restored.
    scroller.reborn(0);
    render(pane(store));

    await waitFor(() => expect(scroller.top).toBe(4000));
  });
});
