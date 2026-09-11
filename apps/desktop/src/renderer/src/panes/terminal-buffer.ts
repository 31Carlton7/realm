/** Holds pty output that arrives before an xterm instance is mounted (or while a pane is hidden). */
export class TerminalBuffer {
  private pending = ""; private sink: ((d: string) => void) | null = null;
  constructor(private maxChars = 200_000) {}
  push(d: string) {
    if (this.sink) return this.sink(d);
    this.pending += d;
    if (this.pending.length > this.maxChars) this.pending = this.pending.slice(-this.maxChars);
  }
  attach(sink: (d: string) => void) { this.sink = sink; if (this.pending) { sink(this.pending); this.pending = ""; } }
  /**
   * Throw away everything and put the terminal back to a known state.
   *
   * Used when the server says output was DROPPED between this client's cursor and now: a hole in the
   * middle of an escape sequence leaves xterm in a state nothing later corrects, so the pane starts
   * clean rather than replaying over it. RIS (`\x1bc`) rather than an `xterm.reset()` call because it
   * travels the same path as every other byte — it works identically whether the pane is mounted yet
   * or still buffering, which is the difference between one code path and two.
   */
  reset() { this.pending = ""; this.push("\x1bc"); }
  detach() { this.sink = null; }
}
