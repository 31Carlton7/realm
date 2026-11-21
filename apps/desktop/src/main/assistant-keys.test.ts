import { describe, expect, it } from "vitest";
import { ASSISTANT_CHORDS, type AssistantPageAction } from "@realm/contracts";
import { AssistantKeys, PageInbox } from "./assistant-keys";
import { CHORD_KEY_CODES, type ChordKey } from "./realm-keys";

function rig(opts: { open?: boolean; listening?: boolean } = {}) {
  const calls: string[] = [];
  const sent: AssistantPageAction[] = [];
  const registered = new Map<ChordKey, () => void>();
  let open = opts.open ?? false;
  const keys = new AssistantKeys({
    register: (key, run) => {
      registered.set(key, run);
      return () => { registered.delete(key); };
    },
    panel: {
      isOpen: () => open,
      open: () => { open = true; calls.push("open"); },
      close: () => { open = false; calls.push("close"); },
      move: (direction) => calls.push(`move ${direction}`),
    },
    send: (action) => sent.push(action),
    listening: () => opts.listening ?? false,
  });
  keys.set(true);
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
      panel: { isOpen: () => false, open: () => {}, close: () => {}, move: () => {} },
      send: () => {}, listening: () => false,
    });
    keys.set(true);
    keys.set(true);
    expect(registers).toBe(ASSISTANT_CHORDS.length);
  });

  it("R opens the panel on the assistant, and puts an open panel away", () => {
    const r = rig();
    r.press("R");
    expect(r.calls).toEqual(["open"]);
    expect(r.sent).toEqual(["toggle"]);
    r.press("R");
    expect(r.calls).toEqual(["open", "close"]);
    expect(r.sent).toEqual(["toggle"]);
  });

  it("L opens the panel to start listening, and stops a run without opening it", () => {
    const idle = rig();
    idle.press("L");
    expect(idle.calls).toEqual(["open"]);
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
    expect(r.calls).toEqual(["open", "open"]);
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

  it("drops a key when there is no panel", () => {
    const got: AssistantPageAction[] = [];
    const inbox = new PageInbox<string>((_page, action) => got.push(action));
    inbox.send(null, "toggle");
    inbox.pageReady("panel");
    expect(got).toEqual([]);
  });
});
