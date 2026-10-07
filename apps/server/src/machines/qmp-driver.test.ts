import { createServer, type Server } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { QmpClient } from "./qmp";
import { QEMU_ABS_MAX, QmpDriver, QCODE_FOR_CHAR, pngSize, toAbsAxis } from "./qmp-driver";
import { blankFrame, encodePng } from "./framebuffer";

const servers: Server[] = [];
const clients: QmpClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) s.close();
});

/** A QMP server: the greeting, the capabilities handshake, and a recorded command log. */
function fakeQmp(opts: { dir: string; shot?: Buffer; failInput?: string; skipGreeting?: boolean } = { dir: "" }) {
  const commands: { execute: string; arguments?: Record<string, unknown> }[] = [];
  const path = join(opts.dir, "qmp.sock");
  const server = createServer((s) => {
    let buf = "";
    // The greeting, which is NOT a reply to anything — a client that counts it as one is a reply out
    // of step for the whole session.
    if (!opts.skipGreeting) s.write(`${JSON.stringify({ QMP: { version: { qemu: { major: 10 } } } })}\n`);
    s.on("error", () => {});
    s.on("data", (d) => {
      buf += d.toString();
      for (;;) {
        const i = buf.indexOf("\n");
        if (i < 0) return;
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as { execute: string; arguments?: Record<string, unknown> };
        commands.push(msg);
        if (msg.execute === "qmp_capabilities") { s.write(`${JSON.stringify({ return: {} })}\n`); continue; }
        if (msg.execute === "screendump") {
          writeFileSync(String(msg.arguments!.filename), opts.shot ?? encodePng(blankFrame(640, 480)));
          s.write(`${JSON.stringify({ return: {} })}\n`);
          continue;
        }
        if (msg.execute === "input-send-event" && opts.failInput) {
          s.write(`${JSON.stringify({ error: { class: "GenericError", desc: opts.failInput } })}\n`);
          continue;
        }
        s.write(`${JSON.stringify({ return: {} })}\n`);
      }
    });
  });
  servers.push(server);
  return { commands, path, listen: () => new Promise<void>((r) => server.listen(path, () => r())) };
}

async function harness(opts: { shot?: Buffer; failInput?: string } = {}) {
  const dir = tempDir("realm-qmp-");
  mkdirSync(dir, { recursive: true });
  const fake = fakeQmp({ dir, ...opts });
  await fake.listen();
  const client = new QmpClient(fake.path, 4000);
  clients.push(client);
  return { dir, fake, driver: new QmpDriver(client, dir), client };
}

const events = (cmds: { execute: string; arguments?: Record<string, unknown> }[]) =>
  cmds.filter((c) => c.execute === "input-send-event").flatMap((c) => c.arguments!.events as { type: string; data: Record<string, unknown> }[]);

describe("QMP", () => {
  it("waits for the greeting and sends capabilities before anything else", async () => {
    const h = await harness();
    await h.driver.screenshot();
    // Every other command is refused until `qmp_capabilities` has landed, and the refusal is a
    // generic "command not found" that reads as an unsupported QEMU.
    expect(h.fake.commands[0]!.execute).toBe("qmp_capabilities");
    expect(h.fake.commands[1]!.execute).toBe("screendump");
  });

  /**
   * A failed connect must not poison the client.
   *
   * `connect()` memoises, and a rejected promise left in the memo is handed to every later caller
   * forever. The manager's readiness walk retries in a loop — and QEMU ALWAYS takes a moment to
   * create its socket, so the first attempt always fails. Found by a demo: a guest that was seconds
   * from ready could never be connected to, while QEMU sat there perfectly healthy.
   */
  it("retries after a failed connect instead of returning the same rejection forever", async () => {
    const dir = tempDir("realm-qmp-");
    mkdirSync(dir, { recursive: true });
    const client = new QmpClient(join(dir, "qmp.sock"), 500);
    clients.push(client);
    // Nothing is listening yet, exactly as it is for the first second of a guest's life.
    await expect(client.connect()).rejects.toThrow();
    // …and now QEMU makes its socket.
    const fake = fakeQmp({ dir });
    await fake.listen();
    await expect(client.connect()).resolves.toBeUndefined();
    expect(fake.commands[0]!.execute).toBe("qmp_capabilities");
  });

  it("gives up on a socket that never greets, rather than hanging a tool call", async () => {
    const dir = tempDir("realm-qmp-");
    mkdirSync(dir, { recursive: true });
    const fake = fakeQmp({ dir, skipGreeting: true });
    await fake.listen();
    const client = new QmpClient(fake.path, 400);
    clients.push(client);
    await expect(new QmpDriver(client, dir).screenshot()).rejects.toThrow(/did not greet/);
  });

  it("surfaces QEMU's own error as a rejection rather than a value", async () => {
    // A caller must not be able to mistake "the VM is not running" for "the input was delivered".
    const h = await harness({ failInput: "Something went wrong" });
    await expect(h.driver.act({ kind: "click", x: 1, y: 1, button: "left" })).rejects.toThrow(/Something went wrong/);
  });
});

describe("the screen", () => {
  /**
   * MEASURED, and the reason the size is read rather than assumed: a `virtio-gpu-pci` guest that has
   * not initialised its display answers `screendump` with 640×480 whatever `xres`/`yres` asked for.
   * An agent told 1280×800 while looking at a firmware screen addresses a space that does not exist.
   */
  it("reads the screen's size out of the image, never from the spec", async () => {
    const h = await harness({ shot: encodePng(blankFrame(640, 480)) });
    const frame = await h.driver.screenshot();
    expect(frame.width).toBe(640);
    expect(frame.height).toBe(480);
  });

  it("downscales a screen larger than the budget, and still reports the real size", async () => {
    const h = await harness({ shot: encodePng(blankFrame(1920, 1200)) });
    const frame = await h.driver.screenshot();
    expect(frame.width).toBe(1920);
    expect(frame.height).toBe(1200);
    expect(frame.imageWidth).toBeLessThan(1920);
    expect(pngSize(frame.data)!.width).toBe(frame.imageWidth);
  });

  it("ships QEMU's own PNG untouched when it is already small enough", async () => {
    const png = encodePng(blankFrame(640, 480));
    const h = await harness({ shot: png });
    // Decoding only to re-encode would be an inflate-and-unfilter pass for no gain.
    expect((await h.driver.screenshot()).data.equals(png)).toBe(true);
  });

  it("cleans up after itself — a screenshot per act would fill the machine's directory", async () => {
    const h = await harness();
    await h.driver.screenshot();
    await h.driver.screenshot();
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(h.dir).filter((f) => f.endsWith(".png"))).toEqual([]);
  });
});

describe("the absolute axis", () => {
  /**
   * QEMU's absolute events are on 0..0x7FFF whatever the guest's resolution is. Dropping the
   * normalisation puts every click within the first few pixels of the top-left corner — which looks
   * like a machine that ignores input rather than one that was told the wrong place.
   */
  it("scales a coordinate onto QEMU's own range, not the guest's", () => {
    expect(toAbsAxis(0, 1280)).toBe(0);
    expect(toAbsAxis(1279, 1280)).toBe(QEMU_ABS_MAX);
    expect(toAbsAxis(640, 1280)).toBeCloseTo(QEMU_ABS_MAX / 2, -2);
    // A coordinate past the edge is clamped, not wrapped — the wrapped value is a real point
    // somewhere else on the screen.
    expect(toAbsAxis(99999, 1280)).toBe(QEMU_ABS_MAX);
    expect(toAbsAxis(-5, 1280)).toBe(0);
  });

  it("scales x and y against their OWN extents", async () => {
    // The asymmetric fixture: a square-agnostic implementation that used one extent for both would
    // pass against 640×640 and be wrong on every real screen.
    const h = await harness({ shot: encodePng(blankFrame(800, 400)) });
    await h.driver.act({ kind: "click", x: 400, y: 100, button: "left" });
    const abs = events(h.fake.commands).filter((e) => e.type === "abs");
    expect(abs.find((e) => e.data.axis === "x")!.data.value).toBe(toAbsAxis(400, 800));
    expect(abs.find((e) => e.data.axis === "y")!.data.value).toBe(toAbsAxis(100, 400));
    expect(abs.find((e) => e.data.axis === "x")!.data.value).not.toBe(abs.find((e) => e.data.axis === "y")!.data.value);
  });

  it("takes a screenshot first when it does not yet know the screen's size", async () => {
    const h = await harness({ shot: encodePng(blankFrame(640, 480)) });
    await h.driver.act({ kind: "click", x: 320, y: 240, button: "left" });
    // Scaling against the SPEC's requested size rather than the measured one puts every click
    // proportionally somewhere else — see the 640×480 measurement above.
    expect(h.fake.commands.map((c) => c.execute)).toContain("screendump");
    expect(events(h.fake.commands).find((e) => e.data.axis === "x")!.data.value).toBe(toAbsAxis(320, 640));
  });
});

describe("what the guest receives", () => {
  it("positions and presses in ONE event batch", async () => {
    const h = await harness();
    await h.driver.act({ kind: "click", x: 10, y: 20, button: "right" });
    const batch = h.fake.commands.filter((c) => c.execute === "input-send-event");
    // Sent separately, a guest can process the press before the move lands and click wherever the
    // pointer used to be.
    expect(batch).toHaveLength(1);
    const e = batch[0]!.arguments!.events as { type: string; data: Record<string, unknown> }[];
    expect(e.map((x) => x.type)).toEqual(["abs", "abs", "btn", "btn"]);
    expect(e[2]!.data).toMatchObject({ button: "right", down: true });
    expect(e[3]!.data).toMatchObject({ button: "right", down: false });
  });

  it("sends a scroll as wheel buttons on the delta's side", async () => {
    const h = await harness();
    await h.driver.act({ kind: "scroll", x: 5, y: 5, deltaY: -300 });
    const btns = events(h.fake.commands).filter((e) => e.type === "btn");
    expect(btns.every((b) => b.data.button === "wheel-up")).toBe(true);
    expect(btns.filter((b) => b.data.down === true)).toHaveLength(3);
  });

  it("holds a chord's modifiers around its key and releases them in reverse", async () => {
    const h = await harness();
    await h.driver.act({ kind: "key", key: "ctrl+alt+Delete" });
    const keys = events(h.fake.commands).filter((e) => e.type === "key").map((e) => [e.data.down, e.data.key]);
    expect(keys).toEqual([
      [true, "ctrl"], [true, "alt"], [true, "delete"],
      [false, "delete"], [false, "alt"], [false, "ctrl"],
    ]);
  });

  it("types by key POSITION, shifting what a US layout shifts", async () => {
    const h = await harness();
    await h.driver.act({ kind: "type", text: "aA!" });
    const keys = events(h.fake.commands).filter((e) => e.type === "key").map((e) => [e.data.down, e.data.key]);
    expect(keys).toEqual([
      [true, "a"], [false, "a"],
      [true, "shift"], [true, "a"], [false, "a"], [false, "shift"],
      [true, "shift"], [true, "1"], [false, "1"], [false, "shift"],
    ]);
  });

  /**
   * The refusal is STRONGER here than over RFB, and the reason is worth keeping: QMP takes QCODES,
   * which are PHYSICAL KEY POSITIONS on a US layout — not characters at all. A keysym at least names
   * a character for Latin-1; there is no encoding of "é" to send as a qcode, only "the key where é
   * sits on a layout this side cannot see".
   */
  it("refuses a character that has no key position, rather than pressing the wrong one", async () => {
    const h = await harness();
    await expect(h.driver.act({ kind: "type", text: "café" })).rejects.toThrow(/key POSITIONS, not characters/);
    expect(QCODE_FOR_CHAR["é"]).toBeUndefined();
    expect(QCODE_FOR_CHAR["!"]).toEqual({ code: "1", shift: true });
    expect(QCODE_FOR_CHAR["/"]).toEqual({ code: "slash" });
  });

  /* MEASURED: a paused VM answers `input-send-event` with "VM not running", which is true and says
     nothing about what to do. A suspended machine is exactly that case, and Resume is the answer. */
  it("turns QEMU's 'VM not running' into the thing to actually do", async () => {
    const h = await harness({ failInput: "VM not running" });
    await expect(h.driver.act({ kind: "click", x: 1, y: 1, button: "left" })).rejects.toThrow(/suspended.*Resume it first/);
  });
});
