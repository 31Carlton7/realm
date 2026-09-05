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
});
