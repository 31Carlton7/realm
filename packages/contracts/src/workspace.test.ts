import { describe, expect, it } from "vitest";
import { PANE_SHOW_WIRE_NAME, WORKSPACE_READ_ONLY_TOOLS, paneNotOpenError } from "./workspace";

describe("realm-workspace's names", () => {
  it("spells pane_show the way the gateway lists it, in the refusal about a closed pane", () => {
    expect(PANE_SHOW_WIRE_NAME).toBe("realm-workspace__pane_show");
    const text = paneNotOpenError("b1");
    expect(text).toContain('realm-workspace__pane_show with {"browserId": "b1"}');
    // Where the tool is switched off the agent still has something to do.
    expect(text).toContain("ask the user to reopen the browser pane");
  });

  it("lists only tools that read as read-only", () => {
    // THE MUTANT: add pane_show here. It changes the user's screen, and this list is pre-allowed in
    // Claude and never gated by Realm.
    expect([...WORKSPACE_READ_ONLY_TOOLS]).toEqual(["workspace_state", "sessions_list", "session_read"]);
  });
});
