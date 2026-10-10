import { describe, expect, it } from "vitest";
import { PANE_SHOW_WIRE_NAME, paneNotOpenError } from "./workspace";

describe("realm-workspace's names", () => {
  it("spells pane_show the way the gateway lists it, in the refusal about a closed pane", () => {
    expect(PANE_SHOW_WIRE_NAME).toBe("realm-workspace__pane_show");
    const text = paneNotOpenError("b1");
    expect(text).toContain('realm-workspace__pane_show with {"browserId": "b1"}');
    // Where the tool is switched off the agent still has something to do.
    expect(text).toContain("ask the user to reopen the browser pane");
  });
});
