import { AGENT_META, AGENT_MODELS, DEFAULT_MODEL_LABEL, MODEL_NOTES, SELECTABLE_AGENT_KINDS, canonicalModelKey, type AgentKind, type ModelInfo } from "@realm/contracts";
import { agentAvailability, availabilityNote } from "../../state/agent-availability";
import type { AgentProbe } from "../../state/store";

/** One pickable line in the model picker: a MODEL, and the harness that would run it. */
export type ModelRow = {
  /** `canonicalModelKey(label)`, so the same model reached through two harnesses is one row. Adapter
   *  default rows key `default:<kind>` instead — see `modelRows`. Also the React key and DOM id. */
  key: string;
  /** The harness that would run this model if the row were picked — the session's own whenever it
   *  offers the model, so the common pick costs no agent switch. */
  kind: AgentKind;
  /** Every harness that offers this model, in the order they were considered. Length > 1 is the
   *  whole point of the model-first list: one row, several ways to run it. */
  harnesses: AgentKind[];
  /** The wire id per harness — `null` where that harness means "your own default". Picking a row
   *  transmits `ids[kind]`, and switching harness re-reads this rather than re-sending a foreign id. */
  ids: Partial<Record<AgentKind, string | null>>;
  /** `null` for an agent whose models Realm cannot enumerate — picking it leaves the adapter default. */
  modelId: string | null;
  /** The model's own name — the row's headline, and what search matches first. */
  label: string;
  /** The resolved harness's name — the row's second line, beside its brand mark. Also searchable. */
  agentLabel: string;
  icon: string;
  /** "not installed" / "signed out", or null when the CLI is fine (or unprobed). */
  note: string | null;
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
 * - **A model no reachable harness can run goes unavailable, and says so.** `sessions.setAgent`
 *   refuses once a session has any event, because a transcript, a providerSessionId and a resume are
 *   all tied to the agent that produced them. After the first message, rows the current harness
 *   cannot run are marked rather than hidden: a picker that quietly drops Codex reads as a bug,
 *   not as a rule.
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
export function modelRows({ kind, model, agentProbe, canSwitchAgent, favorites = [] }: {
  kind: AgentKind; model: string | null; agentProbe: AgentProbe[]; canSwitchAgent: boolean;
  /** Canonical keys the user has starred. Keys, not ids, so a favourite is a MODEL rather than a
   *  model-on-one-harness — the star survives switching the route underneath it. */
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
        if (looksLikeId(existing.label) && !looksLikeId(e.label)) existing.label = e.label;
        continue;
      }
      const row: ModelRow = {
        key: e.key, kind: k, harnesses: [k], ids: { [k]: e.id }, modelId: e.id, label: e.label,
        agentLabel: AGENT_META[k].label, icon: AGENT_META[k].icon, note: noteOf.get(k) ?? null,
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
      // session's own harness AND running the pinned id" — no separate `harness === kind` guard,
      // which would be dead: resolveHarness returns `kind` in exactly the cases where the id is set.
      row.selected = row.ids[kind] === selectedId;
    }
  }
  return rows;
}

/**
 * Whether a label is a bare wire id rather than a name someone wrote for humans.
 *
 * Lowercase throughout with no spaces is what every raw id looks like (`claude-fable-5-1`,
 * `gpt-5.3-codex`) and what no vendor's written name looks like — they all capitalise something
 * ("Claude Fable 5.1", "GPT-5.6", "Composer"). Used only to pick between two labels for the SAME
 * model, so a false positive costs nothing: the id was going to be shown anyway.
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
 * The wire id a model needs on a given harness — what the harness chip re-reads when it switches the
 * route under a model the user has already chosen. `undefined` means that harness does not offer this
 * model at all, which is the caller's cue to fall back to the harness's own default and say so.
 */
export function modelIdOn(row: ModelRow, harness: AgentKind): string | null | undefined {
  return row.harnesses.includes(harness) ? row.ids[harness] ?? null : undefined;
}

/**
 * Search.
 *
 * The query matches the model's name OR the name of ANY harness that could run it — not merely the
 * one the row resolved to. Typing "cursor" therefore answers "what could I get from Cursor", which is
 * the question the old icon rail existed to answer and the one thing it was good at; a model that
 * resolved to the Claude CLI because that is installed is still a model Cursor offers.
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

/**
 * Who MADE this model, as the catalog attributes it ("Anthropic"), or null where nothing does.
 *
 * The vendor and not the harness, deliberately, because the harness is already two of the things
 * this list does: `groupRows` blocks the rows by it, and `filterRows` matches its name, so typing
 * "cursor" already answers "what could I run through Cursor". The detail pane carries a horizontal
 * strip of harnesses of its own, and those buttons mean "run it through this one" — a second
 * horizontal strip of the same names meaning "show me only these" would be two controls that look
 * alike and do different things, inches apart.
 *
 * A vendor is the axis nothing here could express. One row reached through the Claude CLI and through
 * Cursor has two routes and exactly one maker, so "show me Anthropic's" is a question about the model
 * rather than about the way in — the one question the list could not be asked.
 *
 * Null is ordinary rather than a failure: every harness's Default row and Cursor's Composer are in no
 * catalog at all. They belong to no vendor, so choosing one hides them. There is deliberately no
 * "Other" bucket — a chip collecting the models Realm happens to have no maker for would sort by an
 * accident of the catalog and teach nobody anything.
 */
export function modelVendor(row: ModelRow, info: Record<string, ModelInfo>): string | null {
  return info[row.key]?.vendor || null;
}

/** Every vendor present in `rows`, in first-appearance order — which is `modelRows`' order, so the
 *  makers behind the session's own harness lead. Empty when the catalog never arrived (offline is a
 *  supported state), which is what makes the strip absent rather than a single useless chip. */
export function vendorsOf(rows: ModelRow[], info: Record<string, ModelInfo>): string[] {
  const seen: string[] = [];
  for (const r of rows) {
    const v = modelVendor(r, info);
    if (v && !seen.includes(v)) seen.push(v);
  }
  return seen;
}

/** Narrow to one vendor. Composes with `filterRows` rather than replacing it — the two answer
 *  different questions, and someone who has picked Anthropic still wants to type "haiku". */
export function filterVendor(rows: ModelRow[], vendor: string | null, info: Record<string, ModelInfo>): ModelRow[] {
  if (vendor === null) return rows;
  return rows.filter((r) => modelVendor(r, info) === vendor);
}

/** One labelled block of the picker's list. `label: ""` is a group with no heading — what a search
 *  produces, where a heading per harness would be three words of chrome per result. */
export type RowGroup = { label: string; rows: ModelRow[] };

/**
 * The list's shape: favourites first, then one group per harness.
 *
 * Grouping by the harness a row RESOLVED to (rather than by vendor, or not at all) is what makes the
 * list teach: reading it top to bottom says "these are the models your Claude CLI runs, these are the
 * ones Codex runs". The session's own harness leads, because `modelRows` builds in that order and
 * first appearance is the order kept.
 *
 * A search collapses all of it into one unlabelled group. Headings over a filtered list would say
 * where a result came from, which the row's own second line already says, and would push the third
 * match below the fold to do it.
 */
export function groupRows(rows: ModelRow[], { query }: { query: string }): RowGroup[] {
  if (query.trim() !== "") return rows.length ? [{ label: "", rows }] : [];
  const favorites = rows.filter((r) => r.favorite);
  const groups: RowGroup[] = favorites.length ? [{ label: "Favourites", rows: favorites }] : [];
  const byKind = new Map<AgentKind, ModelRow[]>();
  for (const r of rows) {
    if (r.favorite) continue; // one row, one place: a starred model is in Favourites, not twice
    const held = byKind.get(r.kind);
    if (held) held.push(r); else byKind.set(r.kind, [r]);
  }
  for (const [kind, kindRows] of byKind) groups.push({ label: AGENT_META[kind].label, rows: kindRows });
  return groups;
}

/** Every row the groups hold, in the order they are drawn — the sequence ↑/↓ walks and the one the
 *  ⌘-digit shortcuts are numbered against. Derived from the groups rather than recomputed, so the
 *  keyboard can never disagree with the eye about what "the next row" is. */
export function flatten(groups: RowGroup[]): ModelRow[] {
  return groups.flatMap((g) => g.rows);
}

/**
 * What Realm can say about a model beyond its name: a sentence, a price, a context window.
 *
 * Two sources, and the order is the point. Realm's own `MODEL_NOTES` line wins because it was written
 * to help someone choose between the rows actually on screen; the catalog's `blurb` is the vendor's
 * first sentence about its own model and reads like it. Everything else (price, context, efforts)
 * exists only in the catalog — no harness reports it — so a model the catalog has never heard of
 * simply has no numbers, and the panel shows the sentence alone.
 */
export function modelDetail(row: ModelRow, info: Record<string, ModelInfo>): { note: string | null; catalog: ModelInfo | null } {
  const catalog = info[row.key] ?? null;
  return { note: MODEL_NOTES.get(row.key) ?? catalog?.blurb ?? null, catalog };
}
