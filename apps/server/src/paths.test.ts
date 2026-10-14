import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appDataDir } from "./paths";

describe("appDataDir", () => {
  it("is Application Support on a Mac", () => {
    expect(appDataDir("/Users/me", "darwin", {})).toBe(join("/Users/me", "Library", "Application Support"));
  });

  it("is roaming AppData on Windows, as the system names it", () => {
    expect(appDataDir("C:\\Users\\me", "win32", { APPDATA: "D:\\Profiles\\me\\AppData\\Roaming" })).toBe("D:\\Profiles\\me\\AppData\\Roaming");
    expect(appDataDir("/home/me", "win32", {})).toBe(join("/home/me", "AppData", "Roaming"));
  });

  it("is XDG's data home on Linux, never a Mac's Library", () => {
    expect(appDataDir("/home/me", "linux", {})).toBe(join("/home/me", ".local", "share"));
    expect(appDataDir("/home/me", "linux", { XDG_DATA_HOME: "/data/me" })).toBe("/data/me");
  });
});
