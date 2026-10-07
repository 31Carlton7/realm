import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "../db/database";
import { SettingsStore } from "./settings";
import { AVATAR_MAX_BYTES, AVATAR_SETTING, AvatarStore, avatarDir } from "./avatar";

let home: string; let elsewhere: string; let settings: SettingsStore; let store: AvatarStore;

/** A PNG's worth of bytes. The store never decodes the picture — the renderer's `<img>` does — so
 *  any content distinguishes one pick from another. */
const picture = (name: string, bytes = `png:${name}`): string => {
  const path = join(elsewhere, name);
  writeFileSync(path, bytes);
  return path;
};

beforeEach(() => {
  home = tempDir("realm-avatar-home-");
  elsewhere = tempDir("realm-avatar-desktop-");
  settings = new SettingsStore(openDatabase(join(home, "realm.db")));
  store = new AvatarStore(home, settings);
});

describe("AvatarStore", () => {
  it("copies the picture under the Realm home and remembers only the copy's name", () => {
    const original = picture("me.png");
    const path = store.set(original);
    expect(dirname(path)).toBe(avatarDir(home));
    expect(readFileSync(path, "utf8")).toBe("png:me.png");
    // The row is a bare file name. The path the user picked appears nowhere in what was stored.
    expect(settings.get(AVATAR_SETTING)).toBe(path.split("/").pop());
    expect(JSON.stringify(settings.get(AVATAR_SETTING))).not.toContain(elsewhere);
    expect(store.get()).toBe(path);
  });

  it("keeps the picture when the original is moved or deleted", () => {
    const original = picture("me.png");
    const path = store.set(original);
    rmSync(original);
    expect(store.get()).toBe(path);
    expect(existsSync(path)).toBe(true);
  });

  it("gives a new pick a new name and deletes the copy it replaces", () => {
    // The new name is what makes the renderer redraw: an <img> on the same URL keeps its old bytes.
    const first = store.set(picture("one.png"));
    const second = store.set(picture("two.jpeg"));
    expect(second).not.toBe(first);
    expect(second.endsWith(".jpg")).toBe(true);
    expect(existsSync(first)).toBe(false);
    expect(store.get()).toBe(second);
  });

  it("forgets the picture and deletes its copy on clear", () => {
    const path = store.set(picture("me.png"));
    store.clear();
    expect(store.get()).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it("answers null when nothing was chosen, or the copy has gone", () => {
    expect(store.get()).toBeNull();
    const path = store.set(picture("me.png"));
    rmSync(path);
    expect(store.get()).toBeNull();
  });

  it("refuses a row that names anything outside its own folder", () => {
    // `settings.set` is reachable over RPC. A row reading "../realm.db" must not become the face.
    writeFileSync(join(home, "secret.png"), "not yours");
    settings.set(AVATAR_SETTING, "../secret.png");
    expect(store.get()).toBeNull();
  });

  it("refuses what is not a picture, a relative path, a folder and a missing file", () => {
    const code = (fn: () => unknown) => { try { fn(); return "no error"; } catch (e) { return (e as { code: string }).code; } };
    expect(code(() => store.set(picture("notes.txt")))).toBe("AVATAR_UNSUPPORTED");
    expect(code(() => store.set("me.png"))).toBe("INVALID_PARAMS");
    expect(code(() => store.set(join(elsewhere, "gone.png")))).toBe("AVATAR_UNREADABLE");
    mkdirSync(join(elsewhere, "album.png"));
    expect(code(() => store.set(join(elsewhere, "album.png")))).toBe("AVATAR_UNREADABLE");
    expect(store.get()).toBeNull();
  });

  it("refuses a picture over the size cap, and keeps the one it had", () => {
    const kept = store.set(picture("me.png"));
    const huge = picture("huge.png", "");
    truncateSync(huge, AVATAR_MAX_BYTES + 1); // sparse: the size is what is checked, not the bytes
    expect(() => store.set(huge)).toThrow(/10 MB/);
    expect(store.get()).toBe(kept);
  });
});
