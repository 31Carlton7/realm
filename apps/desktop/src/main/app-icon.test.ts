import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { APP_ICON_IDS, AppIconStore, isIconPng, registerAppIcon, type IconFs } from "./app-icon";

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
});
