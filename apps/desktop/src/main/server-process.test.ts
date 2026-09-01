// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseServerLine, ReadyLineParser, resolveServerEntry } from "./server-process";

describe("parseServerLine", () => {
  it("parses ready and error lines, ignores everything else", () => {
    expect(parseServerLine('{"type":"ready","port":4321,"home":"/h"}')).toEqual({ type: "ready", port: 4321, home: "/h" });
    expect(parseServerLine('{"type":"error","message":"boom"}')).toEqual({ type: "error", message: "boom" });
    expect(parseServerLine("not json")).toBeNull();
    expect(parseServerLine('{"type":"other"}')).toBeNull();
    expect(parseServerLine('{"type":"ready","port":"x"}')).toBeNull();
    expect(parseServerLine("")).toBeNull();
  });
});

describe("ReadyLineParser", () => {
  it("handles multiple lines in one chunk", () => {
    const p = new ReadyLineParser();
    expect(p.feed('noise\n{"type":"ready","port":1,"home":"/a"}\n')).toEqual({ type: "ready", port: 1, home: "/a" });
  });
  it("handles a line split across chunks", () => {
    const p = new ReadyLineParser();
    expect(p.feed('{"type":"ready","po')).toBeNull();
    expect(p.feed('rt":2,"home":"/b"}\n')).toEqual({ type: "ready", port: 2, home: "/b" });
  });
  it("returns error lines", () => {
    const p = new ReadyLineParser();
    expect(p.feed('{"type":"error","message":"port in use"}\n')).toEqual({ type: "error", message: "port in use" });
  });
  it("skips non-JSON noise then finds ready", () => {
    const p = new ReadyLineParser();
    expect(p.feed("(node:1) ExperimentalWarning: SQLite\n")).toBeNull();
    expect(p.feed('{"type":"ready","port":3,"home":"/c"}\n')).toEqual({ type: "ready", port: 3, home: "/c" });
  });
  it("does not emit a partial trailing line without newline", () => {
    const p = new ReadyLineParser();
    expect(p.feed('{"type":"ready","port":4,"home":"/d"}')).toBeNull();
    expect(p.feed("\n")).toEqual({ type: "ready", port: 4, home: "/d" });
  });
});

describe("resolveServerEntry", () => {
  const base = { override: undefined, appPath: "/repo/apps/desktop", resourcesPath: "/Applications/Realm.app/Contents/Resources" };
  it("dev: sibling workspace dist, relative to the desktop app path", () => {
    expect(resolveServerEntry({ ...base, packaged: false })).toBe("/repo/apps/server/dist/main.js");
  });
  it("packaged: staged extraResources copy under Resources/server", () => {
    expect(resolveServerEntry({ ...base, packaged: true })).toBe("/Applications/Realm.app/Contents/Resources/server/dist/main.js");
  });
  it("REALM_SERVER_ENTRY override wins in both modes", () => {
    expect(resolveServerEntry({ ...base, override: "/x/main.js", packaged: false })).toBe("/x/main.js");
    expect(resolveServerEntry({ ...base, override: "/x/main.js", packaged: true })).toBe("/x/main.js");
  });
});
