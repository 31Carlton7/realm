import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { openDatabase } from "../db/database"; import { SettingsStore } from "./settings";
describe("SettingsStore", () => {
  it("get returns null for missing, set/get roundtrips JSON", () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), "realm-")), "realm.db"));
    const s = new SettingsStore(db);
    expect(s.get("ui.activeSpaceId")).toBeNull();
    s.set("ui.theme", { mode: "system" });
    expect(s.get("ui.theme")).toEqual({ mode: "system" });
    s.set("ui.theme", "dark"); expect(s.get("ui.theme")).toBe("dark");
    s.set("ui.theme", undefined); expect(s.get("ui.theme")).toBeNull();
    db.prepare("UPDATE settings SET value_json = '{bad' WHERE key = 'ui.theme'").run();
    expect(s.get("ui.theme")).toBeNull();
  });
});
