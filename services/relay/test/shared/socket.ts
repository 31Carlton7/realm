/** A frame as a test reads it off the relay. */
export type Frame = { text: string } | { bytes: Uint8Array };

export type Closed = { code: number; reason: string };

/** The part of a WebSocket that workerd's and the `ws` package's have in common. */
export type WebSocketLike = {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close", listener: (event: { data?: unknown; code?: number; reason?: string }) => void): void;
};

/**
 * One client socket, with its frames queued so a test can read them in order whichever runtime
 * delivered them. Waiting uses one timer per wait, never the clock, so it keeps working while a
 * test has frozen or moved Date.
 */
export class TestSocket {
  readonly closed: Promise<Closed>;
  private readonly inbox: Frame[] = [];
  private ended: Closed | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly ws: WebSocketLike) {
    ws.addEventListener("message", ({ data }) => {
      this.inbox.push(typeof data === "string" ? { text: data } : { bytes: toBytes(data) });
      this.wake?.();
    });
    this.closed = new Promise((resolve) => {
      ws.addEventListener("close", ({ code, reason }) => {
        this.ended = { code: code ?? 0, reason: reason ?? "" };
        resolve(this.ended);
        this.wake?.();
      });
    });
  }

  send(data: string | Uint8Array): void {
    this.ws.send(data);
  }

  sendJson(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Starts a close, with `code` or with none. */
  close(code?: number): void {
    try {
      this.ws.close(code);
    } catch {
      // Already closed.
    }
  }

  /** The next frame. Fails if none comes within `ms`, or if the socket closes first. */
  async next(ms = 3_000): Promise<Frame> {
    if (this.inbox.length === 0 && !this.ended) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.wake = null;
          reject(new Error(`no frame within ${ms} ms`));
        }, ms);
        this.wake = () => {
          clearTimeout(timer);
          this.wake = null;
          resolve();
        };
      });
    }
    const frame = this.inbox.shift();
    if (!frame) throw new Error(`socket closed (${this.ended?.code} ${this.ended?.reason}) with no frame left`);
    return frame;
  }

  /** Loosely typed on purpose: a test inspects a control message field by field. */
  async json(ms?: number): Promise<any> {
    const frame = await this.next(ms);
    if (!("text" in frame)) throw new Error(`expected a text frame, got ${frame.bytes.byteLength} binary bytes`);
    return JSON.parse(frame.text);
  }

  async text(ms?: number): Promise<string> {
    const frame = await this.next(ms);
    if (!("text" in frame)) throw new Error(`expected a text frame, got ${frame.bytes.byteLength} binary bytes`);
    return frame.text;
  }

  async binary(ms?: number): Promise<Uint8Array> {
    const frame = await this.next(ms);
    if (!("bytes" in frame)) throw new Error(`expected a binary frame, got text ${frame.text}`);
    return frame.bytes;
  }

  /** How the relay closed this socket. Frames still unread are left alone. */
  async closeCode(ms = 3_000): Promise<number> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`not closed within ${ms} ms`)), ms);
    });
    try {
      return (await Promise.race([this.closed, timeout])).code;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Fails if a frame arrives, or is already waiting, within `ms`. */
  async quiet(ms = 150): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (this.inbox.length > 0) throw new Error(`expected silence, got ${describe(this.inbox[0]!)}`);
  }

  get isClosed(): boolean {
    return this.ended !== null;
  }
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error(`unexpected frame data: ${String(data)}`);
}

const describe = (frame: Frame): string => ("text" in frame ? frame.text : `${frame.bytes.byteLength} binary bytes`);
