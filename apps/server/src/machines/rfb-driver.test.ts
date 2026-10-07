import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RfbDriver } from "./rfb-driver";
import { DRIVER_PIXEL_FORMAT } from "./framebuffer";
import type { MachineTarget } from "./ws-proxy";

/**
 * The agent's own channel, against a real RFB server.
 *
 * Everything asserted here is either a byte the guest receives or a pixel the model sees, because
 * those are the only two things this class is for — and both are the kind of claim that is true
 * against a socket or not true at all.
 */

const FB = { width: 40, height: 30 };
const servers: { close(): void }[] = [];
const drivers: RfbDriver[] = [];
afterEach(() => {
  for (const d of drivers.splice(0)) d.close();
  for (const s of servers.splice(0)) s.close();
});

/** Records everything the client sends after the handshake, and answers update requests. */
function fakeVnc(opts: { colour?: [number, number, number]; mute?: boolean; extra?: Buffer } = {}) {
  const messages: Buffer[] = [];
  let sock: Socket | null = null;
  const server: Server = createServer((s) => {
    sock = s;
    s.setNoDelay(true);
    let phase = "version", buf = Buffer.alloc(0);
    s.write(Buffer.from("RFB 003.008\n", "latin1"));
    s.on("error", () => {});
    s.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (phase === "version") { if (buf.length < 12) return; buf = buf.subarray(12); s.write(Buffer.from([1, 1])); phase = "sec"; continue; }
        if (phase === "sec") { if (buf.length < 1) return; buf = buf.subarray(1); s.write(Buffer.from([0, 0, 0, 0])); phase = "init"; continue; }
        if (phase === "init") {
          if (buf.length < 1) return;
          buf = buf.subarray(1);
          const name = Buffer.from("fake", "utf8");
          const b = Buffer.alloc(24 + name.length);
          b.writeUInt16BE(FB.width, 0); b.writeUInt16BE(FB.height, 2);
          b[4] = 32; b[5] = 24; b[6] = 0; b[7] = 1;
          b.writeUInt16BE(255, 8); b.writeUInt16BE(255, 10); b.writeUInt16BE(255, 12);
          b[14] = 16; b[15] = 8; b[16] = 0;
          b.writeUInt32BE(name.length, 20); name.copy(b, 24);
          s.write(opts.extra ? Buffer.concat([b, opts.extra]) : b);
          phase = "msg";
          continue;
        }
        if (buf.length < 1) return;
        const type = buf[0]!;
        const sizes: Record<number, number> = { 0: 20, 4: 8, 5: 6 };
        if (type === 2) {
          if (buf.length < 4) return;
          const n = buf.readUInt16BE(2);
          if (buf.length < 4 + n * 4) return;
          messages.push(buf.subarray(0, 4 + n * 4)); buf = buf.subarray(4 + n * 4); continue;
        }
        if (type === 3) {
          if (buf.length < 10) return;
          messages.push(buf.subarray(0, 10)); buf = buf.subarray(10);
          if (!opts.mute) s.write(fullFrame(opts.colour ?? [200, 100, 50]));
          continue;
        }
        const n = sizes[type];
        if (n === undefined) return;
        if (buf.length < n) return;
        messages.push(buf.subarray(0, n)); buf = buf.subarray(n); continue;
      }
    });
  });
  return {
    server, messages,
    listen: () => new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port))),
    close: () => { sock?.destroy(); server.close(); },
  };
}

function fullFrame([r, g, b]: [number, number, number]): Buffer {
  const head = Buffer.alloc(16);
  head[0] = 0; head.writeUInt16BE(1, 2);
  head.writeUInt16BE(0, 4); head.writeUInt16BE(0, 6);
  head.writeUInt16BE(FB.width, 8); head.writeUInt16BE(FB.height, 10);
  head.writeInt32BE(0, 12);
  const px = Buffer.alloc(FB.width * FB.height * 4);
  for (let i = 0; i < FB.width * FB.height; i++) { px[i * 4] = b; px[i * 4 + 1] = g; px[i * 4 + 2] = r; }
  return Buffer.concat([head, px]);
}

const target = (port: number): MachineTarget => ({ transport: "tcp", host: "127.0.0.1", port, path: "/websockify", password: null });
const make = (port: number) => { const d = new RfbDriver(target(port), 4000); drivers.push(d); return d; };
const typed = (msgs: Buffer[], type: number) => msgs.filter((m) => m[0] === type);
/** `act` returns when the bytes are written, not when they arrive — the socket in between is real. */
const settle = async (p: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!p() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
  return p();
};

describe("the agent's channel", () => {
  it("takes a screenshot, and reports the FRAMEBUFFER's size beside the image's", async () => {
    const vnc = fakeVnc({ colour: [200, 100, 50] });
    servers.push(vnc);
    const d = make(await vnc.listen());
    const shot = await d.screenshot();
    expect([...shot.data.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    /* The framebuffer's size, not the image's — an agent addresses the SCREEN in these, and
       reporting the downscaled size would teach it a coordinate space the machine does not have,
       with every click landing proportionally short of where it meant. */
    expect(shot.width).toBe(FB.width);
    expect(shot.height).toBe(FB.height);
    expect(shot.imageWidth).toBe(FB.width);   // small enough that nothing was downscaled
  });

  it("tells the server which format and encoding to use before asking for anything", async () => {
    const vnc = fakeVnc();
    servers.push(vnc);
    const d = make(await vnc.listen());
    await d.screenshot();
    const order = vnc.messages.map((m) => m[0]);
    // A server that has not been told otherwise sends its OWN native format, which may be a palette
    // or 16bpp 565 — so both must land before the first request, not merely at some point.
    expect(order.indexOf(0)).toBeLessThan(order.indexOf(3));
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(3));
    const fmt = typed(vnc.messages, 0)[0]!;
    expect(fmt[4]).toBe(DRIVER_PIXEL_FORMAT.bitsPerPixel);
    expect(fmt[6]).toBe(0);
    expect(typed(vnc.messages, 3)[0]![1]).toBe(0);   // the WHOLE screen, not a diff
  });

  it("reuses one connection across calls rather than handshaking per screenshot", async () => {
    const vnc = fakeVnc();
    servers.push(vnc);
    const d = make(await vnc.listen());
    await d.screenshot();
    await d.screenshot();
    await d.screenshot();
    // A handshake per look is a second of latency each time — and on a Mac, a new screen-sharing
    // session each time, whose indicator would blink once per agent action.
    expect(typed(vnc.messages, 0)).toHaveLength(1);
    expect(typed(vnc.messages, 3)).toHaveLength(3);
  });

  it("shares one handshake between calls that arrive together", async () => {
    const vnc = fakeVnc();
    servers.push(vnc);
    const d = make(await vnc.listen());
    await Promise.all([d.screenshot(), d.screenshot(), d.screenshot()]);
    expect(typed(vnc.messages, 0)).toHaveLength(1);
  });

  it("consumes bytes glued to the ServerInit rather than reading every later message at a wrong offset", async () => {
    // A Bell, arriving in the same write as the ServerInit. Left in the buffer it would be read as
    // the first byte of the next message, forever.
    const vnc = fakeVnc({ extra: Buffer.from([2]) });
    servers.push(vnc);
    const d = make(await vnc.listen());
    const shot = await d.screenshot();
    expect(shot.width).toBe(FB.width);
  });
});

describe("what the guest actually receives", () => {
  it("sends a click as move, press, release — because RFB has no click", async () => {
    const vnc = fakeVnc();
    servers.push(vnc);
    const d = make(await vnc.listen());
    await d.screenshot();
    const before = typed(vnc.messages, 5).length;
    expect(await d.act({ kind: "click", x: 12, y: 7, button: "left" })).toContain("(12,7)");
    expect(await settle(() => typed(vnc.messages, 5).length >= before + 3)).toBe(true);
    const ptr = typed(vnc.messages, 5).slice(before);
    /* Three messages, and the first one matters: a button mask that went straight from 0 to pressed
       at a NEW position is a drag from wherever the pointer happened to be. */
    expect(ptr).toHaveLength(3);
    expect([...ptr[0]!]).toEqual([5, 0, 0, 12, 0, 7]);
    expect(ptr[1]![1]).toBe(1);
    expect(ptr[2]![1]).toBe(0);
    for (const m of ptr) { expect(m.readUInt16BE(2)).toBe(12); expect(m.readUInt16BE(4)).toBe(7); }
  });

  it("maps the right button to the right mask", async () => {
    const vnc = fakeVnc();
    servers.push(vnc);
    const d = make(await vnc.listen());
    await d.screenshot();
    for (const [button, mask] of [["left", 1], ["middle", 2], ["right", 4]] as const) {
      const before = typed(vnc.messages, 5).length;
      await d.act({ kind: "click", x: 1, y: 1, button });
      expect(await settle(() => typed(vnc.messages, 5).length >= before + 3), button).toBe(true);
      expect(typed(vnc.messages, 5)[before + 1]![1], button).toBe(mask);
    }
  });

  /* RFB has no wheel: buttons 4 and 5 ARE the wheel, one press per notch. */
  it("sends a scroll as wheel-button presses, on the side the delta's sign names", async () => {
    const vnc = fakeVnc();
    servers.push(vnc);
    const d = make(await vnc.listen());
    await d.screenshot();
    const before = typed(vnc.messages, 5).length;
    await d.act({ kind: "scroll", x: 5, y: 5, deltaY: -300 });
    expect(await settle(() => typed(vnc.messages, 5).length >= before + 6)).toBe(true);
    const up = typed(vnc.messages, 5).slice(before).filter((m) => m[1] !== 0);
    expect(up.every((m) => m[1] === 8), "button 4 is up").toBe(true);
    expect(up).toHaveLength(3);

    const before2 = typed(vnc.messages, 5).length;
    await d.act({ kind: "scroll", x: 5, y: 5, deltaY: 100 });
    expect(await settle(() => typed(vnc.messages, 5).length >= before2 + 2)).toBe(true);
    expect(typed(vnc.messages, 5).slice(before2).filter((m) => m[1] !== 0).every((m) => m[1] === 16)).toBe(true);
  });

  it("bounds a scroll a model asked for in absurd units", async () => {
    // "Scroll a long way" written as 100000 would otherwise hold the connection for minutes.
    const vnc = fakeVnc();
    servers.push(vnc);
    const d = make(await vnc.listen());
    await d.screenshot();
    const before = typed(vnc.messages, 5).length;
    await d.act({ kind: "scroll", x: 1, y: 1, deltaY: 100000 });
    expect(await settle(() => typed(vnc.messages, 5).length >= before + 40)).toBe(true);
    expect(typed(vnc.messages, 5).slice(before).filter((m) => m[1] !== 0)).toHaveLength(20);
  });

  it("holds a chord's modifiers around its key, and releases them in reverse", async () => {
    const vnc = fakeVnc();
    servers.push(vnc);
    const d = make(await vnc.listen());
    await d.screenshot();
    const before = typed(vnc.messages, 4).length;
    await d.act({ kind: "key", key: "ctrl+alt+Delete" });
    expect(await settle(() => typed(vnc.messages, 4).length >= before + 6)).toBe(true);
    const keys = typed(vnc.messages, 4).slice(before).map((m) => [m[1], m.readUInt32BE(4)]);
    // Down in order, key, up in REVERSE — a guest that received them any other way sees a chord it
    // was never sent.
    expect(keys).toEqual([
      [1, 0xffe3], [1, 0xffe9], [1, 0xffff], [0, 0xffff], [0, 0xffe9], [0, 0xffe3],
    ]);
  });

  it("types Latin-1 as its own code points, and shifts what needs shifting", async () => {
    const vnc = fakeVnc();
    servers.push(vnc);
    const d = make(await vnc.listen());
    await d.screenshot();
    const before = typed(vnc.messages, 4).length;
    await d.act({ kind: "type", text: "aB" });
    expect(await settle(() => typed(vnc.messages, 4).length >= before + 6)).toBe(true);
    const keys = typed(vnc.messages, 4).slice(before).map((m) => [m[1], m.readUInt32BE(4)]);
    expect(keys).toEqual([
      [1, 0x61], [0, 0x61],                                   // a
      [1, 0xffe1], [1, 0x42], [0, 0x42], [0, 0xffe1],         // B, inside Shift
    ]);
  });

  /* A character silently dropped out of the middle of a password or a path is the worst outcome
     available — worse than a refusal, because nothing anywhere says it happened. */
  it("throws rather than dropping a character it cannot say", async () => {
    const vnc = fakeVnc();
    servers.push(vnc);
    const d = make(await vnc.listen());
    await d.screenshot();
    await expect(d.act({ kind: "type", text: "ok →" })).rejects.toThrow(/keysym names a KEY/);
  });

  it("refuses a chord it cannot make rather than pressing part of one", async () => {
    const vnc = fakeVnc();
    servers.push(vnc);
    const d = make(await vnc.listen());
    await d.screenshot();
    await expect(d.act({ kind: "key", key: "hyper+q" })).rejects.toThrow(/not a key Realm can send/);
  });
});

describe("when the machine will not answer", () => {
  it("gives up on a screen that never arrives, rather than hanging a tool call forever", async () => {
    const vnc = fakeVnc({ mute: true });
    servers.push(vnc);
    const d = new RfbDriver(target(await vnc.listen()), 600);
    drivers.push(d);
    await expect(d.screenshot()).rejects.toThrow(/did not send a frame/);
  });

  it("names a port with nothing behind it", async () => {
    const dead = createServer();
    const port = await new Promise<number>((r) => dead.listen(0, "127.0.0.1", () => r((dead.address() as { port: number }).port)));
    await new Promise<void>((r) => dead.close(() => r()));
    await expect(make(port).screenshot()).rejects.toThrow(/nothing is listening/);
  });

  it("wakes a waiting screenshot when the connection drops under it", async () => {
    const vnc = fakeVnc({ mute: true });
    servers.push(vnc);
    const d = new RfbDriver(target(await vnc.listen()), 5000);
    drivers.push(d);
    const pending = d.screenshot();
    setTimeout(() => vnc.close(), 200);
    // Without the close handler waking the waiters this sits on the 5s deadline instead — which for
    // a tool call is a session that looks hung.
    await expect(pending).rejects.toThrow();
  }, 4000);
});
