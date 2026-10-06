import { AGENT_FAST_MODE, AGENT_META, AGENT_MODELS, AGENT_NOTES, AGENT_TAKES_EFFORT, DEFAULT_MODEL_LABEL, EFFORT_LEVELS, MODEL_NOTES, SELECTABLE_AGENT_KINDS, canonicalModelKey, fastSupportKey, formatContext, formatPrice, type AgentKind, type ModelInfo } from "@realm/contracts";
import { agentAvailability, availabilityNote } from "../../state/agent-availability";
import type { AgentProbe } from "../../state/store";

/**
 * Everything Realm knows about the models a session could be put on, as plain functions over plain
 * data: which models exist and which harness would run each (`modelRows`), how a list of them reads
 * (`filterRows`, `groupRows`, `modelLabel`), what each can be asked for (`effortOptions`,
 * `fastModeAvailability`), what to say about one (`modelAbout`), and which model a person meant by a
 * name (`resolveModelName`).
 *
 * The prompter's picker is one reader. Anything else that picks a model — a scheduled task's Model
 * and Effort fields, a plan handed to sub-agents on other models — reads the same answers from here,
 * so a model offered in one place is offered, named and routed the same way in every other.
 */

/** One pickable line: a MODEL, and the harness that would run it. */
export type ModelRow = {
  /** `canonicalModelKey(label)`, so the same model reached through two harnesses is one row. Adapter
   *  default rows key `default:<kind>` instead — see `modelRows`. What favourites and the catalog
   *  are keyed by. */
  key: string;
  /** The row's own identity: the React key, the DOM id, what the highlight follows. */
  id: string;
  /** The harness that would run this model if the row were picked — the session's own whenever it
   *  offers the model, so the common pick costs no agent switch. */
  kind: AgentKind;
  /** Every harness that offers this model, in the order they were considered. */
  harnesses: AgentKind[];
  /** The wire id per harness — `null` where that harness means "your own default". Picking a row
   *  transmits `ids[kind]`, and switching harness re-reads this rather than re-sending a foreign id. */
  ids: Partial<Record<AgentKind, string | null>>;
  /** `null` for an agent whose models Realm cannot enumerate — picking it leaves the adapter default. */
  modelId: string | null;
  /** The model's own name, as the harness (or Realm's curated list) gave it. */
  label: string;
  /** The resolved harness's name. */
  agentLabel: string;
  icon: string;
  /** "not installed" / "signed out", or null when the CLI is fine (or unprobed). */
  note: string | null;
  /** The same answer for every harness that offers the model. */
  notes: Partial<Record<AgentKind, string | null>>;
  /** Harnesses other than `kind` this session could actually be moved onto to run the model — every
   *  other route while the agent may still switch, none once it may not. These are the row's other
   *  ways to run, offered on the row itself. */
  alternates: AgentKind[];
  /** Why this row cannot be picked right now; `null` when it can. */
  blockedReason: string | null;
  /** The model this session is actually on — at most one row, and always one when rows exist. */
  selected: boolean;
  /** Starred by the user (persisted as canonical keys, so a favourite survives a harness switch). */
  favorite: boolean;
};

/**
 * Every model the user could put behind this session — one row per MODEL, not per (harness, model).
 *
 * The rows are model-first because that is the question the user is actually asking. Realm reaches
 * Claude Fable 5.1 through the `claude` CLI and through Cursor's ACP, and listing it twice made the
 * picker read as though those were two different models. Now they are one row that remembers both
 * routes (`harnesses`, `ids`), and `kind` names the route it would take.
 *
 * Three rules carry the weight:
 *
 * - **The session's own harness wins the tie.** If the current harness offers the model, the row
 *   resolves to it, so picking costs no agent switch. Only a model this harness cannot run resolves
 *   elsewhere — preferring a harness that is installed and signed in, then declaration order (which
 *   puts the vendor's own CLI ahead of a proxy: Fable through `claude`, not through Cursor).
 * - **Agents with no enumerable model list still get a row.** Codex and Cursor report no models until
 *   probed, and a provider you cannot enumerate is still one you can pick — the row names the
 *   adapter's own frontier default (`DEFAULT_MODEL_LABEL`) and picks the harness alone. These rows
 *   are deliberately NOT deduped across harnesses: "the Cursor default" and "the Codex default" are
 *   different things that happen to be described the same way.
 * - **A model no reachable harness can run is marked, with the reason.** `sessions.setAgent` refuses
 *   once a session has any event, because a transcript, a providerSessionId and a resume are all tied
 *   to the agent that produced them. `groupRows` leaves those rows out and the picker says why in one
 *   line, rather than drawing a list of models nobody can choose.
 *
 * Availability (`agentProbe`) is reported but never blocking — picking a missing CLI lands on the
 * install card with the exact command, which is somewhere to go; disabling the row hides the fix.
 *
 * Model lists come from THREE sources, most honest first:
 *
 * 1. **The probe's live catalog** (`agentProbe[kind].models`) — ids the provider itself handed over
 *    (Codex `model/list`, Cursor's ACP `availableModels`). A probe-sourced list additionally gets a
 *    leading DEFAULT row (`modelId: null`, the adapter's own default): a live catalog's ordering
 *    carries no promise that its first entry IS the default the adapter runs un-pinned (Cursor's
 *    catalog leads with "Auto" while an un-pinned session runs Composer — verified live), so
 *    `model === null` selects the explicit default row instead of guessing at index 0.
 * 2. **The static curated list** (`AGENT_MODELS[kind]`) — Claude, whose CLI has no enumeration
 *    channel, plus any kind whose probe has not answered (or answered without models).
 * 3. **The single DEFAULT_MODEL_LABEL row** — a kind with no list at all.
 *
 * `model === null` means the user has pinned nothing and the adapter is running its own default. That
 * still marks a row: the frontier model, which is the first of the kind's list and the one the chip
 * already names via `DEFAULT_MODEL_LABEL` (presets.test.ts pins the two to each other).
 */
export function modelRows({ kind, model, agentProbe, canSwitchAgent, favorites = [] }: {
  kind: AgentKind; model: string | null; agentProbe: AgentProbe[]; canSwitchAgent: boolean;
  /** Canonical keys the user has starred. */
  favorites?: readonly string[];
}): ModelRow[] {
  // The session's own kind leads, then the rest of the offered set. Leading with it is what makes the
  // tie-break above fall out for free: the first harness to claim a model is the current one whenever
  // it has it. It also covers a kind that is not offered fresh (`fake`), which would otherwise have
  // no row at all.
  const kinds: AgentKind[] = [kind, ...SELECTABLE_AGENT_KINDS.filter((k) => k !== kind)];
  const noteOf = new Map<AgentKind, string | null>(kinds.map((k) => [k, availabilityNote(agentAvailability(k, agentProbe))]));
  const favorite = new Set(favorites);

  // Which id counts as "what this session is running" on its own harness. Resolved once, up front,
  // because the two list sources answer it differently and the row loop should not re-litigate that.
  const ownProbed = agentProbe.find((p) => p.kind === kind)?.models ?? null;
  const ownLive = ownProbed !== null && ownProbed.length > 0;
  const selectedId = model !== null ? model
    : ownLive ? null                          // the explicit adapter-default row
    : (AGENT_MODELS[kind][0]?.id ?? null);    // static lists pin their first entry as the default

  const byKey = new Map<string, ModelRow>();
  const rows: ModelRow[] = [];
  for (const k of kinds) {
    // Strictly this kind's own probe entry: rendering kind A's catalog under kind B would offer ids
    // agent B rejects on the wire.
    const probed = agentProbe.find((p) => p.kind === k)?.models ?? null;
    const live = probed !== null && probed.length > 0;
    const models: ReadonlyArray<{ id: string; label: string }> = live ? probed : AGENT_MODELS[k];
    // A kind with no list at all, and the explicit default row a live catalog earns. Both are
    // per-harness by nature, so they key on the harness and never merge with another's default.
    const defaults = models.length === 0 || live
      ? [{ key: `default:${k}`, id: null as string | null, label: DEFAULT_MODEL_LABEL[k] }]
      : [];
    const entries = [
      ...defaults,
      ...models.map((m) => ({ key: canonicalModelKey(m.label), id: m.id as string | null, label: m.label })),
    ];

    for (const e of entries) {
      const existing = byKey.get(e.key);
      if (existing) {
        // A second route to a model already listed: record the id, keep the resolved harness the
        // FIRST claimant gave it — but take the better NAME wherever it comes from. Cursor's catalog
        // labels its models with their bare ids (`claude-fable-5-1`), so a Cursor session that
        // claimed the model first would otherwise show that id where Claude's own list has a real
        // name for the very same model.
        existing.harnesses.push(k);
        existing.ids[k] = e.id;
        existing.notes[k] = noteOf.get(k) ?? null;
        if (looksLikeId(existing.label) && !looksLikeId(e.label)) existing.label = e.label;
        continue;
      }
      const row: ModelRow = {
        key: e.key, id: e.key, kind: k, harnesses: [k], ids: { [k]: e.id }, modelId: e.id, label: e.label,
        agentLabel: AGENT_META[k].label, icon: AGENT_META[k].icon, note: noteOf.get(k) ?? null,
        notes: { [k]: noteOf.get(k) ?? null }, alternates: [],
        blockedReason: null, selected: false, favorite: favorite.has(e.key),
      };
      byKey.set(e.key, row);
      rows.push(row);
    }
  }

  // Resolution runs AFTER every harness has been folded in, because "prefer one that is installed"
  // cannot be answered while the row still has routes it has not been told about.
  for (const row of rows) {
    const harness = resolveHarness(row.harnesses, { kind, canSwitchAgent, noteOf });
    if (harness === null) {
      row.blockedReason = `${AGENT_META[row.kind].label} can’t be picked — this session has already run, and a session's agent can only change before its first message.`;
    } else {
      row.kind = harness;
      row.agentLabel = AGENT_META[harness].label;
      row.icon = AGENT_META[harness].icon;
      row.note = noteOf.get(harness) ?? null;
      row.modelId = row.ids[harness] ?? null;
      // `ids[kind]` exists only for a harness that offers the model, so this already means "on the
      // session's own harness AND running the pinned id".
      row.selected = row.ids[kind] === selectedId;
      // Every other route is somewhere the session could go — while it still can. Once it has run,
      // `sessions.setAgent` refuses, and a route that would refuse is a click whose only outcome is a
      // rejection.
      row.alternates = canSwitchAgent ? row.harnesses.filter((h) => h !== harness) : [];
    }
  }
  return rows;
}

/**
 * Whether a label is a bare wire id rather than a name someone wrote for humans.
 *
 * Lowercase throughout with no spaces is what every raw id looks like (`claude-fable-5-1`,
 * `gpt-5.3-codex`) and what no vendor's written name looks like. Used only to pick between two
 * labels for the SAME model, so a false positive costs nothing: the id was going to be shown anyway.
 */
function looksLikeId(label: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(label);
}

/**
 * Which harness would actually run this model — `null` when none may.
 *
 * The current harness wins outright when it offers the model: a pick that changes nothing but the
 * model is always better than one that also swaps the agent underneath. Failing that, and only while
 * the session may still switch agents, prefer a harness with nothing wrong with it, then the order
 * the caller considered them in — which puts the vendor's own CLI ahead of a proxy.
 */
function resolveHarness(harnesses: AgentKind[], { kind, canSwitchAgent, noteOf }: {
  kind: AgentKind; canSwitchAgent: boolean; noteOf: Map<AgentKind, string | null>;
}): AgentKind | null {
  if (harnesses.includes(kind)) return kind;
  if (!canSwitchAgent) return null; // sessions.setAgent refuses; no other route is reachable
  return harnesses.find((h) => (noteOf.get(h) ?? null) === null) ?? harnesses[0] ?? null;
}

/**
 * The wire id a model needs on a given harness. `undefined` means that harness does not offer this
 * model at all, which is the caller's cue to fall back to the harness's own default and say so.
 */
export function modelIdOn(row: ModelRow, harness: AgentKind): string | null | undefined {
  return row.harnesses.includes(harness) ? row.ids[harness] ?? null : undefined;
}

/** A harness's own default row — "whatever this agent runs when nothing is pinned". */
export const isHarnessDefault = (row: ModelRow): boolean => row.key === `default:${row.kind}`;

/**
 * Search.
 *
 * The query matches the model's name OR the name of ANY harness that could run it — not merely the
 * one the row resolved to. Typing "cursor" therefore answers "what could I get from Cursor"; a model
 * that resolved to the Claude CLI because that is installed is still a model Cursor offers.
 *
 * It deliberately does NOT match model *ids*: `claude-fable-5` would make "5" match everything, and
 * an id the row never displays is not something anyone is typing at.
 */
export function filterRows(rows: ModelRow[], query: string): ModelRow[] {
  const q = query.trim().toLowerCase();
  if (q === "") return rows;
  return rows.filter((r) =>
    r.label.toLowerCase().includes(q) ||
    r.harnesses.some((h) => AGENT_META[h].label.toLowerCase().includes(q)));
}

/** One labelled block of a model list. */
export type RowGroup = {
  /** Stable identity: the React key and the heading's DOM id. */
  id: string;
  /** The heading, or "" for a search's single unlabelled group. */
  label: string;
  rows: ModelRow[];
  /** The harness the heading names. Absent on Favourites, Other agents and a search. */
  kind?: AgentKind;
  /** The rows are agents rather than models — Other agents names each by its harness. */
  byHarness?: boolean;
};

/**
 * The list's shape: favourites, then one group per harness, then every other agent in one group.
 *
 * Grouping by harness is what makes the list teach: reading it top to bottom says "these are the
 * models your Claude CLI runs, these are the ones Codex runs". The session's own harness leads,
 * because `modelRows` builds in that order and first appearance is the order kept.
 *
 * Each model is listed ONCE, under the harness a click would run it through. A model another harness
 * can also run carries that harness on its row instead (`alternates`, drawn as one-click routes), so
 * the choice of harness appears exactly where there is one — a heading per route listed Fable twice
 * and read as two models.
 *
 * An agent that offers nothing but its own default — the ACP agents whose catalog Realm cannot ask —
 * and an agent that is not installed are one row each under "Other agents", named by the agent: a
 * heading over a single row that reads "Default" was eight headings of chrome for eight clicks. The
 * session's own agent is never folded away; it leads under its own name whatever it holds.
 *
 * Rows this session can no longer switch to are left out (see `modelRows`). A search collapses all of
 * it into one unlabelled group, because a filtered list is already an answer.
 */
export function groupRows(rows: ModelRow[], { query, kind }: { query: string; kind: AgentKind }): RowGroup[] {
  const live = rows.filter((r) => !r.blockedReason);
  if (query.trim() !== "") return live.length ? [{ id: "results", label: "", rows: live }] : [];
  const favorites = live.filter((r) => r.favorite);
  const groups: RowGroup[] = favorites.length ? [{ id: "favourites", label: "Favourites", rows: favorites }] : [];
  const byKind = new Map<AgentKind, ModelRow[]>();
  for (const r of live) {
    if (r.favorite) continue; // one row, one place: a starred model is in Favourites, not twice
    const held = byKind.get(r.kind);
    if (held) held.push(r); else byKind.set(r.kind, [r]);
  }
  const others: ModelRow[] = [];
  for (const [k, kindRows] of byKind) {
    const lone = kindRows.length === 1 && isHarnessDefault(kindRows[0]!);
    if (k !== kind && (lone || kindRows[0]!.note === "not installed")) others.push(kindRows[0]!);
    else groups.push({ id: k, label: AGENT_META[k].label, rows: kindRows, kind: k });
  }
  if (others.length) groups.push({ id: "others", label: "Other agents", rows: others, byHarness: true });
  return groups;
}

/** Every row the groups hold, in the order they are drawn — the sequence ↑/↓ walks and the one the
 *  ⌘-digit shortcuts are numbered against. */
export function flatten(groups: RowGroup[]): ModelRow[] {
  return groups.flatMap((g) => g.rows);
}

/**
 * The rows as a picker that is already open shows them: in the order, and through the harness, each
 * had when it opened — with what is LIVE taken from now: which row is ticked, which are starred, and
 * any row that has arrived since, after the rest.
 *
 * A pick leaves the picker open, and a pick can move the session to another harness, which re-sorts
 * `modelRows` — the session's own harness leads, and takes every model it also offers. Read live, the
 * list re-ordered under the pointer that had just pressed it, and Fable under the Claude heading came
 * back wearing Cursor's mark. Held, a pick moves the tick and nothing else, and a row runs through the
 * harness it said it would; the next opening lays the list out for wherever the session is by then.
 */
export function holdRows(live: readonly ModelRow[], opened: readonly ModelRow[]): ModelRow[] {
  const byId = new Map(live.map((r) => [r.id, r]));
  const held: ModelRow[] = [];
  for (const o of opened) {
    const r = byId.get(o.id);
    if (!r) continue;
    byId.delete(o.id);
    held.push(r.blockedReason || r.kind === o.kind || !r.harnesses.includes(o.kind) ? r : throughHarness(r, o.kind));
  }
  return [...held, ...byId.values()];
}

/** `row` resolved through `kind`, which is one of its own harnesses. Its other harnesses stay routes
 *  only while the session may still switch, which is what having alternates at all says. */
const throughHarness = (row: ModelRow, kind: AgentKind): ModelRow => ({
  ...row, kind, agentLabel: AGENT_META[kind].label, icon: AGENT_META[kind].icon, note: row.notes[kind] ?? null,
  modelId: row.ids[kind] ?? null, alternates: row.alternates.length > 0 ? row.harnesses.filter((h) => h !== kind) : [],
});

/**
 * A model's name as a list under its harness shows it: "Fable 5.1" beside Claude's mark, not "Claude
 * Fable 5.1" under a heading that already says Claude.
 *
 * Only a word that repeats the harness's name comes off, and only when what follows is itself a word:
 * Claude names its models by family, so "Fable 5.1" is a name, while "Grok 4.6" or "DeepSeek V4 Pro"
 * would leave a bare version standing for a model. Through any other harness the name stays whole —
 * "Claude Fable 5.1" through Cursor is information.
 */
export function modelLabel(row: ModelRow): string {
  const harness = `${AGENT_META[row.kind].label} `;
  if (!row.label.startsWith(harness)) return row.label;
  const rest = row.label.slice(harness.length);
  return /^[A-Za-z]+(\s|$)/.test(rest) ? rest : row.label;
}

/** What a row under "Other agents" says after the agent's name: the model its default runs, where
 *  the harness has a name for it ("Codex, GPT-5.6"), and nothing where that would only be "Default"
 *  or the agent's own name again. */
export function agentRowHint(row: ModelRow): string | null {
  const name = modelLabel(row);
  return name === "Default" || name === AGENT_META[row.kind].label ? null : name;
}

/** What the prompter's chip names: the session's own row, a pinned id no list carries (a model retired
 *  since), or the harness's default label — never silently another model's name. */
export function chipLabel(kind: AgentKind, model: string | null, rows: ModelRow[]): string {
  const selected = rows.find((r) => r.selected);
  return selected ? modelLabel(selected) : model ?? DEFAULT_MODEL_LABEL[kind];
}

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
  agentProbe: AgentProbe[];
  /** The public catalog's entry for the model, where it has one. */
  info?: ModelInfo | null;
  /** `MODEL_EFFORTS_KEY`, as the store mirrors it. */
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

/** The effort control as the picker draws it: the levels, what the session asked for (null for the
 *  model's own default), and the default by name where it is known. */
export type EffortControl = EffortOptions & {
  value: string | null;
  onChange: (id: string | null) => void;
};

/** The level in force: the session's own when it is one this model takes, else the default where one
 *  is named — with its place on the track, -1 for "the harness's own, unnamed". A level the model does
 *  not take (one set under another model) is not what runs, so it is not what the control shows. */
export function effortCurrent(e: Pick<EffortControl, "levels" | "value" | "defaultId">): { index: number; choice: EffortChoice | null; chosen: boolean } {
  const asked = e.levels.findIndex((l) => l.id === e.value);
  if (asked >= 0) return { index: asked, choice: e.levels[asked]!, chosen: true };
  const fallback = e.levels.findIndex((l) => l.id === e.defaultId);
  return fallback >= 0 ? { index: fallback, choice: e.levels[fallback]!, chosen: false } : { index: -1, choice: null, chosen: false };
}

/** Where an answer about fast mode came from, most direct first. */
export type FastSource = "session" | "catalog" | "remembered";

/**
 * What can honestly be said about fast mode for one model on one harness, before anything has run.
 *
 * - `none` — Realm has no way to ask this harness for it (`AGENT_FAST_MODE`). Draw nothing.
 * - `offered` — the harness said this model can: this session's own handshake, the probe's live
 *   catalog (Codex lists the `priority` tier per model), or the last session that heard the harness
 *   answer for this model (`MODEL_FAST_SUPPORT_KEY`).
 * - `unavailable` — the harness said it cannot; `alternatives` names models on the same harness it
 *   said can, which is the one useful thing to tell someone looking for it.
 * - `unknown` — the harness can be asked, and nothing has said yet. The switch works as a request
 *   and the first turn reports what happened, which is what the picker says.
 */
export type FastAvailability =
  | { state: "none" }
  | { state: "offered"; source: FastSource }
  | { state: "unavailable"; source: FastSource; alternatives: string[] }
  | { state: "unknown" };

/** A model id without its bracketed variant (`claude-opus-5-5[1m]` is the 1M build of `claude-opus-5-5`). */
const baseId = (id: string): string => id.replace(/\[[^\]]*\]$/, "");

/** What the probe's catalog says about fast mode for `model` on `kind` — the marked default for a
 *  session that pinned nothing — or undefined where it says nothing. */
function catalogFast(kind: AgentKind, model: string | null, agentProbe: AgentProbe[]): boolean | undefined {
  const models = agentProbe.find((p) => p.kind === kind)?.models ?? null;
  const m = models?.find((x) => (model === null ? x.isDefault === true : x.id === model));
  return m?.fastMode;
}

/** What is known about one model id on one harness without this session's own handshake. */
function heardFast(kind: AgentKind, model: string | null, agentProbe: AgentProbe[], remembered: Record<string, boolean>): { can: boolean; source: FastSource } | null {
  const catalog = catalogFast(kind, model, agentProbe);
  if (catalog !== undefined) return { can: catalog, source: "catalog" };
  const kept = remembered[fastSupportKey(kind, model)];
  return kept === undefined ? null : { can: kept, source: "remembered" };
}

export function fastModeAvailability({ kind, model, init, agentProbe, remembered, rows }: {
  kind: AgentKind;
  /** What the session asks for — `session.model`, null for the harness's default. */
  model: string | null;
  /** This session's own handshake, where it has one. Only believed while it describes the model the
   *  session still asks for: a pick since then made it an answer about some other model. */
  init?: { model: string; supportsFastMode?: boolean } | null;
  agentProbe: AgentProbe[];
  /** `MODEL_FAST_SUPPORT_KEY`, as the store mirrors it. */
  remembered: Record<string, boolean>;
  /** The rows the alternatives are named from. */
  rows: ModelRow[];
}): FastAvailability {
  if (!AGENT_FAST_MODE[kind]) return { state: "none" };
  const own = init?.supportsFastMode !== undefined && (model === null || baseId(init.model) === model)
    ? { can: init.supportsFastMode, source: "session" as const } : null;
  const said = own ?? heardFast(kind, model, agentProbe, remembered);
  if (!said) return { state: "unknown" };
  if (said.can) return { state: "offered", source: said.source };
  const alternatives: string[] = [];
  for (const r of rows) {
    const id = r.ids[kind];
    if (id === undefined || id === null || id === model) continue;
    if (heardFast(kind, id, agentProbe, remembered)?.can) alternatives.push(modelLabel({ ...r, kind }));
  }
  return { state: "unavailable", source: said.source, alternatives: alternatives.slice(0, 3) };
}

/**
 * Fast mode as the picker knows it: what the session ASKED for, what the harness last DID, and what
 * can be said about the model before either.
 *
 * The request and the report are separate fields because they disagree routinely — a plan that does
 * not include it, a rate limit, a model swapped mid-session — and a switch that showed only the
 * request would keep claiming a speed the agent is not running at. `state` is null until a turn has
 * finished, which is the honest reading of "nothing has been reported yet" rather than "off".
 */
export type FastMode = {
  /** The session's own switch. */
  on: boolean;
  /** What the last finished turn reported, or null when none has. */
  state: "off" | "cooldown" | "on" | null;
  /** The harness's reason, in its own vocabulary. */
  reason: string | null;
  /** Whether the turn that report describes asked for fast mode, or null where nothing says. */
  requested: boolean | null;
  onChange: (on: boolean) => void;
  availability: Exclude<FastAvailability, { state: "none" }>;
  /** What fast mode buys and costs, in the harness catalog's own words where it has them
   *  (`fastModeTip`) — the bolt's tooltip. */
  tip: string;
};

/**
 * What the bolt's tooltip says fast mode is: Codex's catalog describes its own tier ("1.5x speed,
 * increased usage", which is what Codex's picker shows over its bolt), and for a harness whose catalog
 * says nothing Realm says only what is true of every fast mode it can ask for.
 */
export function fastModeTip(kind: AgentKind, model: string | null, agentProbe: AgentProbe[]): string {
  const m = agentProbe.find((p) => p.kind === kind)?.models?.find((x) => (model === null ? x.isDefault === true : x.id === model));
  return m?.fastDescription ? `Fast mode: ${m.fastDescription}.` : "Fast mode: faster responses, at a higher cost.";
}

/** The harness's reason codes, said out loud. An unrecognised code is shown verbatim rather than
 *  swallowed: a build newer than this one knows something worth passing on. */
const FAST_REASON: Record<string, string> = {
  free: "your plan does not include it",
  preference: "it is turned off in Claude Code's own settings",
  extra_usage_disabled: "extra usage is turned off for this account",
  network_error: "the request to enable it did not get through",
  not_first_party: "this route does not offer it",
  disabled_by_env: "an environment variable turns it off here",
  model_not_allowed: "this model cannot run it",
  sdk_opt_in_required: "this Claude Code build needs it enabled explicitly",
  pending: "it is still being set up",
  unknown: "the harness did not say why",
};

/**
 * Whether the switch has yet to be tried: nothing has been reported, or the last report is about a
 * turn that never asked for fast mode. Switch it on after a turn that ran without it, and that turn's
 * report still says "off", with the harness's reason for a request nobody made — read as a verdict on
 * the switch, it told the user fast mode could not run, about a turn that never asked.
 */
export const fastModeUntried = (f: Pick<FastMode, "state" | "requested">): boolean => f.state === null || f.requested === false;

/** What the last turn's report says about the switch, or null when there is nothing to correct.
 *  Silent in the ordinary cases — asked for and serving, or not asked for at all — because a note
 *  that appears every time is a note nobody reads by the third session. */
export function fastModeNote(f: Pick<FastMode, "on" | "state" | "reason" | "requested">): string | null {
  if (!f.on) return null;
  if (f.state === "on") return null;
  if (fastModeUntried(f)) return "Fast mode starts on the next turn.";
  if (f.state === "cooldown") return "Fast mode is paused by a rate limit — it will resume on its own.";
  return `Fast mode isn’t running: ${FAST_REASON[f.reason ?? "unknown"] ?? f.reason ?? "the harness did not say why"}.`;
}

/** "Opus 5.5", "Opus 5.5 and Sonnet 5", "A, B and C" — the alternatives as a sentence names them. */
const listed = (names: readonly string[]): string =>
  names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;

/**
 * The line under the effort control about fast mode, or null — and it is null unless fast mode is
 * ASKED FOR, because the bolt's tooltip already says everything that is true of an unpressed bolt, and
 * a note that appears every time is a note nobody reads. Asked for, it says what the request will
 * meet: a model that cannot run it (and which can), the first turn that will check, or the report.
 */
export function fastModeHint(f: FastMode, model: string): string | null {
  if (!f.on) return null;
  const a = f.availability;
  if (a.state === "unavailable") {
    return a.alternatives.length === 0 ? `Fast mode isn’t offered on ${model}.`
      : `Fast mode isn’t offered on ${model} — ${listed(a.alternatives)} ${a.alternatives.length === 1 ? "offers" : "offer"} it.`;
  }
  if (a.state === "unknown" && f.state === null) return "Fast mode is asked for — the first turn checks it.";
  return fastModeNote(f);
}

/** The bolt's tooltip: what fast mode is, and what is known about it on this model. */
export function fastModeTitle(f: FastMode, model: string): string {
  const a = f.availability;
  if (a.state === "unavailable") {
    return a.alternatives.length === 0 ? `Fast mode isn’t offered on ${model}.`
      : `Fast mode isn’t offered on ${model} — ${listed(a.alternatives)} ${a.alternatives.length === 1 ? "offers" : "offer"} it.`;
  }
  return a.state === "unknown" ? `${f.tip} The first turn checks whether ${model} can run it.` : f.tip;
}

/** Whether the chip may wear the bolt: asked for, on a model nothing has said cannot run it, and not
 *  refused by the last turn that asked. A chip that kept it there would claim a speed nobody serves. */
export function fastModeShown(f: FastMode): boolean {
  if (!f.on || f.availability.state === "unavailable") return false;
  return !(f.state === "off" && !fastModeUntried(f));
}

/**
 * What the picker says about the highlighted model, in a fixed two-line strip under the list.
 *
 * - `note` — Realm's own line where it has one (`MODEL_NOTES`), the catalog's first sentence where
 *   it does not, and otherwise what the harness that would run it is for.
 * - `warning` — anything about the route that would surprise someone who picked it: not installed,
 *   signed out, or a structural limit of the harness. It takes the note's place, because it is the
 *   one thing on the line a person must not miss.
 * - `specs` — context and per-token price where the public catalog quotes them. API LIST prices, so
 *   `billing` (who actually charges for a session on this harness) rides with them.
 */
export function modelAbout(row: ModelRow, route: AgentKind, info: Record<string, ModelInfo>): {
  note: string; warning: string | null; specs: string | null; billing: string;
} {
  const catalog = info[row.key] ?? null;
  const harness = AGENT_META[route].label;
  const availability = row.notes[route] ?? null;
  const warning = availability === "not installed" ? `${harness} isn’t installed — picking it shows how to install it.`
    : availability === "signed out" ? `${harness} is signed out — picking it shows how to sign in.`
    : AGENT_NOTES[route].limits;
  const note = MODEL_NOTES.get(row.key) ?? catalog?.blurb ?? AGENT_NOTES[route].good;
  const specs = [
    catalog?.context != null ? `${formatContext(catalog.context)} context` : null,
    catalog?.priceIn != null && catalog.priceOut != null ? `${formatPrice(catalog.priceIn)} in · ${formatPrice(catalog.priceOut)} out per Mtok` : null,
  ].filter((s): s is string => s !== null).join(" · ");
  return { note, warning, specs: specs || null, billing: AGENT_NOTES[route].billing };
}

/** A harness's billing sentence to the end of its first clause — "Bills through your ChatGPT plan or
 *  OpenAI API key." — for a line with room for one statement; the rest belongs to the line's hover. */
export const billingLead = (billing: string): string => `${billing.split(" — ")[0]!.replace(/\.$/, "")}.`;

/** A name resolved to something a session can be put on. */
export type ModelMatch = {
  row: ModelRow;
  /** The harness that would run it — the one the name asked for, or the row's own route. */
  kind: AgentKind;
  /** The id to transmit on that harness; null is the harness's own default. */
  modelId: string | null;
  /** The model's full name, for saying back what was understood ("Claude Fable 5.1"). */
  label: string;
  /** The name matched a model's whole name, rather than part of one. */
  exact: boolean;
};

/** A name's comparison tokens: lowercased, letters split from digits ("gpt6" is "gpt 6"), and the
 *  version kept as one token the way `canonicalModelKey` keeps it. */
const tokensOf = (name: string): string[] =>
  canonicalModelKey(name.replace(/([a-z])(\d)/gi, "$1 $2").replace(/(\d)([a-z])/gi, "$1 $2")).split("-").filter(Boolean);

/** The newer of two versions, for "Fable" meaning Fable 5.1 over Fable 5: the highest number token,
 *  compared part by part. */
const versionOf = (tokens: string[]): number[] => {
  const v = tokens.filter((t) => /^\d+(\.\d+)*$/.test(t)).map((t) => t.split(".").map(Number));
  return v.sort(compareVersions).at(-1) ?? [];
};
function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/** The harness a phrase names, by its label ("Cursor", "Claude Code", "GitHub Copilot") or its kind
 *  ("opencode", "acp:grok"), or null. */
function harnessNamed(text: string): AgentKind | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  for (const k of [...SELECTABLE_AGENT_KINDS, "fake"] as AgentKind[]) {
    const label = AGENT_META[k].label.toLowerCase();
    if (t === label || t === `${label} code` || t === k || t === k.replace(/^acp:/, "")) return k;
  }
  return null;
}

/**
 * Which model a person meant by a name — "Fable", "GPT-6 Luna", "opus 5.5", "GPT-5.5 via Cursor".
 *
 * Every word of the name has to be in the model's name (or, for a harness's default row, the
 * harness's): "fable 5" is Fable 5 and never Fable 5.1, because a version is one token. Among the
 * models that fit, one whose whole name it is wins, then the newest version — "Fable" is Fable 5.1 —
 * then list order, which is the vendor's. A trailing "via / through / on <harness>" asks for that
 * route, and only models that harness runs can answer it.
 *
 * Null when nothing fits: a name no list Realm holds carries — a Codex model before Codex's catalog
 * has been read — is a question back to the person, never a guess at a different model.
 */
export function resolveModelName(name: string, rows: ModelRow[]): ModelMatch | null {
  const via = /^(.*\S)\s+(?:via|through|on)\s+(.+)$/i.exec(name.trim());
  const route = via ? harnessNamed(via[2]!) : null;
  const want = tokensOf(route ? via![1]! : name);
  if (want.length === 0) return null;
  let best: { row: ModelRow; exact: boolean; version: number[] } | null = null;
  for (const row of rows) {
    if (row.blockedReason || (route && !row.harnesses.includes(route))) continue;
    const own = tokensOf(row.label);
    const all = isHarnessDefault(row) ? [...own, ...tokensOf(AGENT_META[row.kind].label)] : own;
    if (!want.every((t) => all.includes(t))) continue;
    const exact = own.length === want.length && own.every((t) => want.includes(t));
    const version = versionOf(own);
    if (!best || (exact && !best.exact) || (exact === best.exact && compareVersions(version, best.version) > 0)) best = { row, exact, version };
  }
  if (!best) return null;
  const kind = route ?? best.row.kind;
  return { row: best.row, kind, modelId: modelIdOn(best.row, kind) ?? null, label: best.row.label, exact: best.exact };
}
