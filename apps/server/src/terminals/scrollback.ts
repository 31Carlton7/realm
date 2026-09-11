/**
 * What a terminal printed, kept so that reattaching to one is not the same as losing it.
 *
 * `terminal.data` has always been a fire-and-forget broadcast with no cursor: bytes that arrived
 * while nobody was listening were simply gone. That was survivable while the server died with the
 * app, because "nobody listening" meant "nothing running". With a daemon it is the ordinary case —
 * every reattach is output that arrived with no client — and a dropped socket for two seconds loses
 * whatever the shell said in those two seconds, permanently.
 *
 * **A raw tail, not a headless emulator.** `@xterm/headless` with a serialize addon would give a
 * cleaner screen, at the price of a second terminal parser on the hot path for every byte of every
 * pty. `history.data` is opaque to the client — it is replayed into xterm, never inspected — so a
 * serialized screen can replace this later without changing a contract or a line of renderer code.
 *
 * Pure, with no IO at all: the flushing and the SQL live in the service and the store.
 */

/** Where a client got to. `runId` is what makes it meaningful — see `read`. */
export type ScrollbackCursor = { runId: string; seq: number };

/** The screen a previous pty left behind, and the size it was printed at. */
export type ScrollbackHistory = { data: string; cols: number; rows: number };

export type ScrollbackRead = {
  /** This pty's id. A client holding a different one has been talking about a shell that is gone. */
  runId: string;
  /** The newest chunk in `live`; the client's next cursor. */
  seq: number;
  /** Output the client has not seen, concatenated. */
  live: string;
  /** The ring dropped bytes between the client's cursor and `live`. The pane resets before replaying:
   *  a gap in the middle of an escape sequence would leave xterm in a state nothing else corrects. */
  truncated: boolean;
  /** Whether a pty is attached right now. */
  running: boolean;
  /** The previous run's screen, sent only when the client has no usable cursor — a first attach, a
   *  server that restarted, a pty that exited and respawned. A client that IS caught up already has
   *  this on screen and must not be sent it twice. */
  history: ScrollbackHistory | null;
};

/**
 * How much output one terminal keeps in memory, in characters.
 *
 * Characters and not bytes because node-pty hands `onData` an already-decoded string, so a cap in
 * bytes would be a cap on something this code never sees — and the number people mean by "how much
 * scrollback" is screens, which characters approximate and bytes do not.
 */
export const RING_CHARS = 128 * 1024;

type Chunk = { seq: number; data: string };

/** One terminal's buffer. */
class Ring {
  runId: string;
  running = true;
  cols: number;
  rows: number;
  history: ScrollbackHistory | null;
  private chunks: Chunk[] = [];
  private chars = 0;
  private seq = 0;
  /** True once anything has been evicted: a reader with no cursor cannot be told this is complete. */
  private evicted = false;

  constructor(runId: string, size: { cols: number; rows: number }, history: ScrollbackHistory | null) {
    this.runId = runId;
    this.cols = size.cols;
    this.rows = size.rows;
    this.history = history;
  }

  append(data: string): number {
    if (data === "") return this.seq;
    this.chunks.push({ seq: ++this.seq, data });
    this.chars += data.length;
    while (this.chars > RING_CHARS && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      if (!dropped) break;
      this.chars -= dropped.data.length;
      this.evicted = true;
    }
    return this.seq;
  }

  /** Everything retained, as one string. */
  all(): string {
    return this.chunks.map((c) => c.data).join("");
  }

  after(seq: number): string {
    return this.chunks.filter((c) => c.seq > seq).map((c) => c.data).join("");
  }

  /** The oldest seq still retained, or 0 when nothing is. */
  get oldest(): number {
    return this.chunks[0]?.seq ?? 0;
  }

  get newest(): number {
    return this.seq;
  }

  get lostAnything(): boolean {
    return this.evicted;
  }
}

export class Scrollback {
  private rings = new Map<string, Ring>();

  /**
   * A pty is starting. Call this BEFORE spawning it — a shell can print its prompt before
   * `manager.create` has even returned, and a chunk appended to no ring is a chunk that never
   * happened.
   *
   * `history` is the screen the previous run left: handed in at boot from the database, and taken
   * from the live buffer when a pty exits and respawns inside one server's life.
   */
  newRun(terminalId: string, runId: string, size: { cols: number; rows: number }, history?: ScrollbackHistory | null): void {
    const previous = this.rings.get(terminalId);
    const carried = history !== undefined
      ? history
      : previous && previous.all() !== ""
        ? { data: previous.all(), cols: previous.cols, rows: previous.rows }
        : previous?.history ?? null;
    this.rings.set(terminalId, new Ring(runId, size, carried));
  }

  append(terminalId: string, data: string): { runId: string; seq: number } | null {
    const ring = this.rings.get(terminalId);
    if (!ring) return null;
    return { runId: ring.runId, seq: ring.append(data) };
  }

  /** The pty exited. The buffer stays — its last screen is what a reattaching pane shows. */
  endRun(terminalId: string): void {
    const ring = this.rings.get(terminalId);
    if (ring) ring.running = false;
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const ring = this.rings.get(terminalId);
    if (!ring) return;
    ring.cols = cols; ring.rows = rows;
  }

  forget(terminalId: string): void {
    this.rings.delete(terminalId);
  }

  /** What to persist for this terminal, or null when there is nothing worth writing. */
  snapshot(terminalId: string): ScrollbackHistory | null {
    const ring = this.rings.get(terminalId);
    if (!ring) return null;
    const data = ring.all();
    if (data === "") return ring.history;
    return { data, cols: ring.cols, rows: ring.rows };
  }

  ids(): string[] {
    return [...this.rings.keys()];
  }

  /**
   * What this client is missing.
   *
   * **A cursor whose `runId` differs is treated as absent.** One rule covers three situations that
   * would otherwise each need their own branch in the renderer: the server restarted, the pty exited
   * and respawned, and this client has never seen this terminal. In all three the client's seq means
   * nothing, and in all three the right answer is the same — the previous screen, then everything
   * since.
   */
  read(terminalId: string, cursor: ScrollbackCursor | null): ScrollbackRead | null {
    const ring = this.rings.get(terminalId);
    if (!ring) return null;
    const usable = cursor !== null && cursor.runId === ring.runId;
    if (!usable) {
      return {
        runId: ring.runId, seq: ring.newest, live: ring.all(),
        truncated: ring.lostAnything, running: ring.running, history: ring.history,
      };
    }
    // Caught up or behind but still inside the ring: just the tail, and no history — the client
    // already has everything before it on screen, and sending it again would draw it twice.
    if (cursor.seq >= ring.oldest - 1) {
      return {
        runId: ring.runId, seq: ring.newest, live: ring.after(cursor.seq),
        truncated: false, running: ring.running, history: null,
      };
    }
    // Behind by more than the ring holds. There is a hole, and a hole in the middle of an escape
    // sequence is a pane xterm cannot recover on its own — so say so and let the pane reset.
    return {
      runId: ring.runId, seq: ring.newest, live: ring.all(),
      truncated: true, running: ring.running, history: null,
    };
  }
}
