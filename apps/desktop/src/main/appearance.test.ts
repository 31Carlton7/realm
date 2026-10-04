import { describe, expect, it } from "vitest";
import { registerAppearance, savedAppearance, type NativeTheme } from "./appearance";

function wired(start: NativeTheme["themeSource"] = "system") {
  const theme: NativeTheme = { themeSource: start };
  const files = new Map<string, string>();
  let handler: ((e: unknown, ...a: unknown[]) => void) | undefined;
  registerAppearance({ on: (c, fn) => { if (c === "appearance:set") handler = fn; }, theme, dir: "/ud", write: (p, d) => files.set(p, d) });
  return { theme, files, set: (v: unknown) => handler!(null, v) };
}

describe("native appearance", () => {
  /* THE bug: Realm's Light on a Mac set to Dark drew a light ground over the DARK window material,
     because nothing told macOS the app had its own appearance. The mutant is a handler that never
     writes themeSource — the material stays the Mac's and light mode goes grey again. */
  it("follows Realm's theme preference, not only the Mac's", () => {
    const { theme, set } = wired();
    set("light");
    expect(theme.themeSource).toBe("light");
    set("dark");
    expect(theme.themeSource).toBe("dark");
    // "System" hands the decision back to the Mac rather than pinning what it was at the time.
    set("system");
    expect(theme.themeSource).toBe("system");
  });

  it("is remembered, so the next launch opens on the right material before the renderer speaks", () => {
    const { files, set } = wired();
    set("light");
    expect(savedAppearance("/ud", (p) => files.get(p)!)).toBe("light");
  });

  it("ignores anything that is not a preference, and an unreadable record means system", () => {
    const { theme, files, set } = wired("dark");
    set("sepia");
    set(undefined);
    expect(theme.themeSource).toBe("dark");
    expect(files.size).toBe(0);
    expect(savedAppearance("/ud", () => "{not json")).toBe("system");
    expect(savedAppearance("/ud", () => { throw new Error("ENOENT"); })).toBe("system");
    expect(savedAppearance("/ud", () => JSON.stringify({ pref: "neon" }))).toBe("system");
  });

  it("does not rewrite the record when nothing changed — the renderer reports on every start", () => {
    const { files, set } = wired("light");
    set("light");
    expect(files.size).toBe(0);
  });
});
