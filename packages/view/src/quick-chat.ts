import { AGENT_MODELS, AgentKindSchema, SELECTABLE_AGENT_KINDS, type AgentKind } from "@realm/contracts";
import { FALLBACK_AGENT } from "./agents";

/** The setting the quick chat's engine and model are kept under, `{ agentKind, model }`. The server
 *  reads it to start each quick chat, and the meeting assistant's live answers will read it too. */
export const QUICK_CHAT_MODEL_SETTING = "quickChatModel";

export type QuickChatModel = { agentKind: AgentKind; model: string | null };

type Probed = { kind: AgentKind; available: boolean; loggedIn: boolean | null; models?: readonly { id: string; label: string }[] | null };

/** The words a quick model's family is named with across the CLIs' catalogs: Claude's Haiku, Gemini's
 *  Flash and Flash Lite, OpenAI's mini, nano and Spark. Matched against a catalog's own names, so
 *  this picks among models a CLI reported and never adds one. */
const FAST_FAMILIES = new Set(["haiku", "flash", "lite", "mini", "nano", "spark"]);

const words = (label: string): string[] => label.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);

/** The models a picker would show for `kind`: its probe's live catalog, else the curated fallback. */
function catalogOf(kind: AgentKind, probes: readonly Probed[]): readonly { id: string; label: string }[] {
  const live = probes.find((p) => p.kind === kind)?.models;
  return live && live.length > 0 ? live : AGENT_MODELS[kind];
}

/** The first quick model in `kind`'s catalog, or null (its CLI's own default) when it names none.
 *  Catalogs list their newest first, so the first match is the newest of the quick family. */
export function fastestModel(kind: AgentKind, probes: readonly Probed[]): string | null {
  return catalogOf(kind, probes).find((m) => words(m.label).some((w) => FAST_FAMILIES.has(w)))?.id ?? null;
}

/** Whether a probe row says the agent can take a turn. A kind nobody has probed yet is given the
 *  benefit of the doubt, as the picker gives it. */
const ready = (kind: AgentKind, probes: readonly Probed[]): boolean => {
  const p = probes.find((r) => r.kind === kind);
  return !p || (p.available && p.loggedIn !== false);
};

/**
 * What a quick chat starts on: the stored choice when it names a registered agent, else a quick model
 * on the first agent that can run. Claude comes first, so a Mac signed in to Claude starts on its
 * newest Haiku; without Claude, the next ready agent's quick model, or its default where its catalog
 * has none.
 */
export function quickChatModelOf(stored: unknown, probes: readonly Probed[], registered: readonly AgentKind[]): QuickChatModel {
  const s = stored && typeof stored === "object" ? (stored as { agentKind?: unknown; model?: unknown }) : null;
  const kind = AgentKindSchema.safeParse(s?.agentKind);
  if (kind.success && registered.includes(kind.data)) {
    return { agentKind: kind.data, model: typeof s?.model === "string" && s.model !== "" ? s.model : null };
  }
  const have = new Set(registered);
  const offered = SELECTABLE_AGENT_KINDS.filter((k) => have.has(k));
  const agentKind = offered.find((k) => ready(k, probes)) ?? offered[0] ?? registered[0] ?? FALLBACK_AGENT;
  return { agentKind, model: fastestModel(agentKind, probes) };
}
