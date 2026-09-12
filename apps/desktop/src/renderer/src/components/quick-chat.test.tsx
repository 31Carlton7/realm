import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { allItems, sessionEvent } from "@realm/contracts";
import { reduceAll } from "../panes/session/transcript-model";
import { QuickChat } from "./QuickChat";
import { NewSessionRow } from "./sidebar/NewSessionRow";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, type FakeData } from "../state/store.test-fakes";

async function mount(overrides: FakeData = {}) {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(
    <StoreContext.Provider value={store}>
      <NewSessionRow />
      <QuickChat />
    </StoreContext.Provider>,
  );
  return { api, store, ...r };
}

const openChat = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Quick chat" }));
  return screen.findByRole("dialog", { name: "Quick chat" });
};
const chat = () => screen.getByRole("dialog", { name: "Quick chat" });

/* jsdom implements no `PointerEvent`, and testing-library's `fireEvent.pointerMove` then dispatches
   a bare `Event` that carries no coordinates at all — a drag test built on it moves the window by
   NaN and proves nothing. A `MouseEvent` under the pointer event's name has the fields React reads.

   Through `fireEvent` rather than `dispatchEvent`, because the drag's move listener is attached by
   an effect that only runs once React has flushed the pointerdown's state; a raw dispatch fires the
   move before that listener exists. */
const pointer = (target: Window | Element, type: string, init: MouseEventInit) =>
  fireEvent(target, new MouseEvent(type, { bubbles: true, ...init }));

/** A Finder drag. `path` is what Electron hands a dropped File and what the store attaches by, so a
 *  file carrying one never reaches the paste path (`saveTempAttachment`). */
const dropped = (path: string, type = "image/png") =>
  Object.assign(new File([new Uint8Array(4)], path.split("/").pop()!, { type }), { path }) as unknown as File;
const fileDrag = (files: File[]) => ({ dataTransfer: { files, items: files.map(() => ({ kind: "file" })), types: ["Files"] } });

afterEach(() => cleanup());

describe("the quick chat", () => {
  it("draws nothing until it is opened", async () => {
    await mount();
    expect(screen.queryByRole("dialog", { name: "Quick chat" })).toBeNull();
  });

  it("makes a real session but takes NO pane — the window is where it is shown", async () => {
    /* THE MUTANT: adopt it into the layout like `newSession` does. The same conversation would then
       be open twice, in a window and a pane, and closing the window would leave the pane behind. */
    const { store, api } = await mount();
    const before = allItems(store.getState().layout!);
    await openChat();
    expect(api.calls.some((c) => c.startsWith("createUnlistedSession:"))).toBe(true);
    expect(allItems(store.getState().layout!)).toEqual(before);
    // …and no item either, so it is in no list anywhere: not the sidebar, the pinned grid, the
    // command palette, the Library, or any pane.
    const qc = store.getState().quickChat!;
    expect(store.getState().items.some((i) => i.refId === qc.sessionId)).toBe(false);
  });

  it("opens ONE. A second press is not a second window", async () => {
    const { store } = await mount();
    await openChat();
    const first = store.getState().quickChat!.sessionId;
    fireEvent.click(screen.getByRole("button", { name: "Quick chat" }));
    await waitFor(() => expect(screen.getAllByRole("dialog", { name: "Quick chat" })).toHaveLength(1));
    expect(store.getState().quickChat!.sessionId).toBe(first);
  });

  it("carries the prompter's model picker and its attach control", async () => {
    await mount();
    const w = within(await openChat());
    expect(w.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
    expect(w.getByRole("button", { name: /model/i })).toBeInTheDocument();
    expect(w.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  it("drops the chrome that is about a workspace — no permission chip, no mode chip, no under-strip", async () => {
    /* Every one of these answers "where and how does this session run", and a quick chat is a
       question in a corner. THE MUTANT: pass `compact={false}`; the card grows a row of chips and an
       under-strip taller than the transcript above it. */
    const w = within(await (await mount(), openChat()));
    expect(w.queryByRole("button", { name: "Permission mode" })).toBeNull();
    expect(w.queryByRole("button", { name: "Mode" })).toBeNull();
    expect(w.queryByRole("button", { name: "Workspace" })).toBeNull();
    expect(chat().querySelector(".composer-understrip")).toBeNull();
    expect(chat().querySelector(".composer-todos")).toBeNull();
    expect(chat().querySelector(".composer-overstrip")).toBeNull();
  });

  it("has no browser, documents, terminal or summary — one close and nothing else", async () => {
    const w = within(await (await mount(), openChat()));
    for (const name of [/browser/i, /documents/i, /terminal/i, /summary/i]) {
      expect(w.queryByRole("button", { name })).toBeNull();
    }
    expect(w.getByRole("button", { name: "Close quick chat" })).toBeInTheDocument();
  });

  it("closes at once on an EMPTY chat, and the close DELETES the session", async () => {
    const { store, api } = await mount();
    await openChat();
    const { sessionId } = store.getState().quickChat!;
    fireEvent.click(within(chat()).getByRole("button", { name: "Close quick chat" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Quick chat" })).toBeNull());
    // THE MUTANT: merely hide the window. The session and its row would pile up in the space, one
    // per press, with nothing left that says they are there.
    await waitFor(() => expect(api.calls).toContain(`deleteSession:${sessionId}`));
    expect(store.getState().sessions[sessionId]).toBeUndefined();
  });

  it("arms first once there is something to lose, and names what it will delete", async () => {
    /* design.md: a confirm is owed by the OBJECT. An empty chat has nothing under it and a second
       click there would guard nothing; a conversation is something a stray click would cost you. */
    const { store } = await mount();
    await openChat();
    const { sessionId } = store.getState().quickChat!;
    // What the session looks like the moment its first message has landed.
    store.setState({ transcripts: { [sessionId]: { lastSeq: 1, t: reduceAll([
      sessionEvent("user_message", { text: "how do I run the suite?", attachments: [] }),
    ]) } } });
    fireEvent.click(await within(chat()).findByRole("button", { name: "Close quick chat" }));
    const confirm = await screen.findByRole("button", { name: "Delete this chat?" });
    expect(store.getState().quickChat).not.toBeNull();
    fireEvent.click(confirm);
    await waitFor(() => expect(store.getState().quickChat).toBeNull());
  });

  it("stays up across a space switch, session and all — it is not native to a space", async () => {
    /* THE MUTANT that actually bites: `refreshSessions` REBUILDS `sessions` from the active space's
       list, so without putting the quick chat's row back the window would lose the session it is
       showing on the first space switch and render nothing. */
    const { store } = await mount();
    await openChat();
    const kept = store.getState().quickChat!;
    await store.getState().selectSpace("s2");
    expect(store.getState().quickChat).toEqual(kept);
    expect(store.getState().sessions[kept.sessionId]).toBeDefined();
    expect(screen.getByRole("dialog", { name: "Quick chat" })).toBeInTheDocument();
  });

  it("comes back after a relaunch, in the corner it was left in", async () => {
    const { store, api } = await mount();
    await openChat();
    const kept = store.getState().quickChat!;
    store.getState().setQuickChatPos({ x: 120, y: 90 });
    // The position write is on a trailing debounce (a drag writes every frame); wait for it to land.
    await waitFor(() => expect(api.calls.filter((c) => c.startsWith("setSetting:ui.quickChat")).length).toBeGreaterThan(1));
    // What the next launch reads: the same server, the same settings, a fresh store.
    const next = createAppStore(api);
    await next.getState().boot();
    expect(next.getState().quickChat).toEqual(kept);
    expect(next.getState().quickChatPos).toEqual({ x: 120, y: 90 });
    expect(next.getState().sessions[kept.sessionId]).toBeDefined();
  });

  it("does not restore a window onto a session that is gone", async () => {
    /* A stored id outlives its row when the space it ran in was deleted, or the session was deleted
       from elsewhere. THE MUTANT: trust the setting. The window opens with a transcript that never
       loads and a prompter whose every send fails. */
    const { store, api } = await mount();
    await openChat();
    const { sessionId } = store.getState().quickChat!;
    await api.deleteSession(sessionId);
    const next = createAppStore(api);
    await next.getState().boot();
    expect(next.getState().quickChat).toBeNull();
  });

  it("says what it is, and what closing does, before anything has been typed into it", async () => {
    // "Closing removes the chat" is worth knowing before you have used one, not at the moment you
    // are about to lose something.
    const w = within(await (await mount(), openChat()));
    expect(w.getByText(/takes no pane/)).toBeInTheDocument();
    expect(w.getByText(/deletes the conversation/)).toBeInTheDocument();
    expect(w.getByText("Quick chat")).toBeInTheDocument();
  });

  it("drags by its bar, and remembers where it was put after it is closed", async () => {
    const { store } = await mount();
    const win = await openChat();
    const bar = win.querySelector(".quick-chat-bar") as HTMLElement;
    const at = () => ({ x: parseFloat(win.style.left), y: parseFloat(win.style.top) });
    const start = at();
    pointer(bar, "pointerdown", { clientX: 500, clientY: 500 });
    pointer(window, "pointermove", { clientX: 460, clientY: 470 });
    pointer(window, "pointerup", {});
    const moved = store.getState().quickChatPos!;
    expect(moved).toEqual({ x: start.x - 40, y: start.y - 30 });
    // THE MUTANT: clear the position with the chat. Closing removes the conversation, not the place
    // on screen the user plainly decided the window should live.
    fireEvent.click(within(chat()).getByRole("button", { name: "Close quick chat" }));
    await waitFor(() => expect(store.getState().quickChat).toBeNull());
    expect(store.getState().quickChatPos).toEqual(moved);
  });

  it("a window too small to hold it draws it pulled in, without forgetting where it was put", async () => {
    /* THE MUTANT, and the one that actually shipped: write the clamped position back on resize.
       Electron's window is fractionally sized for a moment during startup, which fires a resize
       while the restored position is still the one the user dragged to — so the write moved the
       chat to that transient window's corner and forgot their placement, permanently, and only on
       some launches. The clamp is a rendering concern; the stored value is their decision. */
    const { store } = await mount();
    const win = await openChat();
    // Comfortably inside jsdom's default 1024×768 viewport, so this is where it really sits.
    store.getState().setQuickChatPos({ x: 500, y: 200 });
    await waitFor(() => expect(win.style.left).toBe("500px"));
    const size = (w: number, h: number) => {
      Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
      fireEvent(window, new Event("resize"));
    };
    try {
      size(700, 600);
      // Drawn inside the smaller window — 700 − 380 − 16 = 304…
      await waitFor(() => expect(win.style.left).toBe("304px"));
      // …and still remembering where it belongs.
      expect(store.getState().quickChatPos).toEqual({ x: 500, y: 200 });
      // So growing the window puts it back where the user left it.
      size(1024, 768);
      await waitFor(() => expect(win.style.left).toBe("500px"));
    } finally { size(1024, 768); }
  });

  it("a pointer event with no coordinates moves it nowhere, rather than spinning", async () => {
    /* THE MUTANT, and the one that actually happened: clamp with a bare min/max. NaN passes through
       both unchanged, so the re-clamp below decides the position is still wrong (`NaN !== NaN`),
       writes it again, and the two loop until React gives up with "maximum update depth exceeded". */
    const { store } = await mount();
    const win = await openChat();
    const bar = win.querySelector(".quick-chat-bar") as HTMLElement;
    pointer(bar, "pointerdown", { clientX: 500, clientY: 500 });
    fireEvent(win, new Event("pointermove", { bubbles: true }));
    fireEvent(window, new Event("pointermove"));
    pointer(window, "pointerup", {});
    const pos = store.getState().quickChatPos;
    if (pos) { expect(Number.isFinite(pos.x)).toBe(true); expect(Number.isFinite(pos.y)).toBe(true); }
    expect(screen.getByRole("dialog", { name: "Quick chat" })).toBeInTheDocument();
  });

  it("takes a file dropped anywhere on it, and glows over the READING area — never around the prompter", async () => {
    /* The window is the target, not the card: the prompter is the bottom fifth of 380px and the rest
       is the transcript you were reading when you picked the file up. THE MUTANT is the prompter
       claiming the drag the way it does in a pane — the glow would go out over the bottom fifth of
       the window and a rectangle would light inside it instead.

       Where it is DRAWN is the other half, and the two are not the same question. The glow used to
       hang off the window and so ringed the prompter as well, which says the card takes the file.
       THE second mutant: hang it off `.quick-chat` again. It renders identically in jsdom, which has
       no layout — the containment is structural, so this asserts the structure. */
    const { store } = await mount();
    const win = await openChat();
    const sid = store.getState().quickChat!.sessionId;
    const files = [dropped("/Users/me/shot.png")];

    fireEvent.dragEnter(win.querySelector(".transcript, .quick-chat-empty")!, fileDrag(files));
    expect(win).toHaveAttribute("data-dropping");
    const glow = win.querySelector(".session-drop");
    expect(glow).toBeInTheDocument();
    // Inside the body, which ends where the prompter begins — and NOT a sibling of the dock.
    expect(glow!.closest(".quick-chat-body")).not.toBeNull();
    expect(win.querySelector(".quick-chat-body")!.querySelector(".composer-dock")).toBeNull();
    // It names the gesture: at this size a lit rectangle on its own is not an instruction.
    expect(glow!.textContent).toMatch(/drop/i);
    // One affordance for one drag, wherever it is held — including over the card.
    fireEvent.dragEnter(win.querySelector(".composer")!, fileDrag(files));
    expect(win.querySelector(".composer")).not.toHaveAttribute("data-dropping");
    expect(win).toHaveAttribute("data-dropping");

    fireEvent.drop(win.querySelector(".composer")!, fileDrag(files));
    await waitFor(() => expect(store.getState().pendingAttachments[sid]).toHaveLength(1));
    expect(store.getState().pendingAttachments[sid]![0]!.path).toBe("/Users/me/shot.png");
    expect(win.querySelector(".session-drop")).not.toBeInTheDocument();
  });

  it("leaves Realm's own drags alone — a session dragged over it is not a file", async () => {
    const { store } = await mount();
    const win = await openChat();
    fireEvent.dragEnter(win, { dataTransfer: { files: [], items: [], types: ["application/x-realm-item"] } });
    expect(win).not.toHaveAttribute("data-dropping");
    expect(store.getState().pendingAttachments[store.getState().quickChat!.sessionId] ?? []).toHaveLength(0);
  });

  it("stays inside the window — a drag cannot strand it off the edge", async () => {
    const { store } = await mount();
    const win = await openChat();
    const bar = win.querySelector(".quick-chat-bar") as HTMLElement;
    pointer(bar, "pointerdown", { clientX: 500, clientY: 500 });
    pointer(window, "pointermove", { clientX: -4000, clientY: -4000 });
    pointer(window, "pointerup", {});
    const { x, y } = store.getState().quickChatPos!;
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
  });
});
