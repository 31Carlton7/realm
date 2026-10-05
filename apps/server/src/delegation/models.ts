import { AGENT_META, AGENT_MODELS, DEFAULT_MODEL_LABEL, SELECTABLE_AGENT_KINDS, canonicalModelKey, type AgentKind } from "@realm/contracts";

/**
 * Which model a delegated agent runs on, from the NAME a person or an agent used for it.
 *
 * "Can Fable use GPT-6 Luna to implement this" is the whole interface: nobody delegating work says
 * `{ agentKind: "codex", model: "gpt-6-luna" }`, and an agent relaying the request should not have to
 * know that GPT-6 Luna is a Codex model and Fable a Claude one. So a name resolves against the models
 * the agents on this Mac actually reported — the same probe rows the model picker draws — to the
 * harness that runs it and the id that harness takes.
 *
 * Pure: the caller hands in the probe rows and the registered kinds, so the rules below are testable
 * against any catalog without a probe, and the tool, the composer's list and the refusal all read one
 * description of what is nameable.
 */

/** What resolution reads from one agent's probe — the subset of `ProbeResult` it needs. */
export type ProbedAgent = {
  kind: AgentKind; available: boolean; loggedIn: boolean | null; reason: string | null;
  models?: readonly { id: string; label: string }[] | null;
};

/**
 * One model a delegated agent can be put on — a MODEL, with the route it would take.
 *
 * One entry per model rather than per (harness, model): Claude Fable 5.1 is reachable through the
 * `claude` CLI and through Cursor, and "Fable" means the model either way. `routes` keeps every
 * harness that offers it, and `kind`/`id` name the one a delegation takes (see `pickRoute`).
 */
export type DelegableModel = {
  /** `canonicalModelKey` of the name — the model's identity across harnesses. */
  key: string;
  /** The model's own name, the best one any harness gave it. */
  label: string;
  kind: AgentKind;
  /** The wire id on `kind`. */
  id: string;
  /** Whether `kind` is installed and signed in, as far as the probe knows. */
  ready: boolean;
  routes: { kind: AgentKind; id: string; ready: boolean }[];
};

/** What a delegation runs on: the harness, the model id (null = the harness's own default) and the
 *  name to report it by. */
export type ModelChoice = { kind: AgentKind; model: string | null; label: string };
export type ModelResolution = { ok: true; choice: ModelChoice } | { ok: false; message: string };

/**
 * The words that name a HARNESS rather than a model. A name made only of these ("Codex", "have
 * Cursor do it") is a request for that agent on its own default model, and one of these beside a
 * model's name ("Fable through Cursor") is a request for that route. Exhaustive so a new kind is a
 * compile error here rather than an agent nobody can name.
 */
const HARNESS_WORDS = {
  claude: ["claude"], codex: ["codex"], "acp:gemini": ["gemini"], "acp:cursor": ["cursor"],
  "acp:opencode": ["opencode"], "acp:copilot": ["copilot"], "acp:goose": ["goose"], "acp:qwen": ["qwen"],
  "acp:grok": ["grok"], "acp:fx": ["fx"], "acp:deepseek": ["deepseek"], "acp:openhands": ["openhands"],
  "acp:hermes": ["hermes"], fake: ["fake"],
} as const satisfies Record<AgentKind, readonly string[]>;

/** Filler a request wraps a name in — "use the GPT-6 Luna model", "Fable via Cursor". Never a word a
 *  model is named with: "mini", "pro" and "flash" are names, and stay. */
const FILLER = new Set(["a", "an", "the", "on", "via", "through", "thru", "with", "using", "use", "in", "model", "agent", "subagent", "sub", "please"]);

/** A version token: `5`, `5.1`, `4.5`, a date stamp. Everything else in a name is its family. */
const VERSION = /^\d+(\.\d+)*$/;

/** An ACP id's `[reasoning=medium,fast=false]` suffix is a setting of the model, not part of its
 *  name: two of them are one model run two ways, and neither is what a person types. */
const withoutParams = (name: string): string => name.replace(/\[[^\]]*\]\s*$/, "");

/** A name's tokens, by the same fold the picker keys models on. */
function tokensOf(name: string): string[] {
  return canonicalModelKey(withoutParams(name)).split("-").filter(Boolean);
}

/** Whether a label is a raw wire id (`claude-fable-5-1`) rather than a written name — model-rows'
 *  rule, for the same choice: which of two names for one model to show. */
const looksLikeId = (label: string): boolean => /^[a-z0-9][a-z0-9._-]*$/.test(label);

/** The kinds a delegation may consider, in the order a tie goes to: the vendor's own CLI ahead of a
 *  proxy (Fable through `claude`, not Cursor), then anything else registered (`fake`). */
export function delegationKinds(registered: readonly AgentKind[]): AgentKind[] {
  const have = new Set(registered);
  const offered = SELECTABLE_AGENT_KINDS.filter((k) => have.has(k));
  return [...offered, ...registered.filter((k) => !(SELECTABLE_AGENT_KINDS as readonly AgentKind[]).includes(k))];
}

/** A probed agent that said it cannot run is not a route; one nobody has asked about yet is given
 *  the benefit of the doubt, as the picker gives it — the child's own session says what is wrong. */
const readyOf = (probe: ProbedAgent | undefined): boolean => !probe || (probe.available && probe.loggedIn !== false);

/**
 * Every model a delegated agent could be put on, one entry per model, in harness order.
 *
 * Model lists come from the same two places the picker's do: a harness's live catalog when its probe
 * reported one, the curated static list otherwise (Claude has no enumeration channel at all).
 */
export function delegableModels(probes: readonly ProbedAgent[], registered: readonly AgentKind[]): DelegableModel[] {
  const byKey = new Map<string, DelegableModel>();
  const out: DelegableModel[] = [];
  for (const kind of delegationKinds(registered)) {
    const probe = probes.find((p) => p.kind === kind);
    const live = probe?.models && probe.models.length > 0 ? probe.models : null;
    const ready = readyOf(probe);
    for (const m of live ?? AGENT_MODELS[kind]) {
      const label = withoutParams(m.label);
      const key = canonicalModelKey(label);
      const seen = byKey.get(key);
      if (seen) {
        seen.routes.push({ kind, id: m.id, ready });
        if (looksLikeId(seen.label) && !looksLikeId(label)) seen.label = label;
        continue;
      }
      const entry: DelegableModel = { key, label, kind, id: m.id, ready, routes: [{ kind, id: m.id, ready }] };
      byKey.set(key, entry);
      out.push(entry);
    }
  }
  // The route each model takes is settled once every harness has been folded in: "prefer one that
  // is ready" cannot be answered while a model still has routes it has not been told about.
  for (const m of out) { const r = pickRoute(m.routes); m.kind = r.kind; m.id = r.id; m.ready = r.ready; }
  return out;
}

/** The route a model takes: the first ready one in harness order, else the first. */
function pickRoute<T extends { ready: boolean }>(routes: readonly T[]): T {
  return routes.find((r) => r.ready) ?? routes[0]!;
}

/** Numbers of a dotted version, for ordering: `5.1` → [5, 1]. */
const versionParts = (v: string): number[] => v.split(".").map(Number);
function compareVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
/** How new a model is within its family: its version tokens, newest first, compared in turn. */
function newer(a: string[], b: string[]): number {
  const va = a.filter((t) => VERSION.test(t)).map(versionParts).sort((x, y) => compareVersion(y, x));
  const vb = b.filter((t) => VERSION.test(t)).map(versionParts).sort((x, y) => compareVersion(y, x));
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = compareVersion(va[i] ?? [], vb[i] ?? []);
    if (d !== 0) return d;
  }
  return 0;
}

/** One way a query can match a model: its tokens are a subset of the model's name or of one of its ids. */
type Match = { model: DelegableModel; tokens: string[]; exact: boolean };

function matchesIn(query: readonly string[], models: readonly DelegableModel[], kind: AgentKind | null): Match[] {
  const out: Match[] = [];
  for (const m of models) {
    const routes = kind ? m.routes.filter((r) => r.kind === kind) : m.routes;
    if (routes.length === 0) continue;
    // The name first, then every id it is offered under: "claude-opus-5-5" and "gpt-6-luna" are how
    // agents copy a model out of a config file, and they name the same model the label does.
    const spellings = [tokensOf(m.label), ...routes.map((r) => tokensOf(r.id))];
    let best: Match | null = null;
    for (const tokens of spellings) {
      if (!query.every((t) => tokens.includes(t))) continue;
      const exact = tokens.length === query.length;
      if (!best || (exact && !best.exact)) best = { model: kind ? onRoute(m, kind) : m, tokens, exact };
    }
    if (best) out.push(best);
  }
  return out;
}

/** The model as it runs on one named harness — what "Fable through Cursor" asks for. */
function onRoute(m: DelegableModel, kind: AgentKind): DelegableModel {
  const r = m.routes.find((x) => x.kind === kind)!;
  return { ...m, kind, id: r.id, ready: r.ready };
}

/**
 * Narrow the matches to the one a person meant, or say why there is no single one.
 *
 * - An EXACT name wins outright: "Claude Opus 5" is Opus 5, never Opus 5.5.
 * - Otherwise the matches that leave the fewest words unsaid stay — "Astra" is GPT-6 Astra, and
 *   GPT-6 Astra Pro is a different thing the person did not ask for.
 * - Those that are then all one family differ only by version, and the newest is meant: "Fable" is
 *   the newest Fable, "Opus" the newest Opus.
 * - Two families left ("GPT-6" with an Astra and a Luna on offer) is a question, not an answer.
 */
function narrow(matches: readonly Match[], query: readonly string[]): { pick: DelegableModel } | { ambiguous: DelegableModel[] } {
  const exact = matches.filter((m) => m.exact);
  const pool = exact.length > 0 ? exact : matches;
  const unsaid = (m: Match) => m.tokens.filter((t) => !VERSION.test(t) && !query.includes(t));
  const fewest = Math.min(...pool.map((m) => unsaid(m).length));
  const close = pool.filter((m) => unsaid(m).length === fewest);
  const family = (m: Match) => m.tokens.filter((t) => !VERSION.test(t)).sort().join("-");
  if (new Set(close.map(family)).size === 1) {
    const newest = [...close].sort((a, b) => newer(b.tokens, a.tokens))[0]!;
    return { pick: newest.model };
  }
  return { ambiguous: close.map((m) => m.model) };
}

const harnessOf = (word: string): AgentKind | null =>
  (Object.entries(HARNESS_WORDS) as [AgentKind, readonly string[]][]).find(([, words]) => words.includes(word))?.[0] ?? null;

const harnessLabel = (kind: AgentKind): string => AGENT_META[kind].label;

/**
 * Resolve a name to the harness and model a delegated agent should run on.
 *
 * `kind` is an explicit `constraints.agentKind`: the name is then looked up on that harness alone,
 * and a model it does not offer is refused rather than quietly routed elsewhere — the caller said
 * which agent, and overriding that would be the resolver deciding something it was told.
 */
export function resolveModelName(name: string, models: readonly DelegableModel[], opts: {
  kind?: AgentKind;
  /** Registered kinds — what a harness-only name may resolve to. */
  kinds: readonly AgentKind[];
  probes?: readonly ProbedAgent[];
}): ModelResolution {
  const query = tokensOf(name).filter((t) => !FILLER.has(t));
  if (query.length === 0) return { ok: false, message: `refused: "${name}" names no model. ${menuSentence(models, harnessOnly(models, opts))}` };
  const kind = opts.kind ?? null;

  // A harness on its own: "Codex", "have Cursor do it". Its default model, which is what that agent
  // runs when nobody pins one — never a guess at which of its models was meant. A harness that is not
  // ready keeps its refusal back while the name is tried as a model: "Grok" is also a model Cursor
  // runs, and that is a better answer than "grok is not installed".
  let notReady: string | null = null;
  const harnesses = query.map(harnessOf);
  if (harnesses.every((h) => h !== null) && new Set(harnesses).size === 1) {
    const h = harnesses[0]!;
    if (kind && kind !== h) return { ok: false, message: `refused: "${name}" names ${harnessLabel(h)}, but constraints.agentKind asks for ${harnessLabel(kind)}. Drop one of them.` };
    if (opts.kinds.includes(h)) {
      const probe = opts.probes?.find((p) => p.kind === h);
      if (readyOf(probe)) return { ok: true, choice: { kind: h, model: null, label: DEFAULT_MODEL_LABEL[h] } };
      notReady = unready(harnessLabel(h), probe);
    }
  }

  let matches = matchesIn(query, models, kind);
  // A route word beside the model's name — "Fable through Cursor". Tried only when the whole name
  // matched nothing, because "Claude" is also a word in every Claude model's name. Beside an explicit
  // agentKind only that harness's word counts: the two must agree, or the name is a contradiction.
  if (matches.length === 0) {
    for (const word of new Set(query)) {
      const h = harnessOf(word);
      if (!h || (kind && h !== kind)) continue;
      const rest = query.filter((t) => t !== word);
      if (rest.length === 0) continue;
      const routed = matchesIn(rest, models, h);
      if (routed.length > 0) { matches = routed; break; }
    }
  }

  if (matches.length === 0) {
    if (kind && matchesIn(query, models, null).length > 0) {
      const elsewhere = [...new Set(matchesIn(query, models, null).flatMap((m) => m.model.routes.map((r) => harnessLabel(r.kind))))];
      return { ok: false, message: `refused: ${harnessLabel(kind)} has no model called "${name}" — it runs on ${elsewhere.join(" or ")}. Drop constraints.agentKind to let Realm route it, or name one of ${harnessLabel(kind)}'s: ${namesOn(models, kind)}.` };
    }
    if (notReady) return { ok: false, message: notReady };
    return { ok: false, message: `refused: no model called "${name}" is available here.${didYouMean(query, models, kind)} ${menuSentence(models, harnessOnly(models, opts))}` };
  }

  const verdict = narrow(matches, query);
  if ("ambiguous" in verdict) {
    const names = verdict.ambiguous.map((m) => `${m.label} (${harnessLabel(m.kind)})`);
    return { ok: false, message: `refused: "${name}" could mean ${names.slice(0, -1).join(", ")} or ${names.at(-1)}. Name the one you want.` };
  }
  const m = verdict.pick;
  if (!m.ready) return { ok: false, message: unready(`${m.label} runs on ${harnessLabel(m.kind)}, which`, opts.probes?.find((p) => p.kind === m.kind)) };
  return { ok: true, choice: { kind: m.kind, model: m.id, label: m.label } };
}

/** Why a harness cannot take the work, in the probe's own words where it gave some. */
function unready(subject: string, probe: ProbedAgent | undefined): string {
  const state = probe && !probe.available ? "is not installed on this Mac" : "is not signed in on this Mac";
  const why = probe?.reason ? ` (${probe.reason})` : "";
  return `refused: ${subject} ${state}${why}. Pick a model on an agent that is ready, or leave constraints.model out to use your own.`;
}

/** Harnesses that are ready but reported no model names — nameable only as themselves. */
function harnessOnly(models: readonly DelegableModel[], opts: { kinds: readonly AgentKind[]; probes?: readonly ProbedAgent[] }): AgentKind[] {
  const named = new Set(models.flatMap((m) => m.routes.map((r) => r.kind)));
  return delegationKinds(opts.kinds).filter((k) => !named.has(k) && readyOf(opts.probes?.find((p) => p.kind === k)));
}

/** A version-blind second look, for the refusal only: "GPT-6 Luna" against a catalog holding
 *  GPT-5.6 Luna is worth a pointer — and never an automatic pick, because 5.6 is not 6. */
function didYouMean(query: readonly string[], models: readonly DelegableModel[], kind: AgentKind | null): string {
  const words = query.filter((t) => !VERSION.test(t));
  if (words.length === 0 || words.length === query.length) return "";
  const near = matchesIn(words, models, kind).map((m) => m.model.label);
  return near.length > 0 && near.length <= 4 ? ` Did you mean ${near.slice(0, -1).join(", ")}${near.length > 1 ? " or " : ""}${near.at(-1)}?` : "";
}

/** The names on one harness, for a refusal that has already said which harness. */
function namesOn(models: readonly DelegableModel[], kind: AgentKind): string {
  const names = models.filter((m) => m.routes.some((r) => r.kind === kind)).map((m) => m.label);
  return names.length > 0 ? names.join(", ") : `its default (name the harness alone: "${harnessLabel(kind)}")`;
}

/**
 * What can be named, per harness — the refusal's list and the tool description's.
 *
 * Grouped by the harness each model RUNS on, ready harnesses first, each capped so a 165-model
 * catalog (fx's, measured) is a line rather than a page. A model is listed once, under its route.
 */
export function modelMenu(models: readonly DelegableModel[], opts: { perHarness?: number; readyOnly?: boolean } = {}): string[] {
  const cap = opts.perHarness ?? 12;
  const groups = new Map<AgentKind, { ready: boolean; names: string[] }>();
  for (const m of models) {
    if (opts.readyOnly && !m.ready) continue;
    const g = groups.get(m.kind) ?? { ready: m.ready, names: [] };
    g.names.push(m.label);
    groups.set(m.kind, g);
  }
  return [...groups.entries()]
    .sort(([, a], [, b]) => Number(b.ready) - Number(a.ready))
    .map(([k, g]) => {
      const shown = g.names.slice(0, cap).join(", ");
      const more = g.names.length > cap ? ` and ${g.names.length - cap} more` : "";
      return `${harnessLabel(k)}${g.ready ? "" : " (not ready)"}: ${shown}${more}`;
    });
}

function menuSentence(models: readonly DelegableModel[], bare: readonly AgentKind[] = []): string {
  const lines = modelMenu(models);
  if (bare.length > 0) lines.push(`By harness alone, on its own default model: ${bare.map(harnessLabel).join(", ")}`);
  return lines.length === 0
    ? "No agent on this Mac reported a model list; name a harness alone (\"Codex\", \"Claude\") to use its default, or leave constraints.model out to use your own."
    : `Name one of these in constraints.model, or a harness alone ("Codex") for its default, or leave it out to use your own model:\n${lines.map((l) => `- ${l}`).join("\n")}`;
}
