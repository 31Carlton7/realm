import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { APP_ICON_IDS, AppIconStore, isIconPng, registerAppIcon, type IconFs } from "./app-icon";
import { decodeRgbaPng as rgbaPng, hex } from "./png.test-util";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function memFs(): IconFs & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    read: (p) => { const f = files.get(p); if (!f) throw new Error("ENOENT"); return f; },
    write: (p, d) => { files.set(p, Buffer.from(d)); },
    remove: (p) => { files.delete(p); },
  };
}

function wired(dock = { setIcon: vi.fn() }) {
  const fs = memFs();
  const store = new AppIconStore("/ud", fs);
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
  registerAppIcon({ handle: (c, fn) => handlers.set(c, fn), store, dock });
  return { fs, store, dock, get: () => handlers.get("app-icon:get")!(null), set: (...a: unknown[]) => handlers.get("app-icon:set")!(null, ...a) };
}

describe("app icon", () => {
  it("puts a chosen icon on the Dock and brings it back at the next launch", () => {
    const { fs, dock, get, set } = wired();
    expect(get()).toBe("default");
    expect(set("ocean", PNG)).toBe(true);
    expect(dock.setIcon).toHaveBeenCalledWith(PNG);
    // A fresh store over the same disk is the next launch.
    const next = new AppIconStore("/ud", fs);
    expect(next.current()).toBe("ocean");
    expect(next.saved()).toEqual(Buffer.from(PNG));
  });

  it("remembers the default by forgetting, so the next launch leaves the bundle icon alone", () => {
    const { fs, store, dock, set } = wired();
    set("clay", PNG);
    expect(set("default", PNG)).toBe(true);
    // The running Dock tile still changes now — it only reverts to the bundle's on relaunch.
    expect(dock.setIcon).toHaveBeenLastCalledWith(PNG);
    expect(store.current()).toBe("default");
    expect(store.saved()).toBeNull();
    expect(fs.files.size).toBe(0);
  });

  it("refuses what did not come from the picker: an unknown id, or bytes that are not a PNG", () => {
    const { dock, store, set } = wired();
    expect(set("../../evil", PNG)).toBe(false);
    expect(set("ocean", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe(false);
    expect(set("ocean", "not bytes")).toBe(false);
    expect(set("ocean", new Uint8Array(3 * 1024 * 1024).fill(0x89))).toBe(false);
    expect(dock.setIcon).not.toHaveBeenCalled();
    expect(store.current()).toBe("default");
  });

  it("reads a damaged record as the default rather than failing the launch", () => {
    const fs = memFs();
    fs.files.set("/ud/app-icon.json", Buffer.from("{not json"));
    expect(new AppIconStore("/ud", fs).current()).toBe("default");
    fs.files.set("/ud/app-icon.json", Buffer.from(JSON.stringify({ id: "neon" })));
    expect(new AppIconStore("/ud", fs).saved()).toBeNull();
  });

  it("works with no Dock at all (not a Mac) — the choice is still kept", () => {
    const fs = memFs();
    const store = new AppIconStore("/ud", fs);
    let set: ((e: unknown, ...a: unknown[]) => unknown) | undefined;
    registerAppIcon({ handle: (c, fn) => { if (c === "app-icon:set") set = fn; }, store, dock: null });
    expect(set!(null, "mint", PNG)).toBe(true);
    expect(store.current()).toBe("mint");
  });

  it("isIconPng checks the signature, not just the type", () => {
    expect(isIconPng(PNG)).toBe(true);
    expect(isIconPng(PNG.slice(0, 8))).toBe(false);
  });

  /* The ids live in two places — main refuses anything outside APP_ICON_IDS, the picker offers
     APP_ICONS — and the pictures in a third. Read as files so this test does not import renderer code
     into the main project. */
  it("every id main accepts has a picture and a tile, and every tile is an id main accepts", () => {
    const assets = join(__dirname, "../renderer/src/assets/app-icons");
    const files = readdirSync(assets).filter((f) => f.endsWith(".png")).map((f) => f.replace(/\.png$/, "")).sort();
    expect(files).toEqual([...APP_ICON_IDS].sort());
    const picker = readFileSync(join(__dirname, "../renderer/src/components/settings/AppIconPicker.tsx"), "utf8");
    const tiles = [...picker.matchAll(/\{ id: "([a-z]+)"/g)].map((m) => m[1]);
    expect(tiles).toEqual([...APP_ICON_IDS]);
  });

  /* The body is Apple's continuous corner at the radius macOS 27 draws every app icon with (measured by
     resources/icon-src/shape.swift, whose printout of SwiftUI's own path is stored beside it). A
     superellipse or a circular radius looks close on paper, and macOS answers an icon whose body is
     not its own shape by shrinking it onto a grey plate — which is what the previous one got. */
  it("draws the icon body as Apple's own continuous-corner path on the macOS grid", async () => {
    const src = join(__dirname, "../../../../resources/icon-src");
    const { bodyPath } = (await import(join(src, "icons.mjs"))) as { bodyPath: () => string };
    const apple = JSON.parse(readFileSync(join(src, "apple-icon-body.json"), "utf8")) as { radius: number; d: string };
    // Every point of both outlines — where each corner leaves its edge, and each cubic's controls and
    // end. SwiftUI's starts half way down the right edge, a point on a straight line that this one has
    // no need of, so that one is dropped.
    const points = (d: string) => {
      const n = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
      return Array.from({ length: n.length / 2 }, (_, i) => [n[2 * i]!, n[2 * i + 1]!] as const);
    };
    const sorted = (ps: (readonly [number, number])[]) => [...ps].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const mine = sorted(points(bodyPath())), theirs = sorted(points(apple.d).slice(1));
    expect(mine).toHaveLength(40);
    expect(theirs).toHaveLength(40);
    mine.forEach((p, i) => expect(Math.hypot(p[0] - theirs[i]![0], p[1] - theirs[i]![1]), `point ${i}`).toBeLessThan(0.01));
  });

  /* The pictures are rendered from resources/icon-src/icons.mjs, so the drawing is a fourth list. A
     colouring added there and not here would be rendered and never offered; one removed there would
     leave a stale picture behind that no render replaces. */
  it("every picture is one the icon source draws, at the 256 px the Dock is handed", () => {
    const source = readFileSync(join(__dirname, "../../../../resources/icon-src/icons.mjs"), "utf8");
    const drawn = [...source.matchAll(/^ {4}id: "([a-z]+)",$/gm)].map((m) => m[1]);
    expect(drawn).toEqual([...APP_ICON_IDS]);
    for (const id of APP_ICON_IDS) {
      const png = readFileSync(join(__dirname, "../renderer/src/assets/app-icons", `${id}.png`));
      // IHDR's width and height, big-endian, straight after the signature and the chunk header.
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], id).toEqual([256, 256]);
    }
  });

  /* The bundle's icon is the mark in three flat planes on a near-black body, the doorway cut through
     to the body. Read off the rendered file, not the source, because the file is what ships. */
  it("ships the three-plane mark on near-black as the bundle's icon, with the doorway cut through", () => {
    const icon = rgbaPng(readFileSync(join(__dirname, "../../../../resources/icon.png")));
    expect([icon.width, icon.height]).toEqual([1024, 1024]);
    // The mark sits at (232, 176) on the 1024 grid, 14 px to a mark unit (icons.mjs).
    const at = (x: number, y: number) => hex(icon.pixel(232 + x * 14, 176 + y * 14));
    expect(at(20, 15)).toBe("#9cc1ff"); // the top
    expect(at(15, 32)).toBe("#4f8cf5"); // the left wall
    expect(at(30, 10.5)).toBe("#2457c4"); // the right wall, above the door
    expect(at(30.15, 24.26)).toBe("#15161a"); // the doorway: the body, through the wall
    expect(hex(icon.pixel(140, 512))).toBe("#15161a"); // the body itself
  });

  it("the default icon's source is the flat mark, not the shaded one", async () => {
    const src = join(__dirname, "../../../../resources/icon-src");
    const { ICONS, iconSvg } = (await import(join(src, "icons.mjs"))) as { ICONS: { id: string }[]; iconSvg: (i: unknown) => string };
    const svg = iconSvg(ICONS.find((i) => i.id === "default"));
    expect(svg).toMatch(/fill="#9cc1ff"/);
    expect(svg).not.toMatch(/id="mark-(?:top|lit|jamb|floor)"/);
  });

  /* A Mac asks the .icns for whichever size it is drawing — 16 in a list, 32 in Finder's sidebar, 512
     and 1024 in Get Info — and an icns missing one is scaled from another, blurred. iconutil reading
     it back is the check that it is a real icns and holds every size. */
  it.skipIf(process.platform !== "darwin")("resources/icon.icns holds every size, at 1x and 2x", () => {
    const dir = mkdtempSync(join(tmpdir(), "realm-icns-"));
    try {
      const out = join(dir, "icon.iconset");
      execFileSync("iconutil", ["-c", "iconset", join(__dirname, "../../../../resources/icon.icns"), "-o", out]);
      const want = [16, 32, 128, 256, 512].flatMap((n) => [`icon_${n}x${n}.png`, `icon_${n}x${n}@2x.png`]).sort();
      expect(readdirSync(out).sort()).toEqual(want);
      for (const n of [16, 32, 128, 256, 512]) {
        const png = readFileSync(join(out, `icon_${n}x${n}@2x.png`));
        expect(png.readUInt32BE(16), `${n}@2x`).toBe(n * 2);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
