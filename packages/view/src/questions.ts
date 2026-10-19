import { AskCardSchema, askCardFromAskUserQuestion, type AskCard } from "@realm/contracts";

/** The question a request carries, Realm's own card first — a declined one included, since the
 *  transcript still says what was declined. Claude's `AskUserQuestion` from before the card rode the
 *  event is read off its input. Never anything an agent's arguments could make look like one.
 *
 *  Shared (`@realm/view`) because Realm Mobile draws the same requests as questions that the desktop
 *  does: the phone's rows are read by this rule on the Mac, not by a copy of it. */
export function questionOf(p: { toolName: string; input: Record<string, unknown>; ask?: unknown }): AskCard | null {
  if (p.ask !== undefined) { const card = AskCardSchema.safeParse(p.ask); return card.success ? card.data : null; }
  return p.toolName === "AskUserQuestion" ? askCardFromAskUserQuestion(p.input, { kind: "agent", name: "Claude", agent: "claude" }) : null;
}
