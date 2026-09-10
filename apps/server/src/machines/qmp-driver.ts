import { readFile, unlink } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { join } from "node:path";
import type { VmAction } from "@realm/contracts";
import { KEYSYMS, parseChord } from "@realm/contracts";
import { SCREENSHOT_MAX_EDGE, type DriverFrame, type MachineDriver } from "./driver";
import { downscale, encodePng } from "./framebuffer";
import type { QmpClient } from "./qmp";

/**
 * The agent's channel for a guest Realm booted itself (Plan 25 W6) — QMP rather than RFB.
 *
 * Why a second driver at all, when `RfbDriver` would work against the same guest's VNC port: QMP is
 * a channel QEMU already gives us, on a unix socket with filesystem permissions, and it works with
 * **no viewer connected at all**. The pane's RFB socket may be closed, the human may be in another
 * space, and `screendump` still produces a frame. That is exactly when an agent is most likely to be
 * working.
 *
 * It also keeps the plan's rule physical: the human's `-vnc …,share=ignore` socket is never touched
 * by the agent, so nothing the agent does can evict a viewer.
 */

/** QEMU's absolute axis range. Every `abs` event is on 0..0x7FFF whatever the guest's resolution is,
 *  so a coordinate has to be scaled into it — and dropping that scaling puts every click within the
 *  first few pixels of the top-left corner, which looks like a machine that ignores input. */
export const QEMU_ABS_MAX = 0x7fff;

export function toAbsAxis(value: number, extent: number): number {
  if (extent <= 1) return 0;
  const clamped = Math.max(0, Math.min(extent - 1, Math.round(value)));
  return Math.round((clamped / (extent - 1)) * QEMU_ABS_MAX);
}

export class QmpDriver implements MachineDriver {
  /** The screen's real size, learned from the last screendump. */
  private size: { width: number; height: number } | null = null;

  constructor(private readonly qmp: QmpClient, private readonly dir: string) {}

  /**
   * A frame, through `screendump`.
   *
   * MEASURED and load-bearing: a `virtio-gpu-pci` guest that has not initialised its display answers
   * with **640×480** whatever `xres`/`yres` asked for. So the dimensions are read out of the PNG
   * rather than assumed from the spec — an agent told 1280×800 while looking at a 640×480 firmware
   * screen would address a coordinate space that does not exist yet.
   */
  async screenshot(): Promise<DriverFrame> {
    const path = join(this.dir, `shot-${Date.now()}.png`);
    try {
      await this.qmp.command("screendump", { filename: path, format: "png" });
      const png = await readFile(path);
      const dims = pngSize(png);
      if (!dims) throw new Error("QEMU wrote a screenshot Realm could not read");
      this.size = dims;
      // Decoding QEMU's PNG only to re-encode it would need an inflate-and-unfilter pass for no
      // gain: it is already a PNG, and it is already the size the guest is drawing at. Downscaling
      // is the one thing worth doing, and only when there is something to downscale.
      if (Math.max(dims.width, dims.height) <= SCREENSHOT_MAX_EDGE) {
        return { data: png, width: dims.width, height: dims.height, imageWidth: dims.width, imageHeight: dims.height };
      }
      const rgba = decodePngToRgba(png);
      if (!rgba) return { data: png, width: dims.width, height: dims.height, imageWidth: dims.width, imageHeight: dims.height };
      const small = downscale(rgba, SCREENSHOT_MAX_EDGE);
      return { data: encodePng(small), width: dims.width, height: dims.height, imageWidth: small.width, imageHeight: small.height };
    } finally {
      // QEMU writes into the machine's own directory, and a screenshot per act would fill it.
      await unlink(path).catch(() => { /* already gone, or never written */ });
    }
  }

  async act(action: VmAction): Promise<string> {
    switch (action.kind) {
      case "click": {
        const { width, height } = await this.extent();
        const button = action.button === "right" ? "right" : action.button === "middle" ? "middle" : "left";
        // Position and press in ONE `input-send-event`. Sent separately, a guest can process the
        // press before the move lands and click wherever the pointer used to be.
        await this.send([
          { type: "abs", data: { axis: "x", value: toAbsAxis(action.x, width) } },
          { type: "abs", data: { axis: "y", value: toAbsAxis(action.y, height) } },
          { type: "btn", data: { button, down: true } },
          { type: "btn", data: { button, down: false } },
        ]);
        return `clicked ${button} at (${action.x},${action.y})`;
      }
      case "scroll": {
        const { width, height } = await this.extent();
        const up = action.deltaY < 0;
        const notches = Math.min(20, Math.max(1, Math.round(Math.abs(action.deltaY) / 100)));
        const events: unknown[] = [
          { type: "abs", data: { axis: "x", value: toAbsAxis(action.x, width) } },
          { type: "abs", data: { axis: "y", value: toAbsAxis(action.y, height) } },
        ];
        for (let i = 0; i < notches; i++) {
          events.push({ type: "btn", data: { button: up ? "wheel-up" : "wheel-down", down: true } });
          events.push({ type: "btn", data: { button: up ? "wheel-up" : "wheel-down", down: false } });
        }
        await this.send(events);
        return `scrolled ${up ? "up" : "down"} ${notches} notch(es) at (${action.x},${action.y})`;
      }
      case "key": {
        const chord = parseChord(action.key);
        if (!chord) throw new Error(`"${action.key}" is not a key Realm can send.`);
        await this.send([...chord.modifiers, chord.key].map((k) => ({ type: "key", data: { down: true, key: qcode(k) } }))
          .concat([...chord.modifiers, chord.key].reverse().map((k) => ({ type: "key", data: { down: false, key: qcode(k) } }))));
        return `pressed ${action.key}`;
      }
      case "type": {
        for (const ch of action.text) {
          const spec = QCODE_FOR_CHAR[ch];
          /* Refused rather than dropped, and the reason is stronger here than over RFB: QMP takes
             QCODES, which are PHYSICAL KEY POSITIONS on a US layout — not characters at all. There
             is no encoding of "é" to send; there is only "the key where é would be on some layout",
             which this side cannot know. */
          if (!spec) throw new Error(`cannot type ${JSON.stringify(ch)} — QEMU takes key POSITIONS, not characters, so anything outside a US layout has no key to press.`);
          const events = spec.shift
            ? [{ type: "key", data: { down: true, key: "shift" } }, { type: "key", data: { down: true, key: spec.code } },
               { type: "key", data: { down: false, key: spec.code } }, { type: "key", data: { down: false, key: "shift" } }]
            : [{ type: "key", data: { down: true, key: spec.code } }, { type: "key", data: { down: false, key: spec.code } }];
          await this.send(events);
        }
        return `typed ${action.text.length} character(s)`;
      }
    }
  }

  close(): void { this.qmp.close(); }

  /**
   * The screen's size, for scaling a coordinate onto QEMU's absolute axis.
   *
   * Taken from the last screendump, and a screenshot is taken when there has been none — because the
   * spec's `xres`/`yres` is a REQUEST and the measured answer at firmware time was 640×480. Scaling
   * against a size the guest is not using puts every click somewhere else, proportionally.
   */
  private async extent(): Promise<{ width: number; height: number }> {
    if (this.size) return this.size;
    await this.screenshot();
    return this.size ?? { width: 1280, height: 800 };
  }

  private async send(events: unknown[]): Promise<void> {
    try {
      await this.qmp.command("input-send-event", { events });
    } catch (e) {
      // MEASURED: a paused VM answers `input-send-event` with "VM not running", which is true and
      // says nothing about what to do. A suspended machine is exactly the case, and Resume is it.
      if (e instanceof Error && /not running/i.test(e.message)) {
        throw new Error("this machine is suspended, so it cannot receive input. Resume it first.");
      }
      throw e;
    }
  }
}

/** Just the header — width and height — without decoding anything.
 *  IHDR is always the first chunk, at a fixed offset, so this is a read rather than a parse. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return null;
  if (png.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * QEMU's PNG back to RGBA, for the one case that needs it: downscaling a screen larger than the
 * budget. Returns null for anything this cannot read, and the caller then ships the original — a
 * screenshot that is bigger than ideal beats no screenshot.
 */
function decodePngToRgba(png: Buffer): { width: number; height: number; rgba: Buffer } | null {
  const dims = pngSize(png);
  if (!dims) return null;
  const depth = png[24], colour = png[25], interlace = png[28];
  // 8-bit truecolour, non-interlaced, is what QEMU writes. Anything else is somebody else's PNG and
  // is handed back untouched rather than half-decoded.
  if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0) return null;
  const channels = colour === 6 ? 4 : 3;
  let idat = Buffer.alloc(0);
  let at = 8;
  while (at + 8 <= png.length) {
    const len = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString("latin1");
    if (type === "IDAT") idat = Buffer.concat([idat, png.subarray(at + 8, at + 8 + len)]);
    at += 12 + len;
  }
  if (idat.length === 0) return null;
  // A top-level import, not a `require`: this file is bundled to ESM, where `require` is not
  // defined at all — and the failure is a runtime one the source-level suite never sees.
  let raw: Buffer;
  try { raw = inflateSync(idat); } catch { return null; }
  const { width, height } = dims;
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;
  const rgba = Buffer.alloc(width * height * 4);
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    raw.copy(line, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    unfilter(filter, line, prev, channels);
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4;
      rgba[d] = line[s]!; rgba[d + 1] = line[s + 1]!; rgba[d + 2] = line[s + 2]!; rgba[d + 3] = 255;
    }
    line.copy(prev);
  }
  return { width, height, rgba };
}

/** PNG's five row filters, in place. */
function unfilter(filter: number, line: Buffer, prev: Buffer, bpp: number): void {
  const n = line.length;
  if (filter === 0) return;
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? line[i - bpp]! : 0;
    const b = prev[i]!;
    const c = i >= bpp ? prev[i - bpp]! : 0;
    let add = 0;
    if (filter === 1) add = a;
    else if (filter === 2) add = b;
    else if (filter === 3) add = (a + b) >> 1;
    else if (filter === 4) {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    line[i] = (line[i]! + add) & 0xff;
  }
}

/* ------------------------------ QCODES ------------------------------ */

/**
 * QEMU takes QCODES, which are PHYSICAL KEY POSITIONS rather than characters.
 *
 * That is the whole difference from RFB's keysyms and it is why `type` refuses more here: a keysym
 * at least NAMES a character for Latin-1, while a qcode names the key at a position on a US layout.
 * There is no encoding of "é" to send — only "the key where é sits on a layout this side cannot see".
 */

/** A keysym back to the qcode for the key that produces it on a US layout. */
function qcode(keysym: number): string {
  const named: Record<number, string> = {
    [KEYSYMS.Enter!]: "ret", [KEYSYMS.Tab!]: "tab", [KEYSYMS.Escape!]: "esc",
    [KEYSYMS.Backspace!]: "backspace", [KEYSYMS.Delete!]: "delete", [KEYSYMS.Space!]: "spc",
    [KEYSYMS.ArrowLeft!]: "left", [KEYSYMS.ArrowRight!]: "right", [KEYSYMS.ArrowUp!]: "up", [KEYSYMS.ArrowDown!]: "down",
    [KEYSYMS.Home!]: "home", [KEYSYMS.End!]: "end", [KEYSYMS.PageUp!]: "pgup", [KEYSYMS.PageDown!]: "pgdn",
    [KEYSYMS.Shift!]: "shift", [KEYSYMS.Control!]: "ctrl", [KEYSYMS.Alt!]: "alt", [KEYSYMS.Meta!]: "meta_l",
  };
  if (named[keysym]) return named[keysym]!;
  for (let f = 1; f <= 12; f++) if (keysym === KEYSYMS[`F${f}`]) return `f${f}`;
  const ch = String.fromCodePoint(keysym);
  const spec = QCODE_FOR_CHAR[ch] ?? QCODE_FOR_CHAR[ch.toLowerCase()];
  if (spec) return spec.code;
  throw new Error(`no QEMU key position for keysym 0x${keysym.toString(16)}`);
}

/** Character → the US-layout key that makes it, and whether Shift is held. */
export const QCODE_FOR_CHAR: Readonly<Record<string, { code: string; shift?: true }>> = (() => {
  const map: Record<string, { code: string; shift?: true }> = {};
  for (const c of "abcdefghijklmnopqrstuvwxyz") { map[c] = { code: c }; map[c.toUpperCase()] = { code: c, shift: true }; }
  const digits = "1234567890";
  const shifted = "!@#$%^&*()";
  for (let i = 0; i < digits.length; i++) {
    map[digits[i]!] = { code: digits[i]! };
    map[shifted[i]!] = { code: digits[i]!, shift: true };
  }
  const pairs: [string, string, string][] = [
    ["-", "_", "minus"], ["=", "+", "equal"], ["[", "{", "bracket_left"], ["]", "}", "bracket_right"],
    ["\\", "|", "backslash"], [";", ":", "semicolon"], ["'", '"', "apostrophe"],
    [",", "<", "comma"], [".", ">", "dot"], ["/", "?", "slash"], ["`", "~", "grave_accent"],
  ];
  for (const [plain, shift, code] of pairs) { map[plain] = { code }; map[shift] = { code, shift: true }; }
  map[" "] = { code: "spc" };
  map["\n"] = { code: "ret" };
  map["\t"] = { code: "tab" };
  return map;
})();
