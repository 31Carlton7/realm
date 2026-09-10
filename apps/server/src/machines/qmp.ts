import { connect, type Socket } from "node:net";

/**
 * QMP — QEMU's control channel (Plan 25 W5/W6).
 *
 * Line-delimited JSON over a unix socket. The protocol is small enough to write out and the two
 * things it does that a naive client gets wrong are worth naming, because both were measured:
 *
 *   - **The greeting is not a reply.** A server sends `{"QMP": {...}}` unprompted on connect, and a
 *     client that counts it as the answer to its first command is one reply out of step for the
 *     whole session.
 *   - **`qmp_capabilities` must come first.** Every other command is refused until it has, and the
 *     refusal is a generic "command not found", which reads as an unsupported QEMU.
 *
 * Not TCP, ever: a unix socket has filesystem permissions, and a QMP port on loopback is an
 * unauthenticated total-control channel — start, stop, screendump, synthetic input, disk — with no
 * token in front of it.
 */
export type QmpReply = { return?: unknown; error?: { class: string; desc: string } };

export class QmpClient {
  private sock: Socket | null = null;
  private buf = "";
  private ready: Promise<void> | null = null;
  /** In-flight commands, oldest first. QMP answers in order, so a queue is the whole correlation —
   *  the protocol has ids, but only if the client sends them, and order is simpler to be right. */
  private pending: { resolve: (r: QmpReply) => void; reject: (e: Error) => void }[] = [];
  private closed = false;

  constructor(private readonly path: string, private readonly timeoutMs = 10_000) {}

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("this QMP client is closed"));
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const s = connect(this.path);
      this.sock = s;
      let greeted = false;
      const timer = setTimeout(() => reject(new Error(`QEMU did not greet on ${this.path} within ${this.timeoutMs / 1000}s`)), this.timeoutMs);
      s.on("error", (e) => { clearTimeout(timer); this.failAll(e); reject(e); });
      s.on("close", () => { clearTimeout(timer); this.failAll(new Error("QEMU closed its control socket")); });
      s.on("data", (d) => {
        this.buf += d.toString("utf8");
        for (;;) {
          const i = this.buf.indexOf("\n");
          if (i < 0) return;
          const line = this.buf.slice(0, i).trim();
          this.buf = this.buf.slice(i + 1);
          if (!line) continue;
          let msg: Record<string, unknown>;
          try { msg = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          // The greeting, which is not a reply to anything. Counting it as one puts a client a reply
          // out of step for the rest of the session.
          if (msg.QMP !== undefined) {
            greeted = true;
            s.write(`${JSON.stringify({ execute: "qmp_capabilities" })}\n`);
            continue;
          }
          // An event, which arrives whenever QEMU feels like it and is never anybody's reply.
          if (msg.event !== undefined) continue;
          if (greeted && this.pending.length === 0) {
            // The `qmp_capabilities` answer. Nothing queued it, so nothing is waiting for it.
            clearTimeout(timer);
            resolve();
            continue;
          }
          this.pending.shift()?.resolve(msg as QmpReply);
        }
      });
    });
    return this.ready;
  }

  /** One command. Rejects on QEMU's own error rather than resolving with it, so a caller cannot
   *  mistake "the VM is not running" for "the input was delivered". */
  async command(execute: string, args?: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    const sock = this.sock;
    if (!sock || this.closed) throw new Error("QEMU's control socket is closed");
    const reply = await new Promise<QmpReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((p) => p !== entry);
        reject(new Error(`QEMU did not answer ${execute} within ${this.timeoutMs / 1000}s`));
      }, this.timeoutMs);
      const entry = {
        resolve: (r: QmpReply) => { clearTimeout(timer); resolve(r); },
        reject: (e: Error) => { clearTimeout(timer); reject(e); },
      };
      this.pending.push(entry);
      sock.write(`${JSON.stringify(args ? { execute, arguments: args } : { execute })}\n`);
    });
    if (reply.error) throw new Error(`${execute}: ${reply.error.desc}`);
    return reply.return;
  }

  close(): void {
    this.closed = true;
    this.ready = null;
    this.failAll(new Error("QEMU's control socket was closed"));
    this.sock?.destroy();
    this.sock = null;
  }

  private failAll(e: Error): void {
    for (const p of this.pending.splice(0)) p.reject(e);
  }
}
