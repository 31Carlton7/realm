import type { VmAction } from "@realm/contracts";
import { KEYSYMS, keysymForChar, parseChord } from "@realm/contracts";
import { dial, describeDialError, type ByteChannel } from "./dial";
import { handshakeStep, type HandshakeState } from "./rfb-handshake";
import {
  applyUpdate, blankFrame, downscale, encodePng, keyEventMessage, pointerEventMessage,
  setEncodingsMessage, setPixelFormatMessage, updateRequestMessage, type Frame,
} from "./framebuffer";
import { SCREENSHOT_MAX_EDGE, type DriverFrame, type MachineDriver } from "./driver";
import type { MachineTarget } from "./ws-proxy";

/**
 * A server-side RFB client, so an agent can look at a machine and press things on it (Plan 25 W4).
 *
 * This is the real protocol work in the plan, and it is what makes "connect a MacBook and let an
 * agent control it" true rather than view-only. It shares the handshake and the four transports with
 * the human's relay and nothing else: where the relay is a pipe that never looks at a byte after the
 * handshake, this one decodes.
 *
 * **The connection is persistent and lazily opened.** A handshake per screenshot would be a second
 * or more of latency on every look, and a Mac counts each one as a new screen-sharing session — the
 * far end's own indicator would blink once per agent action.
 *
 * **What an agent gets here is pixels and coordinates, and that is a real reduction.** The browser
 * and computer providers hand back a tree with indices, and every good property they have comes from
 * it: acting by `[ref=N]`, re-resolving at act time, refusing a stale ref, a card that can name the
 * element. None of that exists over RFB. A click at (412,300) always "succeeds" and may have hit
 * nothing at all. `agent-tools.ts` carries the three mitigations that stand in for it.
 */
export class RfbDriver implements MachineDriver {
  private channel: ByteChannel | null = null;
  private connecting: Promise<void> | null = null;
  private frame: Frame = blankFrame(0, 0);
  private buf = Buffer.alloc(0);
  private piping = false;
  private closed = false;
  /**
   * Waiting on the next complete framebuffer update.
   *
   * Both halves are kept, and that is the whole point: a connection that DROPS while a screenshot is
   * pending must fail it, not settle it. Waking a waiter with `resolve` on close hands the caller
   * the last frame — or a blank one — as though the machine had answered, which is a screenshot of
   * a screen nobody is looking at, reported as current.
   */
  private waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private failure: string | null = null;

  constructor(private readonly target: MachineTarget, private readonly deadlineMs = 15_000) {}

  async screenshot(): Promise<DriverFrame> {
    await this.connect();
    this.write(updateRequestMessage(this.frame.width, this.frame.height, false));
    await this.nextFrame();
    const small = downscale(this.frame, SCREENSHOT_MAX_EDGE);
    return {
      data: encodePng(small),
      // The FRAMEBUFFER's size, not the image's. An agent addresses the screen in framebuffer
      // pixels, and reporting the downscaled size would teach it a coordinate space the machine
      // does not have — every click landing proportionally short of where it meant.
      width: this.frame.width, height: this.frame.height,
      imageWidth: small.width, imageHeight: small.height,
    };
  }

  async act(action: VmAction): Promise<string> {
    await this.connect();
    switch (action.kind) {
      case "click": {
        const mask = action.button === "right" ? 4 : action.button === "middle" ? 2 : 1;
        // Move, press, release — as three messages, because RFB has no click: a button mask that
        // went straight from 0 to pressed at a new position is a drag from wherever the pointer was.
        this.write(pointerEventMessage(action.x, action.y, 0));
        this.write(pointerEventMessage(action.x, action.y, mask));
        this.write(pointerEventMessage(action.x, action.y, 0));
        return `clicked ${action.button} at (${action.x},${action.y})`;
      }
      case "scroll": {
        // RFB has no wheel either: buttons 4 and 5 ARE the wheel, one press per notch. The count is
        // bounded because a model that meant "scroll a long way" and wrote 100000 would otherwise
        // hold the connection for minutes.
        const up = action.deltaY < 0;
        const notches = Math.min(20, Math.max(1, Math.round(Math.abs(action.deltaY) / 100)));
        for (let i = 0; i < notches; i++) {
          this.write(pointerEventMessage(action.x, action.y, up ? 8 : 16));
          this.write(pointerEventMessage(action.x, action.y, 0));
        }
        return `scrolled ${up ? "up" : "down"} ${notches} notch(es) at (${action.x},${action.y})`;
      }
      case "key": {
        const chord = parseChord(action.key);
        if (!chord) throw new Error(`"${action.key}" is not a key Realm can send. Use a chord like "cmd+c", or a named key.`);
        // Modifiers down in order, key, modifiers up in reverse — a guest that received them in any
        // other order sees a chord it was never sent.
        for (const m of chord.modifiers) this.write(keyEventMessage(m, true));
        this.write(keyEventMessage(chord.key, true));
        this.write(keyEventMessage(chord.key, false));
        for (const m of [...chord.modifiers].reverse()) this.write(keyEventMessage(m, false));
        return `pressed ${action.key}`;
      }
      case "type": {
        for (const ch of action.text) {
          const sym = keysymForChar(ch);
          // The caller already refused untypeable text (`agent-tools.ts`), so this is the belt to
          // that braces — and it throws rather than skipping, because a character silently dropped
          // out of the middle of a password or a path is the worst outcome available.
          if (sym === null) throw new Error(`cannot type ${JSON.stringify(ch)} — a keysym names a KEY, and which character it produces depends on the guest's own layout`);
          const shift = needsShift(ch);
          if (shift) this.write(keyEventMessage(KEYSYMS.Shift!, true));
          this.write(keyEventMessage(sym, true));
          this.write(keyEventMessage(sym, false));
          if (shift) this.write(keyEventMessage(KEYSYMS.Shift!, false));
        }
        return `typed ${action.text.length} character(s)`;
      }
    }
  }

  close(): void {
    this.closed = true;
    this.channel?.close();
    this.channel = null;
    this.piping = false;
    this.connecting = null;
    for (const w of this.waiters.splice(0)) w.reject(new Error("this machine's driver was closed"));
  }

  /* ------------------------------- internals ------------------------------- */

  private write(b: Buffer): void {
    if (!this.channel || !this.piping) throw new Error("the machine is not connected");
    this.channel.write(b);
  }

  /** Idempotent and re-entrant: several tool calls arriving at once share one handshake rather than
   *  opening several sockets to the same screen. */
  private connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("this machine's driver is closed"));
    if (this.piping) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const ch = dial(this.target);
      this.channel = ch;
      this.failure = null;
      let state: HandshakeState = { phase: "version" };
      let settled = false;
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        this.failure = msg;
        this.connecting = null;
        ch.close();
        if (this.channel === ch) this.channel = null;
        reject(new Error(msg));
      };
      const timer = setTimeout(() => fail(`the machine did not answer within ${this.deadlineMs / 1000}s`), this.deadlineMs);

      ch.onError((e) => fail(describeDialError(this.target, e)));
      ch.onClose(() => {
        clearTimeout(timer);
        this.piping = false;
        if (this.channel === ch) this.channel = null;
        // Fail anything waiting on a frame that is never coming. REJECT rather than resolve: a
        // screenshot settled by a disconnect would hand back the last frame, or a blank one, as
        // though the machine had answered.
        for (const w of this.waiters.splice(0)) w.reject(new Error("the machine closed the connection"));
        fail(this.failure ?? "the machine closed the connection");
      });
      ch.onData((chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        if (!this.piping) {
          for (;;) {
            const step = handshakeStep(state, this.buf, this.target.password);
            if (step.kind === "wait") return;
            if (step.kind === "fail") { clearTimeout(timer); fail(step.detail); return; }
            if (step.kind === "done") {
              clearTimeout(timer);
              settled = true;
              this.buf = this.buf.subarray(step.consumed);
              this.frame = blankFrame(step.width, step.height);
              this.piping = true;
              // Format and encodings before anything is requested: a server that has not been told
              // otherwise sends its OWN native format, which may be a palette or 16bpp 565.
              ch.write(setPixelFormatMessage());
              ch.write(setEncodingsMessage());
              this.connecting = null;
              resolve();
              // Whatever arrived glued to the ServerInit is a message; fall through to consume it.
              break;
            }
            if (step.bytes.length) ch.write(step.bytes);
            this.buf = this.buf.subarray(step.consumed);
            state = step.state;
          }
        }
        this.consume();
      });
    });
    return this.connecting;
  }

  /** Drain complete server messages out of the buffer. */
  private consume(): void {
    for (;;) {
      if (this.buf.length < 1) return;
      const type = this.buf[0];
      if (type === 0) {
        const r = applyUpdate(this.frame, this.buf);
        if (!r) return;
        this.buf = this.buf.subarray(r.consumed);
        for (const w of this.waiters.splice(0)) w.resolve();
        continue;
      }
      // The three other server→client messages, skipped by their own lengths. Skipped rather than
      // ignored: leaving one in the buffer would make every later message read at the wrong offset.
      if (type === 1) {                                        // SetColourMapEntries
        if (this.buf.length < 6) return;
        const n = this.buf.readUInt16BE(4);
        if (this.buf.length < 6 + n * 6) return;
        this.buf = this.buf.subarray(6 + n * 6);
        continue;
      }
      if (type === 2) { this.buf = this.buf.subarray(1); continue; }   // Bell
      if (type === 3) {                                               // ServerCutText
        if (this.buf.length < 8) return;
        const len = this.buf.readUInt32BE(4);
        if (this.buf.length < 8 + len) return;
        this.buf = this.buf.subarray(8 + len);
        continue;
      }
      // Something this client cannot measure. The stream is unreadable from here, so the connection
      // is dropped rather than left to read every later message at a wrong offset forever.
      this.buf = Buffer.alloc(0);
      this.channel?.close();
      return;
    }
  }

  private nextFrame(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error("the machine did not send a frame — it may be suspended, or its screen may be asleep"));
      }, this.deadlineMs);
      const waiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (e: Error) => { clearTimeout(timer); reject(e); },
      };
      this.waiters.push(waiter);
    });
  }
}

/**
 * Does this character need Shift held to produce it?
 *
 * A best effort against a US layout, and it has to be one: RFB sends a KEY, and which character it
 * produces is the guest's business. Most servers ignore the modifier state for a keysym that already
 * names an uppercase letter or a symbol — but some drive a virtual keyboard where the difference is
 * real, and sending Shift for `A` is harmless on the ones that do not care while being necessary on
 * the ones that do.
 */
function needsShift(ch: string): boolean {
  return /[A-Z]/.test(ch) || '~!@#$%^&*()_+{}|:"<>?'.includes(ch);
}
