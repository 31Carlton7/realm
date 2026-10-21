import {
  AGENT_META, AGENT_MODELS, AGENT_SUPPORTS_PERMISSION_MODES, PERMISSION_MODES, SESSION_MODES, canonicalModelKey, modeWireValue, offeredModes,
  sessionModeOf, steerNote, type AcpSessionMode, type AgentKind, type MethodResult, type ModelInfo, type SessionMode,
} from "@realm/contracts";
import type { AgentOptions } from "@realm/remote";
import { effortOptions, modelLabel, type EffortChoice, type EffortOptions } from "@realm/view";

/**
 * What the phone's composer may change about a session (`session.options`, `session.configure`), and
 * what a new one may start on (`agents.list`), read by the desktop picker's own rules for the session's
 * own agent: its models as the picker lists that harness's, the levels each takes (`effortOptions`),
 * the modes the agent offers (`offeredModes`) and the permission rungs Realm can set on it.
 */

export type ProbeRow = MethodResult<"agents.probe">[number];

/** What a session's own handshake said that its options read: the model its agent runs, its own
 *  reasoning levels where they are a session setting, and the modes an ACP agent named. */
export type InitFacts = { model?: string; efforts?: EffortChoice[]; defaultEffort?: string; availableModes?: AcpSessionMode[] };

export type OptionsInput = {
  /** This agent's row of the Mac's probe, or null when none answered in time. */
  probe: ProbeRow | null;
  /** The levels harnesses have said each model takes (`MODEL_EFFORTS_KEY`). */
  remembered: Record<string, string[]>;
  /** The public model catalog as last cached, by canonical key. */
  catalog: ReadonlyMap<string, ModelInfo>;
  /** The session's newest handshake; null for a session not made yet, or not started. */
  init: InitFacts | null;
};

/** What `session.configure` and `session.create` ask for, as the phone names it. */
export type Choices = { model?: string | null; effort?: string | null; mode?: SessionMode; permission?: string };

/** A choice the agent does not offer, in words a person can act on. */
export class ChoiceRefused extends Error {}

/** Claude's and Codex's levels belong to a model; every other agent's are its own setting. */
const levelsPerModel = (kind: AgentKind): boolean => kind === "claude" || kind === "codex";

/**
 * The models the agent offers, as the desktop's picker lists its own harness's: the probe's live
 * catalog, else the curated list. `null` leads, the agent's own default. `infoKey` is the catalog
 * entry each is read against: on a curated list the default is its first model, the one the picker
 * ticks for a session that pinned nothing; a live catalog's default is a guess the picker never makes.
 */
function modelList(kind: AgentKind, probe: ProbeRow | null): { id: string | null; infoKey: string | null }[] {
  const probed = probe?.models ?? null;
  const live = probed !== null && probed.length > 0;
  const listed: readonly { id: string; label: string }[] = live ? probed : AGENT_MODELS[kind];
  const first = !live ? listed[0] : undefined;
  return [{ id: null, infoKey: first ? canonicalModelKey(first.label) : null }, ...listed.map((m) => ({ id: m.id, infoKey: canonicalModelKey(m.label) }))];
}

function levels(kind: AgentKind, model: string | null, input: OptionsInput): EffortOptions {
  const infoKey = modelList(kind, input.probe).find((m) => m.id === model)?.infoKey ?? null;
  return effortOptions({
    kind, model, agentProbe: input.probe ? [input.probe] : [], info: infoKey ? input.catalog.get(infoKey) ?? null : null,
    remembered: input.remembered, init: input.init,
  });
}

/** Whether the agent can run, as the desktop's agent chip says it (`agentAvailability`): a CLI the
 *  probe found missing or signed out says which, and one no probe has looked at is not doubted. */
function availability(probe: ProbeRow | null): { available: boolean; note: string | null } {
  if (probe && !probe.available) return { available: false, note: "not installed" };
  if (probe?.loggedIn === false) return { available: false, note: "signed out" };
  return { available: true, note: null };
}

/**
 * One agent's options. `pinned` is the model a session was given: such a session cannot be put back
 * on the agent's default (`sessions.setOptions` takes no null for a model), so its list leaves the
 * default out rather than offer a row that would be refused.
 */
export function agentOptions(kind: AgentKind, input: OptionsInput, pinned: string | null = null): AgentOptions {
  const perModel = levelsPerModel(kind);
  const probe = input.probe ? [input.probe] : [];
  const models = modelList(kind, input.probe).filter((m) => m.id !== null || pinned === null).map(({ id }) => {
    const e = perModel ? levels(kind, id, input) : null;
    return { id, label: modelLabel(kind, id, probe), ...(e && e.levels.length > 0 ? { efforts: e.levels, defaultEffort: e.defaultId } : {}) };
  });
  return {
    kind, name: AGENT_META[kind].label, mark: AGENT_META[kind].icon, ...availability(input.probe), models,
    efforts: perModel ? [] : levels(kind, null, input).levels,
    modes: offeredModes(kind, input.init?.availableModes).map((id) => ({ id, label: SESSION_MODES.find((m) => m.id === id)!.label })),
    permissions: AGENT_SUPPORTS_PERMISSION_MODES[kind] ? PERMISSION_MODES.map(({ id, label }) => ({ id, label })) : [],
    steerNote: steerNote(kind),
  };
}

/**
 * What `sessions.setOptions` is asked for: each choice checked against what the agent offers, and only
 * what differs from `current`. Plan and Ask travel as the permission mode; Build puts back the rung
 * chosen with it, else the session's own where it is in Build already, else `defaultPermission` — the
 * Mac's default for new sessions, as `resolveDefaultPermissionMode` reads it. A rung chosen without a
 * mode is Build on that rung.
 */
export function changesFor(
  kind: AgentKind, current: { model: string | null; effort: string | null; permissionMode: string }, c: Choices, input: OptionsInput, defaultPermission: string,
): { model?: string; effort?: string | null; permissionMode?: string } {
  const offered = agentOptions(kind, input, current.model);
  const name = offered.name;
  const out: { model?: string; effort?: string | null; permissionMode?: string } = {};
  let model = current.model;
  if (c.model !== undefined && c.model !== current.model) {
    if (c.model === null) throw new ChoiceRefused(`This session was given a model, and Realm can't put it back on ${name}'s default. Choose a model instead.`);
    if (!offered.models.some((m) => m.id === c.model)) throw new ChoiceRefused(`${name} doesn't offer ${c.model} on this Mac.`);
    out.model = model = c.model;
  }
  if (c.effort !== undefined && c.effort !== current.effort) {
    const taken = levelsPerModel(kind) ? levels(kind, model, input).levels : offered.efforts;
    if (c.effort !== null && !taken.some((l) => l.id === c.effort)) {
      throw new ChoiceRefused(taken.length === 0 ? `${modelLabel(kind, model, input.probe ? [input.probe] : [])} takes no reasoning level.` : `${c.effort} isn't a reasoning level this model takes.`);
    }
    out.effort = c.effort;
  }
  if (c.permission !== undefined) {
    if (offered.permissions.length === 0) throw new ChoiceRefused(`Realm can't set ${name}'s permissions.`);
    if (!offered.permissions.some((p) => p.id === c.permission)) throw new ChoiceRefused(`${c.permission} isn't a permission ${name} has.`);
    if (c.mode !== undefined && c.mode !== "build") throw new ChoiceRefused("Permissions are chosen in Build; Plan and Ask change nothing.");
  }
  if (c.mode !== undefined && !offered.modes.some((m) => m.id === c.mode)) throw new ChoiceRefused(`${name} has no ${c.mode} mode here.`);
  const mode = c.mode ?? (c.permission !== undefined ? "build" : undefined);
  if (mode !== undefined) {
    const wire = modeWireValue(mode) ?? c.permission ?? (sessionModeOf(current.permissionMode) === "build" ? current.permissionMode : defaultPermission);
    if (wire !== current.permissionMode) out.permissionMode = wire;
  }
  return out;
}
