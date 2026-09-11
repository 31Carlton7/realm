import { describe, expect, it } from "vitest";
import { RING_CHARS, Scrollback } from "./scrollback";

const size = { cols: 120, rows: 40 };

describe("Scrollback", () => {
  it("hands a first-time reader everything it has, and a caught-up reader nothing", () => {
    const sb = new Scrollback();
    sb.newRun("t1", "r1", size);
    sb.append("t1", "hello ");
    sb.append("t1", "world");

    const first = sb.read("t1", null)!;
    expect(first).toMatchObject({ runId: "r1", seq: 2, live: "hello world", truncated: false, running: true, history: null });

    expect(sb.read("t1", { runId: "r1", seq: first.seq })).toMatchObject({ live: "", seq: 2 });
    sb.append("t1", "!");
    expect(sb.read("t1", { runId: "r1", seq: first.seq })).toMatchObject({ live: "!", seq: 3 });
  });

  it("sends no history to a reader that is merely behind — it already has it on screen", () => {
    const sb = new Scrollback();
    sb.newRun("t1", "r1", size, { data: "last time", cols: 80, rows: 24 });
    sb.append("t1", "now");
    expect(sb.read("t1", null)!.history).toEqual({ data: "last time", cols: 80, rows: 24 });
    expect(sb.read("t1", { runId: "r1", seq: 1 })!.history).toBeNull();
  });

  it("treats a foreign runId as no cursor at all — one rule for three situations", () => {
    const sb = new Scrollback();
    sb.newRun("t1", "r1", size);
    sb.append("t1", "first run");
    // The pty exited and a new one started. The old buffer becomes the history the pane replays.
    sb.newRun("t1", "r2", size);
    sb.append("t1", "second run");
    // A client still holding r1's cursor: the seq is meaningless, so it is ignored entirely.
    const r = sb.read("t1", { runId: "r1", seq: 1 })!;
    expect(r.runId).toBe("r2");
    expect(r.live).toBe("second run");
    expect(r.history).toEqual({ data: "first run", cols: 120, rows: 40 });
  });

  it("evicts oldest-first and admits it, so the pane resets instead of replaying a hole", () => {
    const sb = new Scrollback();
    sb.newRun("t1", "r1", size);
    const chunk = "x".repeat(1024);
    for (let i = 0; i < (RING_CHARS / 1024) + 10; i++) sb.append("t1", chunk);

    const fresh = sb.read("t1", null)!;
    expect(fresh.live.length).toBeLessThanOrEqual(RING_CHARS);
    // A reader with no cursor cannot be told this is complete, because it is not.
    expect(fresh.truncated).toBe(true);

    // A cursor pointing at an evicted chunk: a hole, and a hole mid-escape-sequence is a pane xterm
    // cannot recover on its own.
    const behind = sb.read("t1", { runId: "r1", seq: 1 })!;
    expect(behind.truncated).toBe(true);
    expect(behind.live).toBe(fresh.live);

    // …but a cursor still inside the ring is served normally.
    expect(sb.read("t1", { runId: "r1", seq: fresh.seq - 1 })).toMatchObject({ truncated: false, live: chunk });
  });

  it("keeps the last screen after the pty exits, and says it is not running", () => {
    const sb = new Scrollback();
    sb.newRun("t1", "r1", size);
    sb.append("t1", "goodbye");
    sb.endRun("t1");
    expect(sb.read("t1", null)).toMatchObject({ live: "goodbye", running: false });
  });

  it("carries a run forward when the next one is handed no history of its own", () => {
    const sb = new Scrollback();
    sb.newRun("t1", "r1", size, { data: "older", cols: 80, rows: 24 });
    // Nothing was printed this run, so there is nothing to rotate — the older screen survives rather
    // than being replaced by an empty one.
    sb.newRun("t1", "r2", size);
    expect(sb.read("t1", null)!.history).toEqual({ data: "older", cols: 80, rows: 24 });
  });

  it("records the size output was printed at, so a restore does not respawn at 80×24", () => {
    const sb = new Scrollback();
    sb.newRun("t1", "r1", { cols: 200, rows: 50 });
    sb.append("t1", "wide");
    sb.resize("t1", 100, 30);
    expect(sb.snapshot("t1")).toEqual({ data: "wide", cols: 100, rows: 30 });
  });

  it("knows nothing about a terminal it was never told about", () => {
    const sb = new Scrollback();
    expect(sb.read("nope", null)).toBeNull();
    expect(sb.append("nope", "x")).toBeNull();
    expect(sb.snapshot("nope")).toBeNull();
  });

  it("forgets on request, which is what a closed terminal gets", () => {
    const sb = new Scrollback();
    sb.newRun("t1", "r1", size);
    sb.append("t1", "x");
    expect(sb.ids()).toEqual(["t1"]);
    sb.forget("t1");
    expect(sb.read("t1", null)).toBeNull();
  });
});
