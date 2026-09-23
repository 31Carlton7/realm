import { describe, expect, it } from "vitest";
import { sessionEvent } from "@realm/contracts";
import { activityOf } from "./session-activity";

describe("activityOf", () => {
  it("reads a tool call as the tool's own summary, with the tool's glyph", () => {
    expect(activityOf(sessionEvent("tool_call", { toolUseId: "t1", name: "Bash", input: { command: "pnpm vitest run" }, parentToolUseId: null }, 7)))
      .toEqual({ text: "pnpm vitest run", icon: "terminal", ts: 7, tool: "Bash" });
    expect(activityOf(sessionEvent("tool_call", { toolUseId: "t2", name: "Edit", input: { file_path: "src/store.ts" }, parentToolUseId: null }, 7)))
      .toEqual({ text: "src/store.ts", icon: "artifact", ts: 7, tool: "Edit" });
  });

  it("falls back to the tool's name when the call has nothing quotable in it", () => {
    /* The mutant: return the empty summary. The call happened, and a blank line on the tile would
       say the agent had stopped when it had not. */
    expect(activityOf(sessionEvent("tool_call", { toolUseId: "t", name: "Bash", input: {}, parentToolUseId: null }, 1)))
      .toEqual({ text: "Bash", icon: "terminal", ts: 1, tool: "Bash" });
  });

  it("reads a permission request as what it is blocked on", () => {
    expect(activityOf(sessionEvent("permission_request", { requestId: "r", toolName: "Bash", input: {}, title: "Run rm -rf build", suggestions: [] }, 3)))
      .toEqual({ text: "Run rm -rf build", icon: "lock", ts: 3, tool: null });
  });

  it("reads prose and the ask, each with its own glyph, collapsed onto one line", () => {
    expect(activityOf(sessionEvent("assistant_text", { messageId: "m", text: "Found it.\n\nThe bug is in  the reducer." }, 2)))
      .toEqual({ text: "Found it. The bug is in the reducer.", icon: "bot", ts: 2, tool: null });
    expect(activityOf(sessionEvent("user_message", { text: "Port the picker to the new API", attachments: [] }, 4)))
      .toEqual({ text: "Port the picker to the new API", icon: "send", ts: 4, tool: null });
  });

  it("clips a long line rather than handing the tile a paragraph", () => {
    const said = activityOf(sessionEvent("assistant_text", { messageId: "m", text: "x".repeat(300) }, 1));
    expect(said!.text).toHaveLength(90);
    expect(said!.text.endsWith("…")).toBe(true);
  });

  it("says nothing for events that are not an account of the work", () => {
    /* The mutant: answer these with a word like "Working". They carry no account of what the agent
       is doing, so the last real line has to stand — and a line true of every agent at all times
       would have replaced it. `assistant_delta` is the costly one: folding it would write to the
       store once per token per session. */
    expect(activityOf(sessionEvent("assistant_delta", { messageId: "m", delta: "tok" }, 1))).toBeNull();
    expect(activityOf(sessionEvent("status", { status: "idle" }, 1))).toBeNull();
    expect(activityOf(sessionEvent("thinking", { messageId: "m", text: "hm" }, 1))).toBeNull();
    expect(activityOf(sessionEvent("tool_result", { toolUseId: "t", content: "ok", isError: false }, 1))).toBeNull();
  });

  it("carries an error through, because what it died on is the point of the row", () => {
    expect(activityOf(sessionEvent("error", { message: "ENOSPC: no space left on device" }, 5)))
      .toEqual({ text: "ENOSPC: no space left on device", icon: "errorCircle", ts: 5, tool: null });
  });

  it("says nothing for an event whose text is empty", () => {
    /* The mutant: return `{ text: "" }`. An empty line still replaces the last real one. */
    expect(activityOf(sessionEvent("assistant_text", { messageId: "m", text: "   " }, 1))).toBeNull();
  });
});
