import { describe, expect, it } from "vitest";
import { REALM_READ_ONLY_TOOLS } from "./realm-tools";

describe("REALM_READ_ONLY_TOOLS", () => {
  it("pins its exact contents — an addition here runs promptless on Claude and Codex both", () => {
    expect([...REALM_READ_ONLY_TOOLS]).toEqual([
      "realm-browser__browser_list", "realm-browser__browser_snapshot", "realm-browser__browser_read",
      "realm-browser__browser_screenshot", "realm-browser__browser_credentials",
      "realm-workspace__workspace_state", "realm-workspace__sessions_list", "realm-workspace__session_read",
      "realm-workspace__space_list", "realm-workspace__settings_get",
      "realm-agent__agent_peers", "realm-agent__agent_status",
      "realm-schedule__schedule_list",
      "realm-docs__docs_search", "realm-docs__docs_read", "realm-docs__docs_state",
      "realm-team__record_list", "realm-team__review_status",
      "realm-memory__memory_index", "realm-memory__memory_read", "realm-memory__memory_search",
      "realm-goal__goal_status",
      "realm-vault__vault_list",
    ]);
  });

  it("holds no tool that changes something, moves the screen, sends something, or hands over a secret", () => {
    for (const changes of [
      "realm-agent__agent_run", "realm-agent__agent_start", "realm-agent__agent_wait", "realm-agent__agent_ask",
      "realm-agent__agent_answer", "realm-agent__agent_review", "realm-agent__browser_agent_run",
      "realm-schedule__schedule_create", "realm-docs__docs_open", "realm-docs__docs_list", "realm-docs__docs_progress",
      "realm-goal__update_goal", "realm-browser__browser_fill_credential", "realm-terminal__terminal_write", "realm-ui__ui_ask",
      "realm-workspace__pane_show", "realm-workspace__session_open", "realm-workspace__space_switch", "realm-workspace__settings_set",
      "realm-team__team_roles", "realm-team__record_read", "realm-team__record_update", "realm-team__review_submit",
      "realm-team__team_handoff", "realm-team__team_mention",
      "realm-memory__memory_save", "realm-memory__memory_remove", "realm-memory__memory_write_file",
      "realm-vault__vault_http",
    ]) expect(REALM_READ_ONLY_TOOLS).not.toContain(changes);
  });

  it("names every tool by its provider, as the gateway lists it", () => {
    for (const t of REALM_READ_ONLY_TOOLS) expect(t).toMatch(/^realm-[a-z]+__[a-z_]+$/);
  });
});
