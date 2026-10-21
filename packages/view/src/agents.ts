import { AGENT_META, AGENT_MODELS, DEFAULT_MODEL_LABEL, type AgentKind } from "@realm/contracts";

/** A model id's name: the probe's live catalog first (Codex, Cursor), the curated list next
 *  (Claude), and the id itself when neither has heard of it — a wrong name is worse than the id.
 *  Named as the picker names it under its harness: "Opus 5.5" beside Claude's mark.
 *
 *  Shared (`@realm/view`) so Realm Mobile names a session's model the way the desktop does. */
export function modelLabel(kind: AgentKind, id: string | null, probe: readonly { kind: AgentKind; models?: readonly { id: string; label: string }[] | null }[]): string {
  if (id === null) return DEFAULT_MODEL_LABEL[kind];
  const named = (probe.find((p) => p.kind === kind)?.models ?? []).find((m) => m.id === id)
    ?? (AGENT_MODELS[kind] as readonly { id: string; label: string }[]).find((m) => m.id === id);
  const label = named?.label.replace(/\[[^\]]*\]\s*$/, "") ?? id;
  // Beside the harness's own mark the harness's name is said twice — "Claude Fable 5.1" on one row
  // and the default "Fable 5.1" on the next read as two models. The picker's rule: the word comes off
  // only when what follows is itself a name, never leaving a bare version.
  const harness = `${AGENT_META[kind].label} `;
  const rest = label.startsWith(harness) ? label.slice(harness.length) : null;
  return rest !== null && /^[A-Za-z]+(\s|$)/.test(rest) ? rest : label;
}

/** The setting the desktop keeps the agent of the session last made or switched to under: what its
 *  "+" and ⌘N reach for next, and what a new session started from Realm Mobile is offered first. */
export const LAST_AGENT_SETTING = "ui.lastAgentKind";

/** Agent a session is created with when the user never said (first run, or a wiped setting). */
export const FALLBACK_AGENT: AgentKind = "claude";
