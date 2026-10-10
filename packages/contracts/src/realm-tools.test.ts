import { describe, expect, it } from "vitest";
import { REALM_READ_ONLY_TOOLS } from "./realm-tools";

describe("REALM_READ_ONLY_TOOLS", () => {
  it("pins its exact contents — an addition here runs promptless on Claude and Codex both", () => {
    expect([...REALM_READ_ONLY_TOOLS]).toEqual([
      "realm-browser__browser_list", "realm-browser__browser_snapshot", "realm-browser__browser_read",
      "realm-browser__browser_screenshot", "realm-browser__browser_credentials",
      "realm-agent__agent_peers", "realm-agent__agent_status",
      "realm-schedule__schedule_list",
      "realm-docs__docs_search",
      "goal__goal_status",
    ]);
  });

  it("holds no tool that changes something, sends something, or hands over a secret", () => {
    for (const changes of [
      "realm-agent__agent_run", "realm-agent__agent_start", "realm-agent__agent_wait", "realm-agent__agent_ask",
      "realm-agent__agent_answer", "realm-agent__agent_review", "realm-agent__browser_agent_run",
      "realm-schedule__schedule_create", "realm-docs__docs_open", "realm-docs__docs_list", "realm-docs__docs_progress",
      "goal__update_goal", "realm-browser__browser_fill_credential", "realm-terminal__terminal_write", "realm-ui__ui_ask",
    ]) expect(REALM_READ_ONLY_TOOLS).not.toContain(changes);
  });
});
