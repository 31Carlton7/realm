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
  detach() { this.sink = null; }
}
