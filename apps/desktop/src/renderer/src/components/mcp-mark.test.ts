import { CONNECTORS, connectorServerName } from "@realm/contracts";
import { brandMarks, icons } from "@realm/ui";
import { describe, expect, it } from "vitest";
import { isRealmServer, mcpServerMark } from "./mcp-mark";

describe("an MCP server's calls wear its app's mark", () => {
  it("names the vendors by how their servers are named, wherever they were added", () => {
    const cases: [string, string][] = [
      // claude.ai's connectors, as Claude Code names them.
      ["claude_ai_Gmail", "gmail"], ["claude_ai_Google_Calendar", "googleCalendar"], ["claude_ai_Google_Drive", "googleDrive"],
      ["claude_ai_Notion", "notion"], ["claude_ai_Linear", "linear"], ["claude_ai_Figma", "figma"], ["claude_ai_PostHog", "posthog"],
      // Rows someone added in Connections, under names of their own.
      ["gmail", "gmail"], ["gmail-work", "gmail"], ["google-drive", "googleDrive"], ["google_calendar_personal", "googleCalendar"],
      ["github", "github"], ["slack", "slack"], ["vercel", "vercel"], ["stripe", "stripe"], ["sentry", "sentry"],
      ["supabase", "supabase"], ["atlassian", "atlassian"], ["confluence", "atlassian"], ["jira", "jira"],
    ];
    for (const [server, mark] of cases) expect(mcpServerMark(server), server).toBe(mark);
  });

  it("a connector Realm registered wears the mark its card on the Connections page wears", () => {
    // One mapping, not two: the card's `icon` IS the resolver's answer for the row it registered.
    for (const c of CONNECTORS) expect(mcpServerMark(connectorServerName(c)), c.id).toBe(c.icon);
    expect(isRealmServer("realm-linear")).toBe(false);
  });

  it("Realm's own servers wear the glyph of the pane they drive", () => {
    const cases: [string, string][] = [
      ["realm-browser", "browser"], ["realm-terminal", "terminal"], ["realm-simulator", "simulator"],
      ["realm-docs", "documents"], ["realm-agent", "agents"], ["realm-computer", "pointer"], ["realm-vm", "machine"],
    ];
    for (const [server, mark] of cases) {
      expect(mcpServerMark(server), server).toBe(mark);
      expect(isRealmServer(server), server).toBe(true);
    }
  });

  it("what it cannot name keeps the plug every connection wears", () => {
    expect(mcpServerMark("my-tools")).toBe("plug");
    expect(mcpServerMark("realm-something-new")).toBe("plug");
    // A word that merely starts like a vendor's is not that vendor.
    expect(mcpServerMark("githubby")).toBe("plug");
  });

  it("every mark it can answer is one Icon can draw", () => {
    const names = ["gmail", "google_calendar", "google_drive", "posthog", "stripe", "supabase", "atlassian", "confluence", "jira",
      "realm-browser", "realm-terminal", "realm-simulator", "realm-docs", "realm-agent", "realm-team", "realm-computer", "realm-vm",
      "realm-schedule", "realm-workspace", "realm-app", "realm-ui", "realm-goal", "nothing"];
    for (const n of names) {
      const mark = mcpServerMark(n);
      expect(Object.hasOwn(brandMarks, mark) || Object.hasOwn(icons, mark), `${n} → ${mark}`).toBe(true);
    }
  });
});
