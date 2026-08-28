import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createEnterTracker } from "./transcript-enter";
import { Transcript } from "./Transcript";
import type { Block, PendingPermission, Transcript as TranscriptModel } from "./transcript-model";

afterEach(() => cleanup());

describe("enter tracker (§6: new items only)", () => {
  it("seeds the first observation as already-seen — a restored transcript animates nothing", () => {
    const t = createEnterTracker();
    expect([...t.observe(["a", "b", "c"])]).toEqual([]);
  });

  it("marks only keys that appear after the first observation", () => {
    const t = createEnterTracker();
    t.observe(["a", "b"]);
    expect([...t.observe(["a", "b", "c"])]).toEqual(["c"]);
    expect([...t.observe(["a", "b", "c", "d"])]).toEqual(["c", "d"]);
  });

  it("never drops a mark: a key stays marked across observations, so a mid-flight re-render cannot abort the animation", () => {
    const t = createEnterTracker();
    t.observe(["a"]);
    t.observe(["a", "b"]);
    expect([...t.observe(["a", "b"])]).toContain("b"); // same keys again — the mark survives
    expect([...t.observe(["a", "b"])]).toContain("b");
  });

  it("a key that leaves and comes back is not new — it is the same item returning", () => {
    const t = createEnterTracker();
    t.observe(["a", "b"]);
    t.observe(["a"]);           // b removed
    expect([...t.observe(["a", "b"])]).toEqual([]); // b back: still seen, still not entering
  });

  it("an empty first observation still counts as the mount — the first real item is new", () => {
    const t = createEnterTracker();
    expect([...t.observe([])]).toEqual([]);
    expect([...t.observe(["a"])]).toEqual(["a"]);
  });
});

const model = (blocks: Block[], pendingPermissions: PendingPermission[] = []): TranscriptModel =>
  ({ blocks, pendingPermissions, usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null });

const user = (text: string): Block => ({ kind: "user", text, ts: 0 });
const assistant = (text: string, streaming = false): Block => ({ kind: "assistant", messageId: "m1", text, streaming, ts: 0 });
const tool = (id: string): Block => ({ kind: "tool", toolUseId: id, name: "Bash", input: { command: "ls" }, result: null, ts: 0 });
const perm = (requestId: string): PendingPermission => ({ requestId, toolName: "Bash", input: { command: "ls" }, title: "Run ls?" });

/** Every direct child of the transcript column, as `class → is it animating in?`. */
const rows = (): [string, boolean][] =>
  [...document.querySelectorAll<HTMLElement>(".transcript-col > *")].map((el) => [el.className, el.hasAttribute("data-enter")]);
const entering = (): string[] => rows().filter(([, e]) => e).map(([c]) => c);

const view = (t: TranscriptModel, status: "idle" | "running" | "waiting_permission" = "idle") =>
  <Transcript transcript={t} sessionStatus={status} onDecide={() => {}} />;

describe("Transcript enter animation (§6: 180ms, new items only)", () => {
  it("animates nothing on mount, however much history there is", () => {
    render(view(model([user("hi"), assistant("hello"), tool("t1")])));
    expect(rows()).toHaveLength(3);
    expect(entering()).toEqual([]);
  });

  it("animates only the block that just arrived", () => {
    const { rerender } = render(view(model([user("hi"), assistant("hello")])));
    rerender(view(model([user("hi"), assistant("hello"), tool("t1")])));
    expect(entering()).toEqual(["tool-card"]);
  });

  it("keeps the mark through the re-renders that happen during the 180ms — streaming deltas must not abort it", () => {
    const { rerender } = render(view(model([user("hi")])));
    rerender(view(model([user("hi"), assistant("he", true)]), "running"));
    expect(entering()).toEqual(["md msg-assistant"]);
    rerender(view(model([user("hi"), assistant("hello", true)]), "running"));
    rerender(view(model([user("hi"), assistant("hello there")]), "idle"));
    expect(entering()).toEqual(["md msg-assistant"]); // still marked, and still the only one
  });

  it("re-rendering with unchanged blocks never promotes an existing block to entering", () => {
    const t = model([user("hi"), assistant("hello")]);
    const { rerender } = render(view(t));
    rerender(view(t, "running"));
    rerender(view(t, "idle"));
    expect(entering()).toEqual([]);
  });

  it("coming back to a session animates nothing — a fresh mount re-seeds from the full history", () => {
    const grown = model([user("hi"), assistant("hello"), tool("t1")]);
    const { rerender, unmount } = render(view(model([user("hi"), assistant("hello")])));
    rerender(view(grown));
    expect(entering()).toEqual(["tool-card"]);
    unmount();
    render(view(grown)); // the pane comes back with the same three blocks
    expect(entering()).toEqual([]);
  });

  it("a permission card that was already on screen at mount never animates, even after the status flips away and back", () => {
    // Cards render only while waiting_permission, so a status round-trip unmounts and remounts them.
    // The tracker seeded this request at mount, so it stays un-marked and the remount is silent.
    const pending = model([user("hi")], [perm("r1")]);
    const { rerender } = render(view(pending, "waiting_permission"));
    expect(rows().some(([c]) => c === "permission-card")).toBe(true);
    expect(entering()).toEqual([]);
    rerender(view(pending, "running"));
    expect(rows().some(([c]) => c === "permission-card")).toBe(false);
    rerender(view(pending, "waiting_permission"));
    expect(entering()).toEqual([]);
  });

  it("a permission card arriving mid-session animates in", () => {
    const { rerender } = render(view(model([user("hi")]), "waiting_permission"));
    rerender(view(model([user("hi")], [perm("r1")]), "waiting_permission"));
    expect(entering()).toEqual(["permission-card"]);
  });
});
