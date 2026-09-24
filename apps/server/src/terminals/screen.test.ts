import { describe, expect, it } from "vitest";
import { MAX_SCROLLBACK_LINES, renderScreen, screenText } from "./screen";

const ESC = "\x1b";
/** Enter the alternate buffer, the way any full-screen program starts. */
const ALT_ON = `${ESC}[?1049h`;
const ALT_OFF = `${ESC}[?1049l`;
/** Move the caret to (row, col), 1-based, as a TUI addresses its own screen. */
const at = (row: number, col: number) => `${ESC}[${row};${col}H`;
const CLEAR = `${ESC}[2J`;

const size = { cols: 80, rows: 24 };

describe("renderScreen", () => {
  it("renders plain output as the lines it printed", async () => {
    const s = await renderScreen("hello\r\nworld\r\n", size);
    expect(s.screen).toEqual(["hello", "world", ""]);
    expect(s.altScreen).toBe(false);
  });

  it("drops the blank rows below the cursor but keeps the ones above it", async () => {
    // A gap a program DREW is content; the unused bottom of an 80x24 screen is not.
    const s = await renderScreen(`top\r\n\r\nbottom\r\n`, size);
    expect(s.screen).toEqual(["top", "", "bottom", ""]);
  });

  it("reports where the caret is, so a prompt is distinguishable from output in flight", async () => {
    const s = await renderScreen("$ ", size);
    expect(s.cursor).toEqual({ row: 0, col: 2 });
  });

  /**
   * The whole reason this module exists. A TUI repaints in place: the bytes contain both the line it
   * drew first and the line it replaced it with, and only an emulator knows which one is on screen.
   */
  it("shows what a repainting TUI left on screen, not everything it typed", async () => {
    const data = ALT_ON + CLEAR + at(1, 1) + "Waiting for your browser…"
      + at(1, 1) + `${ESC}[K` + "Paste the code here:";
    const s = await renderScreen(data, size);
    expect(s.screen[0]).toBe("Paste the code here:");
    expect(screenText(s)).not.toContain("Waiting for your browser");
    expect(s.altScreen).toBe(true);
  });

  it("says when a full-screen program is running, and stops saying so when it exits", async () => {
    expect((await renderScreen(ALT_ON + "in a TUI", size)).altScreen).toBe(true);
    expect((await renderScreen(ALT_ON + "in a TUI" + ALT_OFF, size)).altScreen).toBe(false);
  });

  it("keeps the alternate buffer's own screen out of the scrollback", async () => {
    const s = await renderScreen(ALT_ON + "only here", { ...size, scrollback: 50 });
    expect(s.scrollback).toEqual([]);
  });

  it("returns scrolled-off lines only when they were asked for", async () => {
    const data = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\r\n");
    const without = await renderScreen(data, size);
    expect(without.scrollback).toEqual([]);
    // No trailing newline, so 30 lines occupy 30 rows and a 24-row screen shows the last 24.
    expect(without.screen[0]).toBe("line 7");

    const withTail = await renderScreen(data, { ...size, scrollback: 3 });
    expect(withTail.scrollback).toEqual(["line 4", "line 5", "line 6"]);
    expect(withTail.screen[0]).toBe("line 7");
  });

  it("caps the scrollback it will return however much is asked for", async () => {
    const data = Array.from({ length: 900 }, (_, i) => `line ${i + 1}`).join("\r\n");
    const s = await renderScreen(data, { ...size, scrollback: 10_000 });
    expect(s.scrollback.length).toBe(MAX_SCROLLBACK_LINES);
  });

  /**
   * The case the rejoining exists for: this is the shape `claude auth login` prints, and a reader
   * handed three rows has to splice them back together without dropping a character at either seam.
   */
  it("gives back a wrapped URL whole", async () => {
    const url = `https://claude.ai/oauth/authorize?code=true&client_id=${"a".repeat(40)}&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&scope=user%3Ainference`;
    expect(url.length).toBeGreaterThan(80); // it really does wrap at any width anyone uses
    const s = await renderScreen(`Open this URL:\r\n${url}`, { cols: 80, rows: 24 });
    expect(s.screen).toEqual(["Open this URL:", url]);
  });

  it("counts the caret past the seam on a wrapped line", async () => {
    const s = await renderScreen("x".repeat(90), { cols: 80, rows: 24 });
    expect(s.screen).toEqual(["x".repeat(90)]);
    expect(s.cursor).toEqual({ row: 0, col: 90 });
  });

  it("keeps a hard newline as its own line", async () => {
    // The mirror of the test above: a wrap is joined, a line the program actually ended is not.
    const s = await renderScreen("first\r\nsecond", { cols: 80, rows: 24 });
    expect(s.screen).toEqual(["first", "second"]);
  });

  it("drops the styling rather than reporting it as text", async () => {
    const s = await renderScreen(`${ESC}[1;31mdanger${ESC}[0m`, size);
    expect(s.screen[0]).toBe("danger");
  });

  it("renders a carriage return as the overwrite it is", async () => {
    // A progress line: every frame lands on the same row, and only the last one is on screen.
    const s = await renderScreen("10%\r55%\r100%", size);
    expect(s.screen[0]).toBe("100%");
  });

  it("is empty, not an error, for a pty that has printed nothing", async () => {
    const s = await renderScreen("", size);
    expect(s.screen).toEqual([""]);
    expect(screenText(s)).toBe("");
  });
});
