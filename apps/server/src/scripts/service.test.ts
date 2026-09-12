import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "@realm/test-utils";
import { scriptCommandId, scriptsKey } from "@realm/contracts";
import { openDatabase } from "../db/database";
import { SettingsStore } from "../store/settings";
import { RpcError } from "../store/rows";
import { ScriptService, type ScriptTerminals } from "./service";

const SPACE = "spc_1";
let home: string;
let folder: string;
let settings: SettingsStore;
let service: ScriptService;
let opened: Array<{ spaceId: string; cwd: string; cols: number; rows: number }>;
let typed: Array<{ terminalId: string; command: string }>;
let titled: Array<{ id: string; title?: string }>;

const terminals = (): ScriptTerminals => ({
  open(p) { opened.push(p); return { terminalId: `trm${opened.length}`, itemId: `itm${opened.length}` }; },
  async prefill(terminalId, command) { typed.push({ terminalId, command }); },
});

beforeEach(() => {
  home = tempDir("realm-scripts-home-");
  folder = tempDir("realm-scripts-space-");
  settings = new SettingsStore(openDatabase(join(home, "realm.db")));
  opened = []; typed = []; titled = [];
  service = new ScriptService({
    settings,
    spaces: { folderPathOf: (id) => (id === SPACE ? folder : null) },
    terminals: terminals(),
    items: { update: (input) => { titled.push(input); return input; } },
  });
});

const add = (name: string, command: string, cwd: string | null = null) => service.save(SPACE, { id: null, name, command, cwd });

describe("ScriptService storage", () => {
  it("is empty, not an error, for a space that has never had one", () => {
    expect(service.list(SPACE)).toEqual([]);
  });

  it("creates with a fresh id and keeps the order they were added in", () => {
    const a = add("Test", "pnpm test");
    const b = add("Dev", "pnpm dev");
    expect(a.id).not.toBe(b.id);
    expect(service.list(SPACE).map((s) => s.name)).toEqual(["Test", "Dev"]);
    // One blob per space, under the documented key — what the keybinding layer and any future
    // migration will look for.
    expect(settings.get(scriptsKey(SPACE))).toHaveLength(2);
  });

  it("updates in place, keeping the id and the position", () => {
    const a = add("Test", "pnpm test");
    add("Dev", "pnpm dev");
    const renamed = service.save(SPACE, { id: a.id, name: "Unit tests", command: "pnpm test -- --run", cwd: null });
    expect(renamed.id).toBe(a.id);
    // The position matters as much as the id: a rename that sent the script to the bottom would move
    // a bound key's label out from under whoever bound it.
    expect(service.list(SPACE).map((s) => s.name)).toEqual(["Unit tests", "Dev"]);
  });

  it("refuses to save against an id this space does not have", () => {
    // Silently creating one would resurrect a script under an id a keymap may still point at.
    expect(() => service.save(SPACE, { id: "01JQZ0000000000000000000AA", name: "x", command: "y", cwd: null }))
      .toThrow(/not found/);
  });

  it("refuses a script with nothing to run", () => {
    expect(() => service.save(SPACE, { id: null, name: "Test", command: "   ", cwd: null })).toThrow(RpcError);
  });

  it("removes one, and says so when there was nothing to remove", () => {
    const a = add("Test", "pnpm test");
    service.remove(SPACE, a.id);
    expect(service.list(SPACE)).toEqual([]);
    expect(() => service.remove(SPACE, a.id)).toThrow(/not found/);
  });

  it("keeps every entry it can read out of a hand-edited blob", () => {
    // Settings rows are user-editable JSON. One corrupt entry costs that entry, not the space its
    // scripts — the rule SkillsService.scopeMap already follows.
    const good = add("Test", "pnpm test");
    settings.set(scriptsKey(SPACE), [{ id: "nope", name: "Broken", command: "x" }, good, { junk: true }]);
    expect(service.list(SPACE).map((s) => s.name)).toEqual(["Test"]);
  });

  it("reads a key that is not a list at all as no scripts", () => {
    settings.set(scriptsKey(SPACE), { Test: "pnpm test" });
    expect(service.list(SPACE)).toEqual([]);
  });

  it("keeps each space's scripts to itself", () => {
    add("Test", "pnpm test");
    expect(service.list("spc_2")).toEqual([]);
  });

  it("reorders, and a stale client cannot turn a reorder into a delete", () => {
    const a = add("A", "a"); const b = add("B", "b"); const c = add("C", "c");
    expect(service.reorder(SPACE, [c.id, a.id]).map((s) => s.name)).toEqual(["C", "A", "B"]);
    expect(service.reorder(SPACE, [b.id, b.id, "01JQZ0000000000000000000AA"]).map((s) => s.name)).toEqual(["B", "C", "A"]);
  });
});

describe("ScriptService.commands", () => {
  it("emits one bindable id per script, in the shape the keybinding layer parses", () => {
    const a = add("Test", "pnpm test");
    expect(service.commands(SPACE)).toEqual([{ commandId: `script.${a.id}.run`, name: "Test" }]);
    expect(service.commands(SPACE)[0]!.commandId).toBe(scriptCommandId(a.id));
  });
});

describe("ScriptService.run", () => {
  it("opens a terminal in the space folder and enters the command", async () => {
    const a = add("Test", "pnpm test");
    const run = await service.run(SPACE, a.id);
    expect(opened).toEqual([{ spaceId: SPACE, cwd: folder, cols: 80, rows: 24 }]);
    expect(run.terminalId).toBe("trm1");
    // The newline is the feature: a bound key that left the command sitting at a prompt waiting for
    // Return would have saved nobody anything.
    expect(typed).toEqual([{ terminalId: "trm1", command: "pnpm test\n" }]);
  });

  it("titles the terminal's sidebar row with the script's name", async () => {
    const a = add("Unit tests", "pnpm test");
    await service.run(SPACE, a.id);
    // Not the cwd basename `TerminalService.open` auto-titles with: three scripts run in one checkout
    // would be three identical rows.
    expect(titled).toEqual([{ id: "itm1", title: "Unit tests" }]);
  });

  it("resolves a relative cwd against the space folder, and leaves an absolute one alone", async () => {
    mkdirSync(join(folder, "apps", "server"), { recursive: true });
    const other = tempDir("realm-scripts-other-");
    const rel = add("Server", "pnpm dev", "apps/server");
    const abs = add("Elsewhere", "ls", other);
    await service.run(SPACE, rel.id);
    await service.run(SPACE, abs.id);
    expect(opened.map((o) => o.cwd)).toEqual([join(folder, "apps", "server"), other]);
  });

  it("refuses a cwd that is not there, naming the script rather than the pty", async () => {
    const a = add("Server", "pnpm dev", "apps/server");
    await expect(service.run(SPACE, a.id)).rejects.toThrow(/"Server" has no directory/);
    // And nothing was spawned: a terminal that opens only to die is worse than a refusal.
    expect(opened).toEqual([]);
  });

  it("opens a second terminal rather than typing into the first", async () => {
    const a = add("Dev", "pnpm dev");
    await service.run(SPACE, a.id);
    await service.run(SPACE, a.id);
    // `pnpm dev` is still running in the first one; typing into it would feed a dev server's stdin,
    // not re-run the script.
    expect(opened).toHaveLength(2);
    expect(typed.map((t) => t.terminalId)).toEqual(["trm1", "trm2"]);
  });

  it("says which script is missing", async () => {
    await expect(service.run(SPACE, "01JQZ0000000000000000000AA")).rejects.toThrow(/script .* not found/);
  });

  it("runs a script by its command id, and tells a non-script id apart from a missing script", async () => {
    const a = add("Test", "pnpm test");
    await service.runCommand(SPACE, scriptCommandId(a.id));
    expect(typed).toEqual([{ terminalId: "trm1", command: "pnpm test\n" }]);
    // Two different sentences for two different mistakes: one is "no such script", the other is
    // "that is not a script id at all".
    await expect(service.runCommand(SPACE, "palette.open")).rejects.toThrow(/not a script command id/);
    await expect(service.runCommand(SPACE, scriptCommandId("01JQZ0000000000000000000AA"))).rejects.toThrow(/not found/);
  });

  it("refuses when the space has no folder to run in", async () => {
    const a = add("Test", "pnpm test");
    settings.set(scriptsKey("spc_2"), [{ ...a }]);
    await expect(service.run("spc_2", a.id)).rejects.toThrow(/space spc_2 not found/);
  });
});

describe("the port block", () => {
  it("is left to the terminal service rather than copied here", () => {
    // W2 gives each environment a block of ports and `TerminalService.open` already looks it up from
    // the cwd (`envFor` → `portEnv`). A second copy in this file could disagree with the environment
    // the pty was actually spawned in — and could not win, because the pty is spawned by that call.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "service.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const copy of ["portEnv", "REALM_PORT", "PORT_BLOCK", "findByPath"]) expect(src).not.toContain(copy);
  });
});

describe("what a script run inherits", () => {
  it("hands the terminal a cwd, and nothing else", async () => {
    // The whole environment of a run is decided by that cwd: the port block, the shell, the login
    // profile. If this ever grows an `env` argument, the block above has to be revisited.
    const a = add("Test", "pnpm test");
    await service.run(SPACE, a.id);
    expect(Object.keys(opened[0]!).sort()).toEqual(["cols", "cwd", "rows", "spaceId"]);
  });
});
