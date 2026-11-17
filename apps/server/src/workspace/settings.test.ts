import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_PERMISSION_MODE_KEY, SETTING_THEME, type StoredTheme } from "@realm/contracts";
import { createSettingsTools, type SettingsDeps } from "./settings";

/**
 * `settings_get` / `settings_set` over a faked settings table. What matters: only the allowlist, by
 * name, with values from its closed lists; the user's card before a write; every window told.
 */

function setup(o: { allow?: boolean; stored?: Record<string, unknown>; importTheme?: SettingsDeps["themes"]["import"] } = {}) {
  const table = new Map<string, unknown>(Object.entries(o.stored ?? {}));
  const calls = { gates: [] as { toolKey: string; title: string }[], broadcasts: [] as { event: string; payload: Record<string, unknown> }[] };
  const deps: SettingsDeps = {
    settings: { get: (k) => table.get(k) ?? null, set: (k, v) => { table.set(k, v); } },
    themes: { import: o.importTheme ?? (() => { throw new Error("no theme expected"); }) },
    broker: { gate: async (_s, toolKey, title) => { calls.gates.push({ toolKey, title }); return o.allow === false ? { allowed: false, reason: "the user denied this action" } : { allowed: true }; } },
    rpc: { broadcast: (event: string, payload: Record<string, unknown>) => { calls.broadcasts.push({ event, payload }); } } as unknown as SettingsDeps["rpc"],
  };
  const g = createSettingsTools(deps);
  const call = (tool: string, args: unknown = {}) => g.handlers[tool]!({ sessionId: "me", spaceId: "s1" }, args);
  return { call, calls, table };
}

const text = (r: CallToolResult) => r.content.map((c) => (c as { text: string }).text).join("\n");

describe("settings_get", () => {
  it("reads every allowed setting by name, with the app's own fallback for one never set or set to something it does not offer", async () => {
    const r = await setup({ stored: { [SETTING_THEME]: "dark", "sessions.midTurnMode": "sideways" } }).call("settings_get");
    expect(text(r)).toContain(`- theme: "dark" — light or dark, or follow macOS; one of "system", "light", "dark"`);
    expect(text(r)).toContain(`- midTurnMode: "queue"`);
    expect(text(r)).toContain(`- terminalCursorBlink: true`);
  });
});

describe("settings_set", () => {
  it("asks, writes the key, and tells every window", async () => {
    const s = setup();
    const r = await s.call("settings_set", { name: "theme", value: "dark" });
    expect(r.isError).toBe(false);
    expect(s.calls.gates).toEqual([{ toolKey: "settings_set", title: `Change Realm's theme from "system" to "dark"` }]);
    expect(s.table.get(SETTING_THEME)).toBe("dark");
    expect(s.calls.broadcasts).toEqual([{ event: "settings.changed", payload: { key: SETTING_THEME, value: "dark" } }]);
  });

  it("writes nothing when the user says no", async () => {
    const s = setup({ allow: false });
    expect(text(await s.call("settings_set", { name: "theme", value: "dark" }))).toBe("the user denied this action");
    expect(s.table.has(SETTING_THEME)).toBe(false);
    expect(s.calls.broadcasts).toEqual([]);
  });

  it("refuses a setting off the list — a raw key included — before asking, and says whose it is", async () => {
    for (const name of ["defaultPermissionMode", DEFAULT_PERMISSION_MODE_KEY, "mcp.providersEnabled:s1", "toString", "__proto__"]) {
      const s = setup();
      const r = await s.call("settings_set", { name, value: "bypassPermissions" });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("is not a setting you can change");
      expect(s.calls.gates).toEqual([]);
      expect(s.table.size).toBe(0);
    }
  });

  it("refuses a value the setting does not take, before asking", async () => {
    const s = setup();
    const r = await s.call("settings_set", { name: "submitKey", value: "space" });
    expect(text(r)).toBe(`submitKey takes "enter", "cmdEnter" — not "space".`);
    expect(s.calls.gates).toEqual([]);
  });

  it("asks nobody to change a setting to what it already is", async () => {
    const s = setup({ stored: { [SETTING_THEME]: "light" } });
    expect(text(await s.call("settings_set", { name: "theme", value: "light" }))).toBe(`theme is already "light".`);
    expect(s.calls.gates).toEqual([]);
  });
});

describe("theme_import", () => {
  const ayuLight: StoredTheme = { id: "ayu-light", label: "Ayu Light", mode: "light", seed: { bg: "#fcfcfc" } as StoredTheme["seed"], source: { file: "/x/ayu-light.json", derived: [] } };
  const imports = (o: { allow?: boolean; fail?: boolean } = {}) => {
    const paths: string[] = [];
    const s = setup({ allow: o.allow, importTheme: (path) => { paths.push(path); if (o.fail) throw new Error(`no file at ${path}`); return ayuLight; } });
    return { ...s, paths };
  };

  it("asks, imports the file, and puts the face the theme is for on it in every window", async () => {
    // THE MUTANTS: importing without asking; the theme imported but not worn; the windows left on the
    // old palette until a restart; the light theme written to the dark face.
    const s = imports();
    const r = await s.call("theme_import", { path: "/x/ayu-light.json" });
    expect(r.isError).toBe(false);
    expect(s.calls.gates).toEqual([{ toolKey: "theme_import", title: "Import the colour theme at /x/ayu-light.json and switch Realm to it" }]);
    expect(s.paths).toEqual(["/x/ayu-light.json"]);
    expect(s.table.get("ui.themeName.light")).toBe("ayu-light");
    expect(s.table.has("ui.themeName.dark")).toBe(false);
    expect(s.calls.broadcasts).toEqual([
      { event: "themes.changed", payload: {} },
      { event: "settings.changed", payload: { key: "ui.themeName.light", value: "ayu-light" } },
    ]);
    expect(text(r)).toContain("Ayu Light is imported and is Realm's light theme now");
  });

  it("imports nothing when the user says no, and says why a file would not import", async () => {
    const denied = imports({ allow: false });
    expect(text(await denied.call("theme_import", { path: "/x/ayu-light.json" }))).toBe("the user denied this action");
    expect(denied.paths).toEqual([]);
    const failed = imports({ fail: true });
    const r = await failed.call("theme_import", { path: "/x/gone.json" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("Couldn't import /x/gone.json: no file at /x/gone.json");
    expect(failed.table.size).toBe(0);
    expect(failed.calls.broadcasts).toEqual([]);
  });
});
