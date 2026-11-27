import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserPermissionBroker } from "../browsers/permissions";
import { err } from "./tool-result";

/**
 * The gate every agent write to Realm itself goes through: the person started this turn, and, where
 * the tool asks for one, the person answered its card. A turn a teammate's message, a schedule,
 * another session or the engine started is refused, naming who started it, so the agent can tell
 * the person what to say and where.
 */
export type AgentWriteGateDeps = {
  sessions: { personStartedTurn(sessionId: string): boolean };
  /** Who started the caller's turn, in words (`TeammatesService.turnOrigin`). */
  turnOrigin(sessionId: string): string;
};

/** The refusal's words: "<rule> only in a turn the person started; ask them to say it in <where>. <nothing>" */
export type AgentWriteRule = {
  /** What is done only in a person's turn: "Spaces are made", "Access changes". */
  rule: string;
  /** Where the person says it: "this chat", "your chat". */
  where: string;
  /** What did not happen: "Nothing was made.", "Nothing changed." */
  nothing: string;
};

export type AgentWriteCard = {
  /** The key `allow_always` remembers, and the tool name the card shows. */
  toolKey: string;
  title: string;
  input: Record<string, unknown>;
  /** Shown even on Full access, and never remembered as "always". */
  always?: boolean;
};

/** The refusal to return when the person did not start this turn, or null when they did. */
export function refuseUnlessPersonTurn(d: AgentWriteGateDeps, sessionId: string, words: AgentWriteRule): CallToolResult | null {
  if (d.sessions.personStartedTurn(sessionId)) return null;
  return err(`refused: this turn was started by ${d.turnOrigin(sessionId)}, not by the person. ${words.rule} only in a turn the person started; ask them to say it in ${words.where}. ${words.nothing}`);
}

/** The card for one write; the refusal to return when the person (or the session's mode) says no, or null. */
export async function askCard(broker: Pick<BrowserPermissionBroker, "gate">, sessionId: string, card: AgentWriteCard): Promise<CallToolResult | null> {
  const gate = await broker.gate(sessionId, card.toolKey, card.title, card.input, card.toolKey, card.always ? { alwaysPrompt: true } : {});
  return gate.allowed ? null : err(gate.reason);
}

/** Both, in order: the person's turn first, so a turn that is not theirs never puts a card in front of them. */
export async function requirePersonTurnAndCard(
  d: AgentWriteGateDeps & { broker: Pick<BrowserPermissionBroker, "gate"> },
  sessionId: string,
  words: AgentWriteRule,
  card: AgentWriteCard,
): Promise<CallToolResult | null> {
  return refuseUnlessPersonTurn(d, sessionId, words) ?? askCard(d.broker, sessionId, card);
}
