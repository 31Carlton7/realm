import { describe, expect, it } from "vitest";
import { TerminalBuffer } from "./terminal-buffer";

describe("TerminalBuffer", () => {
  it("buffers data until a sink attaches, then flushes and streams", () => {
    const b = new TerminalBuffer();
    b.push("a"); b.push("b");
    const out: string[] = [];
    b.attach((d) => out.push(d));
    expect(out).toEqual(["ab"]);
    b.push("c");
    expect(out).toEqual(["ab", "c"]);
  });
  it("caps retained scrollback to maxChars", () => {
    const b = new TerminalBuffer(5);
    b.push("123456789");
    const out: string[] = []; b.attach((d) => out.push(d));
    expect(out).toEqual(["56789"]);
  });
});
