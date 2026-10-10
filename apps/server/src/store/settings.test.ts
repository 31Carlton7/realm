import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "../db/database"; import { SettingsStore } from "./settings";
describe("SettingsStore", () => {
  it("get returns null for missing, set/get roundtrips JSON", () => {
    const db = openDatabase(join(tempDir("realm-"), "realm.db"));
    const s = new SettingsStore(db);
    expect(s.get("ui.activeSpaceId")).toBeNull();
    s.set("ui.theme", { mode: "system" });
    expect(s.get("ui.theme")).toEqual({ mode: "system" });
    s.set("ui.theme", "dark"); expect(s.get("ui.theme")).toBe("dark");
    s.set("ui.theme", undefined); expect(s.get("ui.theme")).toBeNull();
    db.prepare("UPDATE settings SET value_json = '{bad' WHERE key = 'ui.theme'").run();
    expect(s.get("ui.theme")).toBeNull();
  });

  it("getIds reads any non-list row as empty, and drops the non-strings out of a list", () => {
    // Settings rows are user-editable JSON on disk, so every shape here is reachable without a bug.
    // This is the only place the guard lives: callers like the computer-use allowlist filter what
    // they are handed, and would throw on a row that was a number rather than a list.
    const db = openDatabase(join(tempDir("realm-"), "realm.db"));
    const s = new SettingsStore(db);
    for (const corrupt of [null, 42, "com.apple.TextEdit", { app: "x" }]) {
      s.set("computer.allowedApps:sp1", corrupt);
      expect(s.getIds("computer.allowedApps:sp1")).toEqual([]);
    }
    s.set("computer.allowedApps:sp1", ["com.apple.TextEdit", 7, null, "com.apple.mail"]);
    expect(s.getIds("computer.allowedApps:sp1")).toEqual(["com.apple.TextEdit", "com.apple.mail"]);
  });

  it("delete drops the row and leaves every other key alone", () => {
    const db = openDatabase(join(tempDir("realm-"), "realm.db"));
    const s = new SettingsStore(db);
    const rows = (): number => (db.prepare("SELECT COUNT(*) AS n FROM settings").get() as { n: number }).n;
    const before = rows();
    s.set("claude.sessionHome:a", "/tmp/a");
    s.set("claude.sessionHome:b", "/tmp/b");
    s.delete("claude.sessionHome:a");
    expect(s.get("claude.sessionHome:a")).toBeNull();
    expect(s.get("claude.sessionHome:b")).toBe("/tmp/b");
    expect(rows()).toBe(before + 1);
    s.delete("claude.sessionHome:never-set");
    expect(rows()).toBe(before + 1);
  });

  it("distinctUnder answers each value kept under a prefix once, and none kept under a key beside it", () => {
    const s = new SettingsStore(openDatabase(join(tempDir("realm-"), "realm.db")));
    expect(s.distinctUnder("claude.configDir:")).toEqual([]);
    s.set("claude.configDir:p1", "/a");
    s.set("claude.configDir:p2", "/b");
    s.set("claude.configDir:p3", "/a");
    s.set("claude.configDir:", "/named-by-the-prefix-alone");
    s.set("claude.configDir", "/before-the-range");
    s.set("claude.configDir;", "/the-end-of-the-range");
    s.set("claude.configDir;p4", "/after-the-range");
    s.set("claude.configDirs:p5", "/a-longer-name");
    s.set("claude.sessionHome:s1", "/another-prefix");
    expect(s.distinctUnder("claude.configDir:").sort()).toEqual(["/a", "/b", "/named-by-the-prefix-alone"]);
    expect(s.distinctUnder("claude.sessionHome:")).toEqual(["/another-prefix"]);
  });

  it("distinctUnder answers a value as it was kept, whatever its shape, and passes over a row that is not JSON", () => {
    const db = openDatabase(join(tempDir("realm-"), "realm.db"));
    const s = new SettingsStore(db);
    s.set("k:list", ["x"]);
    s.set("k:number", 7);
    s.set("k:broken", "kept");
    db.prepare("UPDATE settings SET value_json = '{bad' WHERE key = 'k:broken'").run();
    expect(s.distinctUnder("k:")).toEqual(expect.arrayContaining([["x"], 7]));
    expect(s.distinctUnder("k:")).toHaveLength(2);
  });
});
