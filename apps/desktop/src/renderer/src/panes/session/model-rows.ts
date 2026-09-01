import { AGENT_META, AGENT_MODELS, DEFAULT_MODEL_LABEL, SELECTABLE_AGENT_KINDS, canonicalModelKey, type AgentKind } from "@realm/contracts";
import { agentAvailability, availabilityNote } from "../../state/agent-availability";
import type { AgentProbe } from "../../state/store";

/** The rail's selection: one harness, the favourites shelf, or everything. */
export type RailFilter = AgentKind | "favorites" | null;

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
        // A second route to a model already listed. Record the id and move on — the row keeps the
        // name and the resolved harness the FIRST claimant gave it.
        existing.harnesses.push(k);
        existing.ids[k] = e.id;
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
 * Search + rail filtering.
 *
 * The query matches the model name OR the agent name, because both are on the row and users reach for
 * either ("opus", "cursor"). It deliberately does NOT match model *ids*: `claude-fable-5` would make
 * "5" match everything, and an id the row never displays is not something anyone is typing at.
 *
 * A harness tab matches any row that harness can RUN, not merely the one it was resolved to — the tab
 * asks "what could I get from Cursor", and a model that resolved to the Claude CLI because that is
 * installed is still a model Cursor offers.
 */
export function filterRows(rows: ModelRow[], { query, provider }: { query: string; provider: RailFilter }): ModelRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) =>
    (provider === null || (provider === "favorites" ? r.favorite : r.harnesses.includes(provider))) &&
    (q === "" || r.label.toLowerCase().includes(q) || r.agentLabel.toLowerCase().includes(q)));
}

/** Favourites first, each group keeping the order `modelRows` built — the shortcut-badged rows lead
 *  the list, and un-starring one drops it back exactly where it was rather than to the end. */
export function sortFavoritesFirst(rows: ModelRow[]): ModelRow[] {
  return [...rows.filter((r) => r.favorite), ...rows.filter((r) => !r.favorite)];
}

/** The rail's entries: every harness reachable from `rows`, in row order, deduped. */
export function railKinds(rows: ModelRow[]): AgentKind[] {
  return [...new Set(rows.flatMap((r) => r.harnesses))];
}
