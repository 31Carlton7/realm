import { describe, expect, it } from "vitest";
import { LEAVE_ALT_SCREEN, replayString, terminalStateWord } from "./terminal-replay";

const read = (over: { history?: { data: string; cols: number; rows: number } | null; live?: string } = {}) => ({
  history: over.history ?? null, live: over.live ?? "",
});

describe("replayString", () => {
  it("leaves the alternate screen and resets SGR between the old screen and the new shell", () => {
    const out = replayString(read({ history: { data: "\x1b[?1049h\x1b[31mVIM", cols: 80, rows: 24 }, live: "$ " }), { running: true });
    const altExit = out.indexOf(LEAVE_ALT_SCREEN);
    // MUTANT: drop this and a tail captured inside vim strands the restored pane in the alternate
    // buffer — every byte the new shell prints lands where nobody is looking.
    expect(altExit).toBeGreaterThan(out.indexOf("VIM"));
    expect(out.indexOf("$ ")).toBeGreaterThan(altExit);
  });

  it("escapes the alternate screen even when the new shell has printed nothing yet", () => {
    const out = replayString(read({ history: { data: "\x1b[?1049hHTOP", cols: 80, rows: 24 } }), { running: true });
    expect(out).toContain(LEAVE_ALT_SCREEN);
  });

  it("labels both blocks so the replay cannot read as live", () => {
    const out = replayString(read({ history: { data: "old", cols: 80, rows: 24 }, live: "new" }), { running: true });
    expect(out).toContain("earlier");
    expect(out).toContain("now");
    expect(out.indexOf("old")).toBeLessThan(out.indexOf("new"));
  });

  it("says a pane with no pty is not running, rather than letting it look idle", () => {
    expect(replayString(read({ history: { data: "old", cols: 80, rows: 24 } }), { running: false })).toContain("not running");
  });

  it("a plain catch-up is exactly what was missed, with no rule cutting through it", () => {
    const out = replayString(read({ live: "line one\r\nline two\r\n" }), { running: true });
    expect(out).toBe("line one\r\nline two\r\n");
  });

  it("has nothing to say when there is nothing", () => {
    expect(replayString(read(), { running: true })).toBe("");
    // An empty history block is not a block: no rules, no escape, nothing.
    expect(replayString(read({ history: { data: "", cols: 80, rows: 24 } }), { running: true })).toBe("");
  });
});

describe("the pane's state word", () => {
  it("says nothing at all once the pane is live", () => {
    expect(terminalStateWord({ running: true, replayed: false, liveSinceReplay: false })).toBeNull();
    // The moment the new shell prints anything the pane IS live, and a word there would be noise.
    expect(terminalStateWord({ running: true, replayed: true, liveSinceReplay: true })).toBeNull();
  });

  it("distinguishes a replayed screen from a dead one", () => {
    expect(terminalStateWord({ running: true, replayed: true, liveSinceReplay: false })).toBe("Replayed");
    expect(terminalStateWord({ running: false, replayed: true, liveSinceReplay: true })).toBe("Not running");
    expect(terminalStateWord({ running: false, replayed: false, liveSinceReplay: false })).toBe("Not running");
  });
});
