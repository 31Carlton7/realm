import { AGENT_META, AGENT_MODELS, DEFAULT_MODEL_LABEL, type AgentKind } from "@realm/contracts";

/** A model id's name: the probe's live catalog first (Codex, Cursor), the curated list next
 *  (Claude), and the id itself when neither has heard of it — a wrong name is worse than the id.
 *  Named as the picker names it under its harness: "Opus 5.5" beside Claude's mark.
 *
 *  Shared (`@realm/view`) so Realm Mobile names a session's model the way the desktop does. */
export function modelLabel(kind: AgentKind, id: string | null, probe: readonly { kind: AgentKind; models?: readonly { id: string; label: string; isDefault?: boolean }[] | null }[]): string {
  const live = probe.find((p) => p.kind === kind)?.models ?? [];
  // Nothing pinned runs the CLI's own default, which its model list marks; Realm's guess only without one.
  const named = id === null ? live.find((m) => m.isDefault)
    : live.find((m) => m.id === id) ?? (AGENT_MODELS[kind] as readonly { id: string; label: string }[]).find((m) => m.id === id);
  const label = named ? named.label.replace(/\[[^\]]*\]\s*$/, "") : id ?? DEFAULT_MODEL_LABEL[kind];
  // Beside the harness's own mark the harness's name is said twice — "Claude Fable 5.1" on one row
  // and the default "Fable 5.1" on the next read as two models. The picker's rule: the word comes off
  // only when what follows is itself a name, never leaving a bare version.
  const harness = `${AGENT_META[kind].label} `;
  const rest = label.startsWith(harness) ? label.slice(harness.length) : null;
  return rest !== null && /^[A-Za-z]+(\s|$)/.test(rest) ? rest : label;
}

/**
 * The model a session is on, by id: the pinned one, else the one its newest handshake reported
 * (`ran`), else the one its CLI's list marks as its default. Null when none of them has said, which
 * is not a guess at the head of Realm's curated list: this Mac's CLI may run something else.
 */
export function sessionModelId(kind: AgentKind, model: string | null, probe: Parameters<typeof modelLabel>[2], ran: string | null = null): string | null {
  if (model !== null) return model;
  if (ran) return ran.replace(/\[[^\]]*\]$/, "");
  return probe.find((p) => p.kind === kind)?.models?.find((m) => m.isDefault)?.id ?? null;
}

/**
 * The model a session is on, as the chip names it: `sessionModelId`'s model by `modelLabel`, and
 * "Default" while nothing has said which one that is. An agent with no curated list keeps its own
 * default's name.
 */
export function sessionModelLabel(kind: AgentKind, model: string | null, probe: Parameters<typeof modelLabel>[2], ran: string | null = null): string {
  const id = sessionModelId(kind, model, probe, ran);
  return id !== null || AGENT_MODELS[kind].length === 0 ? modelLabel(kind, id, probe) : "Default";
}

/** The setting the desktop keeps the agent of the session last made or switched to under: what its
 *  "+" and ⌘N reach for next, and what a new session started from Realm Mobile is offered first. */
export const LAST_AGENT_SETTING = "ui.lastAgentKind";

/** The setting the desktop keeps the model of each agent's last message under, by agent: what a new
 *  teammate starts on, on the Mac or a phone. */
export const LAST_MODELS_SETTING = "ui.lastModels";

/** Agent a session is created with when the user never said (first run, or a wiped setting). */
export const FALLBACK_AGENT: AgentKind = "claude";
