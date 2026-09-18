import { Terminal } from "@xterm/headless";

/**
 * A pty's bytes, rendered into the screen a person would be looking at.
 *
 * The reason this exists at all: `terminals.read` hands back a raw tail, and a raw tail is the one
 * thing an agent cannot read. Every agent CLI worth signing into draws its login with a full-screen
 * TUI — `claude` and `codex` both do — so the bytes on the wire are cursor addressing, erases and
 * SGR runs whose *rendered* result is four lines and a URL. Stripping the escapes does not recover
 * those four lines; it produces the sequence of things the program typed and then untyped, in order,
 * which reads as gibberish and is worse than nothing because it looks like content.
 *
 * **Deliberately not on the hot path.** `scrollback.ts` writes down why it keeps a raw tail rather
 * than a headless emulator: "a second terminal parser on the hot path for every byte of every pty".
 * That judgement is untouched here. This parses ON DEMAND — one terminal, one read, when an agent
 * asks — and throws the emulator away afterwards. A pty nobody is reading costs exactly what it
 * cost before.
 *
 * The same file also anticipated this: "`history.data` is opaque to the client … so a serialized
 * screen can replace this later without changing a contract". This is the read side of that.
 */

/** How much scrollback one read may ask for. A cap rather than a preference: the lines are going
 *  into a model's context, and a terminal that has printed a `pnpm install` can offer tens of
 *  thousands of them. */
export const MAX_SCROLLBACK_LINES = 500;

/**
 * How long the parser is given before the read gives up and reports what it has.
 *
 * `write`'s callback fires when the data has been parsed, and xterm chunks its own parsing across
 * task boundaries — so this is a real await, not a formality. It resolves rather than throws: a
 * screen that is one chunk stale is a useful answer, and a tool call that hangs until the agent's
 * transport times out is not.
 */
const PARSE_TIMEOUT_MS = 2_000;

export type TerminalScreen = {
  /**
   * The visible screen as LOGICAL lines — soft-wrapped rows rejoined — with trailing whitespace gone.
   *
   * Rejoining is not cosmetic, and the login flow this was built for is the case that proves it. A
   * `claude auth login` URL is about two hundred characters and arrives split across three rows at
   * any terminal width anybody uses. Handed the rows, a reader has to concatenate them and hope it
   * did not drop a character at a seam — and a URL reassembled wrong is a sign-in that fails with
   * nothing on screen to explain why. The wrap is an artifact of how wide the pane happens to be,
   * not something the program said, and xterm tracks it exactly (`isWrapped`), so the seam is
   * removed where it is known rather than guessed at downstream.
   *
   * Blank lines below the cursor are dropped — a 24-row screen holding a two-line prompt is two
   * lines, not two lines and twenty-two empty strings. Blank lines ABOVE the cursor stay, because a
   * TUI that drew a gap drew a gap.
   */
  screen: string[];
  /** Lines that have scrolled off the top, oldest first, rejoined the same way. Empty unless the
   *  read asked for them, and always empty while `altScreen` is set — the alternate buffer has no
   *  scrollback, by design. */
  scrollback: string[];
  /** Where the caret sits: a row index into `screen`, and a column into that logical line (so on a
   *  wrapped line it counts past the seam). This is how an agent tells a shell sitting at its prompt
   *  from one halfway through printing. */
  cursor: { row: number; col: number };
  cols: number;
  rows: number;
  /**
   * The program has switched to the alternate buffer: something full-screen is running right now.
   *
   * Worth reporting rather than hiding, because it changes what the caller should do with the rest
   * of this object. On the alternate buffer the screen IS the whole state — there is no history
   * above it and no prompt to wait for, so "wait until the shell goes quiet" is the wrong question
   * and "read the screen" is the right one.
   */
  altScreen: boolean;
};

/** Render `data` — a pty's output from the beginning of the run, or as much of it as the ring
 *  still holds — at the size the pane is showing it at. */
export async function renderScreen(
  data: string,
  opts: { cols: number; rows: number; scrollback?: number },
): Promise<TerminalScreen> {
  const cols = clamp(opts.cols, 2, 500);
  const rows = clamp(opts.rows, 1, 500);
  const want = clamp(opts.scrollback ?? 0, 0, MAX_SCROLLBACK_LINES);
  // `scrollback: 0` would drop every line the moment it scrolls, so the emulator is only given room
  // for what this read is actually going to return.
  const term = new Terminal({ cols, rows, scrollback: want, allowProposedApi: true });
  try {
    await write(term, data);
    const buf = term.buffer.active;
    const altScreen = buf.type === "alternate";
    const top = buf.baseY;

    /**
     * Physical rows `[from, to)` folded into logical lines, plus where each row ended up.
     *
     * The very first row is never treated as a continuation even when xterm says it is wrapped: its
     * head is above the range being read, so there is nothing here to join it to, and appending it
     * to whatever happened to precede it in the output would invent a line neither half is.
     */
    const fold = (from: number, to: number): { lines: string[]; rowOf: number[] } => {
      const lines: string[] = [];
      const rowOf: number[] = [];
      for (let y = from; y < to; y++) {
        const row = buf.getLine(y);
        const text = row?.translateToString(true) ?? "";
        if (y > from && row?.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
        else lines.push(text);
        rowOf.push(lines.length - 1);
      }
      return { lines, rowOf };
    };

    const visible = fold(top, top + rows);
    const screen = visible.lines;
    const cursorRow = visible.rowOf[clamp(buf.cursorY, 0, rows - 1)] ?? 0;
    // Past the seam: every physical row folded into this line before the caret's own contributed a
    // full `cols` of characters to it.
    const rowsBefore = clamp(buf.cursorY, 0, rows - 1) - visible.rowOf.indexOf(cursorRow);
    const cursor = { row: cursorRow, col: rowsBefore * cols + clamp(buf.cursorX, 0, cols) };
    // Never below the cursor's own line: a caret on line 7 of a screen trimmed to 3 is a position
    // into a string that is not there.
    while (screen.length > cursor.row + 1 && screen[screen.length - 1] === "") screen.pop();

    // The alternate buffer's `baseY` is 0 and it keeps no history, so this is empty there anyway —
    // but saying so costs nothing and stops a reader wondering.
    const scrollbackLines = altScreen ? [] : fold(Math.max(0, top - want), top).lines;

    return { screen, scrollback: scrollbackLines, cursor, cols, rows, altScreen };
  } finally {
    term.dispose();
  }
}

/** The screen as one block of text, which is what a tool result carries. */
export function screenText(s: TerminalScreen): string {
  return [...s.scrollback, ...s.screen].join("\n");
}

function write(term: Terminal, data: string): Promise<void> {
  if (data === "") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, PARSE_TIMEOUT_MS);
    term.write(data, () => { clearTimeout(timer); resolve(); });
  });
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(n)));
