/**
 * Let agents finish sign-ins: one switch, kept by Electron main in a file of its own (as Security
 * codes is), which no agent can write. On, an agent's security-code fill and its fill of a saved
 * password on that password's own site need no card, and a password Realm generates needs none
 * either; the profile's unlock policy still runs, Plan and Ask still refuse, and a fill on a page of
 * another site is still carded every time. Off, the first such fill raises one card asking the person
 * to turn it on.
 *
 * Main keeps the last `AGENT_FILLS_KEPT` agent fills for Settings to list: the site, the kind and the
 * session, never a value.
 */

/** What an agent filled: a saved password, one Realm generated, or a security code. */
export type AgentFillKind = "password" | "generated" | "code";

export type AgentFill = { site: string; kind: AgentFillKind; at: number; sessionId: string | null };

export type AgentSigninsStatus = { enabled: boolean; fills: AgentFill[] };

/** How many agent fills main keeps for Settings. */
export const AGENT_FILLS_KEPT = 20;

/** The `toolName` of the one card that asks the person to turn this on. Answering it turns nothing on. */
export const AGENT_SIGNINS_CARD = "agent_signins";

export const AGENT_SIGNINS_CARD_TITLE = "Let agents finish sign-ins? Opens Settings";

/**
 * Set on a password fill card's input when sign-ins are off and the fill is on the password's own
 * site: the card answers Allow once, Turn on sign-ins or Deny. Turn on sets main's switch through
 * Settings' own IPC, then answers Allow, so the fill goes ahead with no second card. Only a person
 * may answer it Allow (the broker's `personOnly`).
 */
export const AGENT_SIGNINS_OFFER = "offersSignins";

/** What an agent is told when it reached for a fill while this is off. */
export const AGENT_SIGNINS_OFF =
  "Realm asked the user to turn on agent sign-ins (Settings ▸ Passwords ▸ Let agents finish sign-ins). Nothing was filled.";

/** The transcript's line for one agent fill: the site and the kind, never the value. */
export function agentFillNote(kind: AgentFillKind, site: string): string {
  if (kind === "generated") return `Realm created a password for ${site}, saved in Settings ▸ Passwords`;
  return kind === "code" ? `Realm filled a security code on ${site}` : `Realm filled a saved password on ${site}`;
}
