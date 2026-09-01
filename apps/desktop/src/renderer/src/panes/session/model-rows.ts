import { AGENT_META, AGENT_MODELS, DEFAULT_MODEL_LABEL, SELECTABLE_AGENT_KINDS, type AgentKind } from "@realm/contracts";
import { agentAvailability, availabilityNote } from "../../state/agent-availability";
import type { AgentProbe } from "../../state/store";

/** One pickable line in the model picker: a model, and the agent that would run it. */
export type ModelRow = {
  /** Stable identity for React keys and tests. */
  key: string;
  kind: AgentKind;
  /** `null` for an agent whose models Realm cannot enumerate — picking it leaves the adapter default. */
  modelId: string | null;
  /** The model's own name — the row's headline, and what search matches first. */
  label: string;
  /** The agent's name — the row's second line, beside its brand mark. Also searchable. */
  agentLabel: string;
  icon: string;
  /** "not installed" / "signed out", or null when the CLI is fine (or unprobed). */
  note: string | null;
  /** Why this row cannot be picked right now; `null` when it can. */
  blockedReason: string | null;
  /** The model this session is actually on — at most one row, and always one when rows exist. */
  selected: boolean;
};

/**
 * Every model the user could put behind this session, current agent first.
 *
 * Two rules carry the weight here:
 *
 * - **Agents with no enumerable model list still get a row.** Codex and Cursor report no models, but a
 *   provider you cannot enumerate is still a provider you can pick — the row names the adapter's own
 *   frontier default (`DEFAULT_MODEL_LABEL`) and picks the agent alone.
 * - **Cross-agent rows go unavailable after the first message, and say so.** `sessions.setAgent`
 *   refuses once a session has any event, because a transcript, a providerSessionId and a resume are
 *   all tied to the agent that produced them. They are marked rather than hidden: a picker that
 *   quietly drops Codex reads as a bug, not as a rule.
 *
 * Availability (`agentProbe`) is reported but never blocking — picking a missing CLI lands on the
 * install card with the exact command, which is somewhere to go; disabling the row hides the fix.
 *
 * Model lists come from THREE sources, most honest first:
 *
 * 1. **The probe's live catalog** (`agentProbe[kind].models`) — ids the provider itself handed over
 *    (Codex `model/list`, Cursor's ACP `availableModels`). A probe-sourced list additionally gets a
 *    leading DEFAULT row (`modelId: null`, the adapter's own default): unlike the curated static
 *    lists, a live catalog's ordering carries no promise that its first entry IS the default the
 *    adapter runs un-pinned (Cursor's catalog leads with "Auto" while an un-pinned session runs
 *    Composer — verified live), so `model === null` selects the explicit default row instead of
 *    guessing at index 0. Stale-by-TTL is fine; a probe list is never mixed across kinds.
 * 2. **The static curated list** (`AGENT_MODELS[kind]`) — Claude, whose CLI has no enumeration
 *    channel, plus any kind whose probe has not answered (or answered without models).
 * 3. **The single DEFAULT_MODEL_LABEL row** — a kind with no list at all.
 *
 * `model === null` means the user has pinned nothing and the adapter is running its own default. That
 * still marks a row: the frontier model, which is the first of the kind's list and the one the chip
 * already names via `DEFAULT_MODEL_LABEL` (presets.test.ts pins the two to each other). A picker that
 * showed no selection at all would read as broken every time a session had not been touched.
 */
export function modelRows({ kind, model, agentProbe, canSwitchAgent }: {
  kind: AgentKind; model: string | null; agentProbe: AgentProbe[]; canSwitchAgent: boolean;
}): ModelRow[] {
  // The session's own kind leads, then the rest of the offered set. Putting it first keeps the row the
  // user is on at the top, and after the first message it is the only group that can be picked at all.
  // It also covers a kind that is not offered fresh (`fake`), which would otherwise have no row.
  const kinds: AgentKind[] = [kind, ...SELECTABLE_AGENT_KINDS.filter((k) => k !== kind)];
  return kinds.flatMap((k): ModelRow[] => {
    const meta = AGENT_META[k];
    const blockedReason = !canSwitchAgent && k !== kind
      ? `${meta.label} can’t be picked — this session has already run, and a session's agent can only change before its first message.`
      : null;
    const base = { kind: k, agentLabel: meta.label, icon: meta.icon, note: availabilityNote(agentAvailability(k, agentProbe)), blockedReason };
    const onThisAgent = k === kind;
    // Strictly this kind's own probe entry: rendering kind A's catalog under kind B would offer ids
    // agent B rejects on the wire.
    const probed = agentProbe.find((p) => p.kind === k)?.models ?? null;
    const live = probed !== null && probed.length > 0;
    const models: ReadonlyArray<{ id: string; label: string }> = live ? probed : AGENT_MODELS[k];
    const selectedOnDefault = onThisAgent && model === null;
    if (models.length === 0) return [{ ...base, key: `${k}:default`, modelId: null, label: DEFAULT_MODEL_LABEL[k], selected: onThisAgent }];
    const defaultRow: ModelRow[] = live
      ? [{ ...base, key: `${k}:default`, modelId: null, label: DEFAULT_MODEL_LABEL[k], selected: selectedOnDefault }]
      : [];
    return [...defaultRow, ...models.map((m, i) => ({
      ...base, key: `${k}:${m.id}`, modelId: m.id, label: m.label,
      // Static curated lists pin their first entry as the adapter default (presets.test.ts holds the
      // two together), so `model === null` selects it; a live catalog got the explicit row above.
      selected: onThisAgent && (model === null ? !live && i === 0 : m.id === model),
    }))];
  });
}

/**
 * Search + provider-rail filtering.
 *
 * The query matches the model name OR the agent name, because both are on the row and users reach for
 * either ("opus", "cursor"). It deliberately does NOT match model *ids*: `claude-fable-5` would make
 * "5" match everything, and an id the row never displays is not something anyone is typing at.
 */
export function filterRows(rows: ModelRow[], { query, provider }: { query: string; provider: AgentKind | null }): ModelRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) =>
    (provider === null || r.kind === provider) &&
    (q === "" || r.label.toLowerCase().includes(q) || r.agentLabel.toLowerCase().includes(q)));
}

/** The rail's entries: one per agent present in `rows`, in row order, deduped. */
export function railKinds(rows: ModelRow[]): AgentKind[] {
  return [...new Set(rows.map((r) => r.kind))];
}
