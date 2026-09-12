import { describe, expect, it } from "vitest";
import { newId } from "./ids";
import { ScriptInputSchema, ScriptSchema, parseScriptCommandId, scriptCommandId, scriptsKey } from "./scripts";

const ID = newId();

describe("ScriptSchema", () => {
  it("defaults cwd to null, so a blob written before cwd existed still parses", () => {
    expect(ScriptSchema.parse({ id: ID, name: "Test", command: "pnpm test" }))
      .toEqual({ id: ID, name: "Test", command: "pnpm test", cwd: null });
  });

  it("trims, and refuses a name or command that was only whitespace", () => {
    expect(ScriptSchema.parse({ id: ID, name: "  Test  ", command: "  pnpm test  " }).command).toBe("pnpm test");
    // A script with a blank command is a key binding that spawns a terminal and does nothing — the
    // kind of dead control the pane bar bans.
    expect(ScriptSchema.safeParse({ id: ID, name: "Test", command: "   " }).success).toBe(false);
    expect(ScriptSchema.safeParse({ id: ID, name: "  ", command: "pnpm test" }).success).toBe(false);
  });

  it("refuses an id that is not a ULID", () => {
    // The id is half of `script.<id>.run`, and `parseScriptCommandId` splits on dots.
    expect(ScriptSchema.safeParse({ id: "my.script", name: "Test", command: "pnpm test" }).success).toBe(false);
  });
});

describe("ScriptInputSchema", () => {
  it("lets a client save without an id, which is what creating one is", () => {
    expect(ScriptInputSchema.parse({ name: "Test", command: "pnpm test" }))
      .toEqual({ id: null, name: "Test", command: "pnpm test", cwd: null });
  });

  it("carries an id through, which is what updating one is", () => {
    expect(ScriptInputSchema.parse({ id: ID, name: "Test", command: "pnpm test", cwd: "apps/server" }).id).toBe(ID);
  });
});

describe("scriptsKey", () => {
  it("is per space, and namespaced so it cannot collide with another feature's key", () => {
    expect(scriptsKey("spc_1")).toBe("scripts:spc_1");
    expect(scriptsKey("a")).not.toBe(scriptsKey("b"));
  });
});

describe("script command ids", () => {
  it("round-trips", () => {
    expect(scriptCommandId(ID)).toBe(`script.${ID}.run`);
    expect(parseScriptCommandId(scriptCommandId(ID))).toBe(ID);
  });

  it("is not fooled by a command id belonging to something else", () => {
    for (const other of ["", "script", "script.run", `script.${ID}`, `script.${ID}.stop`, `run.${ID}.script`,
      `scripts.${ID}.run`, `script.${ID}.run.run`, ` script.${ID}.run`]) {
      expect(parseScriptCommandId(other), other).toBeNull();
    }
  });

  it("refuses a middle that is not a ULID, rather than inventing a script id", () => {
    // A hand-edited keymap is the case: `script.mine.run` must resolve to nothing, not to a script
    // called "mine" that the store would then be asked for.
    expect(parseScriptCommandId("script.mine.run")).toBeNull();
    expect(parseScriptCommandId("script..run")).toBeNull();
  });
});
