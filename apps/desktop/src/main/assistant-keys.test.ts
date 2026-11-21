import { describe, expect, it } from "vitest";
import { ASSISTANT_CHORDS, type AssistantPageAction } from "@realm/contracts";
import { AssistantKeys, onPageGone, PageInbox } from "./assistant-keys";
import { CHORD_KEY_CODES, type ChordKey } from "./realm-keys";

function rig(opts: { open?: boolean; listening?: boolean; shown?: boolean; consented?: boolean } = {}) {
  const calls: string[] = [];
  const sent: AssistantPageAction[] = [];
  const registered = new Map<ChordKey, () => void>();
  let open = opts.open ?? false;
  let shown = opts.shown ?? false;
  const keys = new AssistantKeys({
    register: (key, run) => {
      registered.set(key, run);
      return () => { registered.delete(key); };
    },
    panel: {
      isOpen: () => open,
      open: () => { open = true; calls.push("open"); },
      openInactive: () => { open = true; calls.push("open inactive"); },
      close: () => { open = false; calls.push("close"); },
      move: (direction) => calls.push(`move ${direction}`),
    },
    send: (action) => { sent.push(action); shown = action !== "chat"; },
    listening: () => opts.listening ?? false,
    shown: () => shown,
  });
  keys.set(true);
  keys.setConsented(opts.consented ?? true);
  const press = (key: ChordKey) => registered.get(key)!();
  return { keys, calls, sent, registered, press };
}

describe("the assistant's chords", () => {
  it("registers every chord the spec gives, on keys the helper has codes for", () => {
    const r = rig();
    expect([...r.registered.keys()].sort()).toEqual([",", ".", "G", "J", "K", "L", "R", "T"]);
    for (const { key } of ASSISTANT_CHORDS) expect(CHORD_KEY_CODES[key]).toBeTypeOf("number");
  });

  it("takes none of the keys macOS gives the Globe key, nor Space", () => {
    const taken = new Set<string>(ASSISTANT_CHORDS.map((c) => c.key));
    for (const key of ["A", "C", "D", "E", "F", "H", "M", "N", "Q", "Space"]) expect(taken.has(key)).toBe(false);
  });

  it("gives every key back when turned off, and takes them again when turned on", () => {
    const r = rig();
    r.keys.set(false);
    expect(r.registered.size).toBe(0);
    r.keys.set(true);
    expect(r.registered.size).toBe(ASSISTANT_CHORDS.length);
  });

  it("registers each chord once however often it is turned on", () => {
    let registers = 0;
    const keys = new AssistantKeys({
      register: () => { registers++; return () => {}; },
      panel: { isOpen: () => false, open: () => {}, openInactive: () => {}, close: () => {}, move: () => {} },
      send: () => {}, listening: () => false, shown: () => false,
    });
    keys.setConsented(true);
    keys.set(true);
    keys.set(true);
    expect(registers).toBe(ASSISTANT_CHORDS.length);
  });

  it("registers nothing before the first-run sheet was accepted, and every chord once it is", () => {
    const r = rig({ consented: false });
    expect(r.registered.size).toBe(0);
    expect(r.keys.live).toBe(false);
    r.keys.setConsented(true);
    expect(r.registered.size).toBe(ASSISTANT_CHORDS.length);
    expect(r.keys.live).toBe(true);
  });

  it("gives every key back when the switch goes off after the sheet was accepted", () => {
    const r = rig();
    r.keys.set(false);
    expect(r.registered.size).toBe(0);
    expect(r.keys.live).toBe(false);
    r.keys.setConsented(true);
    expect(r.registered.size).toBe(0);
  });

  it("R opens the panel on the assistant, and puts an open panel away", () => {
    const r = rig();
    r.press("R");
    expect(r.calls).toEqual(["open inactive"]);
    expect(r.sent).toEqual(["toggle"]);
    r.press("R");
    expect(r.calls).toEqual(["open inactive", "close"]);
    expect(r.sent).toEqual(["toggle"]);
  });

  it("R turns a panel open on the chat to the assistant, and puts it away only from the assistant", () => {
    const r = rig({ open: true, shown: false });
    r.press("R");
    expect(r.calls).toEqual(["open inactive"]);
    expect(r.sent).toEqual(["toggle"]);
    r.press("R");
    expect(r.calls).toEqual(["open inactive", "close"]);
  });

  it("R, L and G leave the keyboard with the app in front, and T takes it", () => {
    for (const key of ["R", "L", "G"] as const) {
      const r = rig();
      r.press(key);
      expect(r.calls, key).toEqual(["open inactive"]);
    }
    const t = rig();
    t.press("T");
    expect(t.calls).toEqual(["open"]);
  });

  it("the quick chat keys open the panel on the chat with the keyboard, even after an assistant key", () => {
    const r = rig();
    r.press("G");
    r.keys.openChat();
    expect(r.calls).toEqual(["open inactive", "open"]);
    expect(r.sent).toEqual(["answer", "chat"]);
  });

  it("the quick chat keys put away a panel showing the chat, and leave a shut one on the chat", () => {
    const shut = rig();
    shut.keys.openChat();
    expect(shut.calls).toEqual(["open"]);
    expect(shut.sent).toEqual(["chat"]);
    shut.keys.openChat();
    expect(shut.calls).toEqual(["open", "close"]);
    expect(shut.sent).toEqual(["chat"]);
  });

  it("L opens the panel to start listening, and stops a run without opening it", () => {
    const idle = rig();
    idle.press("L");
    expect(idle.calls).toEqual(["open inactive"]);
    expect(idle.sent).toEqual(["listen"]);
    const running = rig({ listening: true });
    running.press("L");
    expect(running.calls).toEqual([]);
    expect(running.sent).toEqual(["listen"]);
  });

  it("G and T open the panel and tell its page", () => {
    const r = rig();
    r.press("G");
    r.press("T");
    expect(r.calls).toEqual(["open inactive", "open"]);
    expect(r.sent).toEqual(["answer", "type"]);
  });

  it("J and K scroll an open panel, and do nothing to one put away", () => {
    const shut = rig();
    shut.press("J");
    shut.press("K");
    expect(shut.sent).toEqual([]);
    expect(shut.calls).toEqual([]);
    const open = rig({ open: true });
    open.press("J");
    open.press("K");
    expect(open.sent).toEqual(["scrollDown", "scrollUp"]);
  });

  it(", and . move an open panel left and right, and leave one put away", () => {
    const shut = rig();
    shut.press(",");
    expect(shut.calls).toEqual([]);
    const open = rig({ open: true });
    open.press(",");
    open.press(".");
    expect(open.calls).toEqual(["move -1", "move 1"]);
    expect(open.sent).toEqual([]);
  });
});

describe("PageInbox", () => {
  it("holds a key for a page still loading, and gives the last one once it listens", () => {
    const got: [string, AssistantPageAction][] = [];
    const inbox = new PageInbox<string>((page, action) => got.push([page, action]));
    inbox.send("panel", "toggle");
    inbox.send("panel", "type");
    expect(got).toEqual([]);
    inbox.pageReady("panel");
    expect(got).toEqual([["panel", "type"]]);
    inbox.send("panel", "answer");
    expect(got).toEqual([["panel", "type"], ["panel", "answer"]]);
  });

  it("gives a new page nothing meant for the one before it, and waits for the new one to listen", () => {
    const got: [string, AssistantPageAction][] = [];
    const inbox = new PageInbox<string>((page, action) => got.push([page, action]));
    inbox.pageReady("old");
    inbox.send("new", "listen");
    expect(got).toEqual([]);
    inbox.pageReady("new");
    expect(got).toEqual([["new", "listen"]]);
  });

  it("drops a key held for a page that went before it listened", () => {
    const got: [string, AssistantPageAction][] = [];
    const inbox = new PageInbox<string>((page, action) => got.push([page, action]));
    inbox.send("failed load", "answer");
    inbox.pageReady("next page");
    expect(got).toEqual([]);
  });

  it("holds keys again for a page that reloads or crashes, until it says it listens", () => {
    const got: AssistantPageAction[] = [];
    const inbox = new PageInbox<string>((_page, action) => got.push(action));
    inbox.pageReady("panel");
    inbox.forget("panel");
    inbox.send("panel", "answer");
    expect(got).toEqual([]);
    inbox.pageReady("panel");
    expect(got).toEqual(["answer"]);
  });

  it("drops a key when there is no panel", () => {
    const got: AssistantPageAction[] = [];
    const inbox = new PageInbox<string>((_page, action) => got.push(action));
    inbox.send(null, "toggle");
    inbox.pageReady("panel");
    expect(got).toEqual([]);
  });
});

describe("onPageGone", () => {
  function page() {
    const handlers: Record<string, ((details?: { isMainFrame: boolean; isSameDocument: boolean }) => void)[]> = {};
    return {
      on: (event: string, listener: (details?: { isMainFrame: boolean; isSameDocument: boolean }) => void) => { (handlers[event] ??= []).push(listener); },
      emit: (event: string, details?: { isMainFrame: boolean; isSameDocument: boolean }) => { for (const h of handlers[event] ?? []) h(details); },
    };
  }

  it("hears a new document in the main frame and a crash, and not a hash change or a frame", () => {
    const p = page();
    let gone = 0;
    onPageGone(p as never, () => gone++);
    p.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    p.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    expect(gone).toBe(0);
    p.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(gone).toBe(1);
    p.emit("render-process-gone");
    expect(gone).toBe(2);
  });
});
