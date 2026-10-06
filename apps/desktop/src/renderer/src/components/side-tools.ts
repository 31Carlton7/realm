import type { IconName } from "@realm/ui";
import type { AppState, NewTabTool } from "../state/store";

/**
 * The tools a session opens beside itself, in one list: the side pane's "+" offers them and a blank
 * tab's page lists them, so neither can grow one the other is missing.
 *
 * They are launched from the side pane because that is where every one of them lands. They used to
 * be seven glyphs in the session's own bar, which made the bar the loudest thing at the top of the
 * window and said nothing about the session it headed (the owner, 10-05: "I don't know how much I
 * like having all those buttons there at the top. Some can be implemented into the tabs on the side").
 * The bar now carries what is about the session; a new tab is a browser, which the "+" already made.
 *
 * Documents leads: it is where a file is found as well as made, so it is the one row for both.
 */
export const SIDE_TOOLS: readonly { tool: NewTabTool; label: string; icon: IconName; hint: string }[] = [
  { tool: "documents", label: "Documents", icon: "documents", hint: "Find, open or make a file: the session's, the Library's and the checkout's" },
  { tool: "terminal", label: "Terminal", icon: "terminal", hint: "A shell in the session's checkout" },
  { tool: "agents", label: "Agents", icon: "agents", hint: "This session's sub-agents, and work to hand them" },
  { tool: "simulator", label: "Simulator", icon: "simulator", hint: "A device on this Mac" },
  { tool: "machine", label: "Machine", icon: "machine", hint: "Connect to another computer" },
];

/**
 * Whether `tool` can open beside `sessionId` right now. Documents waits for the session's checkout,
 * because an action that could only no-op is a row nobody should be offered. The terminal is a tab
 * only in its default place: docked to the pane's foot (Settings) it is the session's own panel, and
 * its control is on the session's bar.
 */
export function sideToolReady(s: AppState, sessionId: string, tool: NewTabTool): boolean {
  if (tool === "documents") { const e = s.sessions[sessionId]?.environmentId; return !!e && !!s.environments[e]; }
  if (tool === "terminal") return s.terminalDock !== "bottom";
  return true;
}

/** Open `tool` as a tab of `sessionId`'s side pane, with the keyboard, because a person asked for it.
 *  The terminal is the session's own — gone to when it has one (⌘J) — and so is its Agents tab. */
export async function openSideTool(s: AppState, sessionId: string, tool: NewTabTool): Promise<void> {
  const beside = { sessionId };
  if (tool === "terminal") return s.showSessionTerminal(sessionId);
  if (tool === "agents") return s.openAgentsTab(sessionId);
  if (tool === "simulator") return s.newSimulator(null, beside);
  if (tool === "machine") return s.newMachine(null, beside);
  await s.openDocuments(s.sessions[sessionId]?.environmentId ?? null, null, beside);
}
