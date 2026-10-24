import { AGENT_TAKES_EFFORT, EFFORT_LEVELS, fastSupportKey, type AgentKind, type MethodResult, type ModelInfo } from "@realm/contracts";

/**
 * The reasoning levels a model can be asked for, as the desktop's model picker offers them.
 *
 * Shared (`@realm/view`) so Realm Mobile's session settings offer exactly the levels the desktop's
 * picker does, named the same way.
 */

type AgentProbeRow = MethodResult<"agents.probe">[number];

/** Display form of an effort level: capitalised, with `xhigh` as "XHigh" — the id's two morphemes
 *  each get their cap, and no hyphen is invented that the CLIs never print. */
export const formatEffort = (e: string): string => (e === "xhigh" ? "XHigh" : e.charAt(0).toUpperCase() + e.slice(1));

/** One reasoning level a model can be run at: the id the harness takes, and its name. */
export type EffortChoice = { id: string; label: string };

/** What a model takes on a harness: its levels, lowest first as the harness lists them, and the one it
 *  runs when none is asked for — null where nothing says which that is. */
export type EffortOptions = { levels: EffortChoice[]; defaultId: string | null };

const NO_EFFORT: EffortOptions = { levels: [], defaultId: null };
const choicesOf = (ids: readonly string[]): EffortChoice[] => ids.map((id) => ({ id, label: formatEffort(id) }));

/**
 * The reasoning levels worth offering for the model a session asks for, from whoever can say:
 *
 * - **Claude** — the levels Claude Code said this model takes (`MODEL_EFFORTS_KEY`, filed off a
 *   session's `supportedModels()`), and until one has, Realm's levels narrowed to the public catalog's
 *   list for the model. The SDK documents `high` as the default.
 * - **Codex** — the model's own `supportedReasoningEfforts` and `defaultReasoningEffort`, off the probe's
 *   catalog; the default row reads the model the catalog marks as default.
 * - **An ACP agent** — its `thought_level` option: this session's own (`init`) once it has booted, the
 *   probe's throwaway session's before.
 *
 * Nothing where the harness never receives a level (`AGENT_TAKES_EFFORT`), or where nothing has named
 * any — a control wired to nothing is the thing this exists to prevent.
 */
export function effortOptions({ kind, model, agentProbe, info, remembered, init }: {
  kind: AgentKind;
  /** What the session asks for — `session.model`, null for the harness's default. */
  model: string | null;
  agentProbe: readonly AgentProbeRow[];
  /** The public catalog's entry for the model, where it has one. */
  info?: ModelInfo | null;
  /** `MODEL_EFFORTS_KEY`, as `readEffortSupport` reads it. */
  remembered: Record<string, string[]>;
  /** This session's own handshake, where it has one. */
  init?: { model?: string; efforts?: EffortChoice[]; defaultEffort?: string } | null;
}): EffortOptions {
  if (!AGENT_TAKES_EFFORT[kind]) return NO_EFFORT;
  if (kind === "claude") {
    const said = remembered[fastSupportKey(kind, model)];
    const listed = new Set(info?.efforts ?? []);
    const narrowed = EFFORT_LEVELS.filter((l) => listed.has(l));
    const levels = said ?? (narrowed.length > 0 ? narrowed : [...EFFORT_LEVELS]);
    return { levels: choicesOf(levels), defaultId: levels.includes("high") ? "high" : null };
  }
  const probe = agentProbe.find((p) => p.kind === kind);
  if (kind === "codex") {
    // The thread's own model once its handshake has named it: a session left on Codex's default runs
    // whatever Codex's config says, and the row Codex marks as its default is only the guess before
    // then. A model its catalog does not carry takes no level from Realm, so it gets no track.
    const id = model ?? init?.model ?? null;
    const m = probe?.models?.find((x) => (id === null ? x.isDefault === true : x.id === id));
    return m?.efforts?.length ? { levels: choicesOf(m.efforts), defaultId: m.defaultEffort ?? null } : NO_EFFORT;
  }
  // An ACP agent's levels are its own names for them; a value with no name of its own reads as Realm
  // would print it.
  const levels = init?.efforts ?? probe?.efforts ?? [];
  if (levels.length === 0) return NO_EFFORT;
  return {
    levels: levels.map((l) => ({ id: l.id, label: l.label === l.id ? formatEffort(l.id) : l.label })),
    defaultId: init?.efforts ? init.defaultEffort ?? null : probe?.defaultEffort ?? null,
  };
}
