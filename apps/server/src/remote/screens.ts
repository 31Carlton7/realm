import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine, MachineState, Simulator, SimulatorState } from "@realm/contracts";
import { SCREEN_SIDE, type Screen, type ScreenFrame } from "@realm/remote";
import type { Downscale } from "./preview";

/**
 * What a phone is shown of the screens a session's space has open (`session.screens`, `session.screen`):
 * each simulator and machine named as its pane is, but a Mac app (`phoneMayWatch`), and a picture of one
 * made small. Which screen may be pictured is not decided here: the caller has found it in the session's
 * own space and seen it live.
 *
 * A frame is polled every second or two while the phone's viewer is open, so it is bounded on every
 * side: a JPEG at most the side asked for (a simulator's home screen at 1000 px is about 50 KB), made
 * from a capture that is written only to a folder of its own under the system's temporary folder and
 * gone again before the answer is; one capture of a screen at a time, however many calls come for it,
 * and none waited on past SCREEN_DEADLINE_MS.
 */

/** The JPEG quality a frame is made at, and the most one may weigh before it is made once more, smaller. */
export const FRAME_QUALITY = 65;
export const FRAME_MAX_BYTES = 320 * 1024;

/** The longest a picture of a screen may take, capture and all: well inside the 15 s a phone waits on a
 *  call, so a capture that hangs is answered as one that failed, and the next call takes a new one. */
export const SCREEN_DEADLINE_MS = 10_000;

/** The side a frame is made at: the one asked for, brought inside `SCREEN_SIDE`. */
export const frameSide = (asked: number | undefined): number =>
  Math.min(SCREEN_SIDE.max, Math.max(SCREEN_SIDE.min, Math.round(asked ?? SCREEN_SIDE.default)));

const MACHINE_WORDS: Record<Machine["source"], string> = { mac: "Mac app", vnc: "Remote screen", qemu: "Virtual machine", container: "Container" };

/** A simulator's pane, as a phone lists it. A real device is somebody's own phone, and says so rather
 *  than naming the toolchain it is reached with. Live while the pane is showing pixels. */
export function simulatorScreen(row: Simulator, state: SimulatorState | undefined, name: string): Screen {
  const detail = row.physical ? (/\bipad\b/i.test(name) ? "Your iPad" : "Your iPhone") : row.platform === "android" ? "Android emulator" : "iOS Simulator";
  return { id: row.id, kind: "simulator", name, detail, live: state?.status === "running" };
}

/** A machine's pane, as a phone lists it: what kind of screen it is, in words. Live once it is
 *  running — connected, booted, or for this Mac's own app, started. */
export function machineScreen(row: Machine, state: MachineState | undefined, name: string): Screen {
  return { id: row.id, kind: "machine", name, detail: MACHINE_WORDS[row.source], live: state?.status === "running" };
}

/**
 * A machine a phone may watch: not a Mac app (`mac`), in 2.6.1. A picture of one is a whole accessibility
 * snapshot of the app on the computer-use helper, which keeps one snapshot per app — so a phone watching
 * it would leave an agent's `computer_snapshot` of that app stale before its `computer_act` — and the
 * machine counts as running from its Start to its Stop, archived or not, whether or not anything on the
 * Mac is showing the app.
 */
export const phoneMayWatch = (row: Machine): boolean => row.source !== "mac";

/** The live first, then by name as a person reads a list, then by id, so two reads of it agree. */
export const screenOrder = (a: Screen, b: Screen): number =>
  Number(b.live) - Number(a.live) || a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A JPEG's size in pixels, off its frame header (SOFn), or null for bytes that are not a JPEG. */
export function jpegSize(jpeg: Buffer): { width: number; height: number } | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1]!;
    // Fill bytes, and the markers that carry no length.
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { at += 2; continue; }
    // The image data, or its end, before any frame header: a JPEG with no size.
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return at + 9 <= jpeg.length ? { height: jpeg.readUInt16BE(at + 5), width: jpeg.readUInt16BE(at + 7) } : null;
    }
    at += 2 + jpeg.readUInt16BE(at + 2);
  }
  return null;
}

/** What kind of picture a capture is, by its first bytes: a simulator's is a PNG, a machine's a PNG or
 *  a JPEG. The name it is written under says so, for `sips`. */
const pictureKind = (bytes: Buffer): "png" | "jpg" | null =>
  bytes.length > 8 && bytes.readUInt32BE(0) === 0x89504e47 ? "png" : bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 ? "jpg" : null;

/** A capture made into a phone's frame: a JPEG no longer than `side` on its longer side, never enlarged. */
export async function screenFrame(capture: Buffer, side: number, capturedAt: number, downscale: Downscale): Promise<ScreenFrame> {
  const kind = pictureKind(capture);
  if (!kind) throw new Error("The Mac's capture of that screen is not a picture it can read.");
  const dir = await mkdtemp(join(tmpdir(), "realm-screen-"));
  try {
    const path = join(dir, `capture.${kind}`);
    await writeFile(path, capture);
    let jpeg = await downscale(path, side, FRAME_QUALITY);
    if (jpeg.length > FRAME_MAX_BYTES) jpeg = await downscale(path, Math.round(side * 0.7), 50);
    const size = jpegSize(jpeg);
    if (!size) throw new Error("The frame made of that screen is not a JPEG.");
    return { mime: "image/jpeg", data: jpeg.toString("base64"), width: size.width, height: size.height, capturedAt };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
