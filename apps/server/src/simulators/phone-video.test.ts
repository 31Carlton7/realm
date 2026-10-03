import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { FrameReader, phoneVideo } from "./phone-video";

/**
 * The `phonescreen` helper's side of a real iPhone's live picture: its stdout cut back into JPEGs, and
 * its exit read as why there is no video. What must die here: a frame cut wrong when a pipe splits it,
 * a camera never asked for read as a phone with no cable (the pane would offer the wrong fix), and a
 * feed stopped on purpose read as one that failed.
 */

const framed = (...frames: Buffer[]) => Buffer.concat(frames.flatMap((f) => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(f.length, 0);
  return [head, f];
}));

describe("FrameReader", () => {
  it("cuts frames out wherever the pipe splits them — mid-length, mid-frame, several to a chunk", () => {
    const a = Buffer.from("first frame"), b = Buffer.from("b"), c = Buffer.alloc(70_000, 7);
    const all = framed(a, b, c);
    for (const cuts of [[1], [2, 3, 5], [4], [15], [16, 17], [all.length - 1]]) {
      const got: Buffer[] = [];
      const r = new FrameReader((f) => got.push(Buffer.from(f)));
      let at = 0;
      for (const cut of [...cuts, all.length]) { r.push(all.subarray(at, cut)); at = cut; }
      // THE MUTANT: hand on each chunk as a frame. A JPEG split across two reads arrives as two halves.
      expect(got.map((f) => f.toString("hex"))).toEqual([a, b, c].map((f) => f.toString("hex")));
    }
  });

  it("holds a frame until all of it is there", () => {
    const got: Buffer[] = [];
    const r = new FrameReader((f) => got.push(f));
    const all = framed(Buffer.from("whole"));
    r.push(all.subarray(0, 6));
    expect(got).toHaveLength(0);
    r.push(all.subarray(6));
    expect(got.map(String)).toEqual(["whole"]);
  });
});

/** A child process the test drives: stdout to write frames on, an exit to give. */
function child() {
  const c = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: (s?: string) => boolean; killed: string[] };
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.killed = [];
  c.kill = (s = "SIGTERM") => { c.killed.push(s); setImmediate(() => c.emit("exit", null, s)); return true; };
  return c;
}

function start(name = "Carlton’s iPhone") {
  const c = child();
  const calls: { bin: string; args: string[] }[] = [];
  const frames: Buffer[] = [];
  const feed = phoneVideo({ bin: "/app/phonescreen", name, spawn: ((bin: string, args: string[]) => { calls.push({ bin, args }); return c; }) as never })((f) => frames.push(f));
  return { c, calls, frames, feed };
}

describe("phoneVideo", () => {
  it("runs the helper for the phone by its name, and is ready at the first frame", async () => {
    const { c, calls, frames, feed } = start();
    expect(calls).toEqual([{ bin: "/app/phonescreen", args: ["stream", "--name", "Carlton’s iPhone", "--scale", "0.5", "--quality", "0.6", "--max-fps", "30"] }]);
    let ready = false;
    void feed.ready.then(() => { ready = true; });
    await new Promise((r) => setImmediate(r));
    expect(ready).toBe(false);
    c.stdout.write(framed(Buffer.from("jpeg one"), Buffer.from("jpeg two")));
    await new Promise((r) => setImmediate(r));
    expect(ready).toBe(true);
    expect(frames.map(String)).toEqual(["jpeg one", "jpeg two"]);
  });

  it("reads the helper's exit as why there is no video", async () => {
    // THE MUTANT: one reason for every exit. "Show live" would be offered to a phone on Wi-Fi, and a
    // refused camera would be asked again by a prompt macOS will never show.
    for (const [code, why] of [[2, "no-cable"], [3, "camera"], [4, "camera-denied"], [5, "failed"], [null, "failed"]] as const) {
      const { c, feed } = start();
      c.emit("exit", code, code === null ? "SIGKILL" : null);
      expect(await feed.ended).toBe(why);
    }
  });

  it("ends with no reason when it was stopped on purpose", async () => {
    const { c, feed } = start();
    feed.stop();
    // THE MUTANT: a stop read as a failure. The pane would fall back and say so whenever it was hidden.
    expect(await feed.ended).toBeNull();
    expect(c.killed).toEqual(["SIGTERM"]);
  });

  it("is a failed feed, not a thrown error, when the helper cannot even be started", async () => {
    const thrower = phoneVideo({ bin: "/gone", name: "x", spawn: (() => { throw new Error("ENOENT"); }) as never })(() => {});
    expect(await thrower.ended).toBe("failed");
    const { c, feed } = start();
    c.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" }));
    expect(await feed.ended).toBe("failed");
  });
});
