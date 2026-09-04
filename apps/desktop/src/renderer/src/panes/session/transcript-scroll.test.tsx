import { afterEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { sessionEvent } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";
import { reduceAll } from "./transcript-model";

/**
 * jsdom lays nothing out, so `scrollHeight` and `clientHeight` are 0 on every element and the
 * near-bottom test (`scrollHeight - scrollTop - clientHeight < 80`) is true everywhere: without
 * this, every scroller looks pinned to the bottom already and "the reader had scrolled up" is a
 * state no test could be in. Stage a geometry on `.transcript`, including a `scrollTop` that
 * actually stores what is written to it — jsdom's own is a permanent 0.
 */
function stageTranscript({ height, view }: { height: number; view: number }) {
  let top = height;
  const mine = (el: unknown) => el instanceof HTMLElement && el.classList.contains("transcript");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return mine(this) ? height : 0; } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return mine(this) ? view : 0; } });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() { return mine(this) ? top : 0; },
    set(v: number) { if (mine(this)) top = v; },
  });
  return {
    get top() { return top; },
    /** The reader dragging the bar, thumb and all: move it, then tell the component. */
    readerScrollsTo(v: number) { top = v; fireEvent.scroll(document.querySelector(".transcript")!); },
  };
}

afterEach(() => {
  for (const k of ["scrollHeight", "clientHeight", "scrollTop"]) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
});

const seeded = () => reduceAll([
  sessionEvent("user_message", { text: "what does this repo do", attachments: [] }),
  sessionEvent("assistant_text", { messageId: "m1", text: "a long answer" }),
]);

async function mountPane() {
  const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle" })] });
  const store = createAppStore(api);
  await store.getState().boot();
  store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 2, t: seeded() } } });
  const r = render(
    <StoreContext.Provider value={store}>
      <SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "Session" })} visible />
    </StoreContext.Provider>,
  );
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
