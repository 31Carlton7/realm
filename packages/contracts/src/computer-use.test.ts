import { describe, expect, it } from "vitest";
import { ComputerActionSchema, parseKeySpec } from "./computer-use";

describe("parseKeySpec", () => {
  it("reads a bare named key", () => {
    expect(parseKeySpec("Return")).toEqual({ key: "Return", modifiers: [] });
    expect(parseKeySpec("  Escape ")).toEqual({ key: "Escape", modifiers: [] });
  });

  it("reads a single printable character", () => {
    expect(parseKeySpec("a")).toEqual({ key: "a", modifiers: [] });
    expect(parseKeySpec("/")).toEqual({ key: "/", modifiers: [] });
  });

  it("treats cmd, command, super and meta as the same key", () => {
    for (const alias of ["cmd", "command", "super", "meta", "CMD", "Super"]) {
      expect(parseKeySpec(`${alias}+c`)).toEqual({ key: "c", modifiers: ["command"] });
    }
  });

  it("reads multi-modifier chords in order, without duplicates", () => {
    expect(parseKeySpec("ctrl+shift+t")).toEqual({ key: "t", modifiers: ["control", "shift"] });
    expect(parseKeySpec("cmd+command+s")).toEqual({ key: "s", modifiers: ["command"] });
    expect(parseKeySpec("cmd+alt+esc")).toEqual({ key: "esc", modifiers: ["command", "option"] });
  });

  it("preserves the key's case but matches names case-insensitively", () => {
    expect(parseKeySpec("cmd+A")).toEqual({ key: "A", modifiers: ["command"] });
    expect(parseKeySpec("PAGEUP")).toEqual({ key: "PAGEUP", modifiers: [] });
  });

  it("refuses an unknown modifier rather than treating it as the key", () => {
    expect(parseKeySpec("hyper+c")).toBeNull();
  });

  it("refuses a multi-character key that is not a known name", () => {
    // The failure this prevents: a `type` request arriving at `key`, where pressing the first
    // letter would look like a partial success rather than a mistake.
    expect(parseKeySpec("hello")).toBeNull();
    expect(parseKeySpec("cmd+hello")).toBeNull();
  });

  it("reads the plus key, which splitting on + would otherwise eat", () => {
    expect(parseKeySpec("+")).toEqual({ key: "+", modifiers: [] });
  });

  it("refuses empty input", () => {
    expect(parseKeySpec("")).toBeNull();
    expect(parseKeySpec("   ")).toBeNull();
  });
});

describe("ComputerActionSchema", () => {
  it("defaults a click to a single left click with no modifiers", () => {
    const parsed = ComputerActionSchema.parse({ kind: "click", index: 4 });
    expect(parsed).toEqual({ kind: "click", index: 4, button: "left", clickCount: 1, modifiers: [] });
  });

  it("allows a click by coordinates with no element", () => {
    expect(ComputerActionSchema.safeParse({ kind: "click", x: 10, y: 20 }).success).toBe(true);
  });

  it("allows type and key with no element, meaning the app's current focus", () => {
    expect(ComputerActionSchema.safeParse({ kind: "type", text: "hi" }).success).toBe(true);
    expect(ComputerActionSchema.safeParse({ kind: "key", key: "Return" }).success).toBe(true);
  });

  it("requires an element for the actions that cannot mean anything without one", () => {
    expect(ComputerActionSchema.safeParse({ kind: "setValue", text: "x" }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ kind: "menu" }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ kind: "drag", index: 1 }).success).toBe(false);
  });

  it("rejects empty type text and out-of-range click counts", () => {
    expect(ComputerActionSchema.safeParse({ kind: "type", text: "" }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ kind: "click", index: 1, clickCount: 9 }).success).toBe(false);
  });

  it("rejects an unknown modifier name", () => {
    expect(ComputerActionSchema.safeParse({ kind: "click", index: 1, modifiers: ["hyper"] }).success).toBe(false);
  });
});
