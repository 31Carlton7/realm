import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { askCardFromElicitation, elicitationContent, type AskCard } from "@realm/contracts";
import type { AskOutcome } from "../browsers/permissions";
import type { HubElicit } from "./hub";

/**
 * A question from an MCP server behind the hub, put to the user on Realm's card.
 *
 * The server is named as the server ("Linear's MCP server asks"), by the name the user gave it in
 * Connections: the same question means something different from a server than from the agent, and
 * MCP requires the client to say which server is asking. The card is the same one every other feed
 * gets, through the same broker, so it is answered from the transcript, Needs you, the Agents page or
 * Notifications alike.
 *
 * What goes back follows MCP's three actions: `accept` with the form's own types, `decline` when the
 * user said no (or Realm declined a form asking for a credential, which MCP forbids — the card says
 * so), and `cancel` when nobody answered — the server withdrew it, the session went, or fifteen
 * minutes passed. A page to open is accepted as consent alone: what happens on the page never passes
 * through Realm.
 */
export function createHubElicitation(d: {
  broker: { ask(sessionId: string, card: AskCard, o: { toolName: string; title: string; input?: Record<string, unknown>; signal?: AbortSignal }): Promise<AskOutcome> };
  serverName: (serverId: string) => string | null;
}): HubElicit {
  return async ({ serverId, sessionId, params, signal }): Promise<ElicitResult> => {
    const card = askCardFromElicitation(params, { kind: "server", name: d.serverName(serverId) ?? "An MCP server" });
    const title = typeof params.message === "string" && params.message ? params.message : `${card.asker.name} asks`;
    const outcome = await d.broker.ask(sessionId, card, { toolName: "elicitation", title, signal });
    switch (outcome.outcome) {
      case "answered": return card.mode === "url" ? { action: "accept" } : { action: "accept", content: elicitationContent(card, outcome.answers) };
      case "skipped": case "refused": return { action: "decline" };
      case "timeout": case "cancelled": return { action: "cancel" };
    }
  };
}
