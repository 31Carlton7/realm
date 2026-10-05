import { describe, expect, it } from "vitest";
import { AGENT_NOTES, DEFAULT_MODEL_LABEL, MODEL_NOTES, canonicalModelKey, type ModelInfo } from "@realm/contracts";
import {
  agentRowHint, billingLead, chipLabel, effortCurrent, effortOptions, fastModeAvailability, fastModeHint, fastModeShown, fastModeTip, fastModeTitle, filterRows, flatten, groupRows,
  modelAbout, modelLabel, modelRows, resolveModelName, type FastMode, type ModelRow,
} from "./model-catalog";
import type { AgentProbe } from "../../state/store";

const probe = (kind: AgentProbe["kind"], models: AgentProbe["models"]): AgentProbe =>
  ({ kind, available: true, version: "1", loggedIn: true, reason: null, models });
const missing = (kind: AgentProbe["kind"]): AgentProbe =>
  ({ kind, available: false, version: null, loggedIn: null, reason: "not on PATH", models: null });

/** The catalog cursor-agent actually reported live: parameterized ids, `default[]` for Auto. */
const cursorCatalog = [
  { id: "default[]", label: "Auto" },
  { id: "composer-2.5[fast=true]", label: "composer-2.5" },
  { id: "gpt-5.3-codex[reasoning=medium,fast=false]", label: "gpt-5.3-codex" },
];

/** Codex's `model/list` as the probe now hands it over: the `priority` tier per model, and the
 *  default marked — the shape of the adapter's own fake app-server fixture. */
const codexCatalog = [
  { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", fastMode: true, isDefault: true },
  { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", fastMode: false },
  { id: "gpt-6-luna", label: "GPT-6-Luna", fastMode: true },
];

describe("modelRows with a probe catalog", () => {
  it("renders the probe's models for that kind, led by an explicit adapter-default row", () => {
    const rows = modelRows({ kind: "acp:cursor", model: null, agentProbe: [probe("acp:cursor", cursorCatalog)], canSwitchAgent: true });
    const cursor = rows.filter((r) => r.kind === "acp:cursor");
    // The default row leads because a live catalog's order promises nothing about what an un-pinned
    // session runs (Cursor's leads with Auto while the adapter default is Composer — verified live).
    expect(cursor[0]).toMatchObject({ modelId: null, label: DEFAULT_MODEL_LABEL["acp:cursor"], selected: true });
    expect(cursor.slice(1).map((r) => ({ id: r.modelId, label: r.label }))).toEqual(cursorCatalog.map((m) => ({ id: m.id, label: m.label })));
    // model === null selects ONLY the default row — never the catalog's first entry.
    expect(cursor.filter((r) => r.selected)).toHaveLength(1);
  });

  it("never renders one kind's catalog under another kind", () => {
    // Codex's probe answered without models; only Cursor's carries a catalog. A find() keyed on the
    // wrong entry would offer Cursor's parameterized ids to Codex, which rejects them on the wire.
    const probes = [probe("codex", null), probe("acp:cursor", cursorCatalog)];
    const rows = modelRows({ kind: "codex", model: null, agentProbe: probes, canSwitchAgent: true });
    const codex = rows.filter((r) => r.kind === "codex");
    expect(codex).toHaveLength(1); // static AGENT_MODELS.codex is empty -> the single default row
    expect(codex[0]).toMatchObject({ modelId: null, label: DEFAULT_MODEL_LABEL.codex });
    expect(rows.filter((r) => r.kind === "acp:cursor").map((r) => r.modelId)).toContain("default[]");
  });

  it("keeps the curated static list (and its first-row-selected rule) when the probe has no models", () => {
    for (const models of [null, undefined, []] as const) {
      const rows = modelRows({ kind: "claude", model: null, agentProbe: [probe("claude", models as AgentProbe["models"])], canSwitchAgent: true });
      const claude = rows.filter((r) => r.kind === "claude");
      expect(claude.map((r) => r.modelId)).toEqual(["claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]);
      expect(claude[0]!.selected).toBe(true); // static lists pin first row = adapter default (presets.test.ts)
    }
  });

  it("a probe catalog for the session's own kind still yields exactly one selected row", () => {
    const rows = modelRows({ kind: "codex", model: "gpt-5.6-terra", agentProbe: [probe("codex", codexCatalog)], canSwitchAgent: false });
    expect(rows.filter((r) => r.selected).map((r) => r.modelId)).toEqual(["gpt-5.6-terra"]);
    // And the blocked reason still lands on the OTHER kinds only.
    expect(rows.filter((r) => r.kind === "codex").every((r) => r.blockedReason === null)).toBe(true);
    expect(rows.filter((r) => r.kind !== "codex").every((r) => r.blockedReason !== null)).toBe(true);
  });
});

describe("filterRows at catalog scale", () => {
  const bigCatalog = Array.from({ length: 40 }, (_, i) => ({ id: `m-${i}[x=1]`, label: `Model ${i}` }));
  const rows = modelRows({ kind: "acp:cursor", model: null, agentProbe: [probe("acp:cursor", bigCatalog)], canSwitchAgent: true });

  it("search still narrows by model name across the whole catalog", () => {
    expect(filterRows(rows, "model 39").map((r) => r.label)).toEqual(["Model 39"]);
    expect(filterRows(rows, "model 3").length).toBe(11); // 3, 30..39
  });
});

/**
 * Cursor proxying models other harnesses also run — the overlap the model-first list has to collapse.
 *
 * Labels are the RAW IDS cursor-agent actually reports (verified live against 2026.07.25), not the
 * tidy names its own UI prints: an earlier fixture used pretty labels, every assertion passed, and
 * the shipped app still showed "Claude Fable 5.1" twice.
 */
const CURSOR_FABLE_ID = "claude-fable-5-1[thinking=true,context=300k,effort=high,fast=false]";
const cursorWithClaude = [
  { id: "default[]", label: "Auto" },
  { id: CURSOR_FABLE_ID, label: "claude-fable-5-1" }, // Claude's own list calls this Claude Fable 5.1
  { id: "gpt-5.5", label: "GPT-5.5" },
];
const fable = (rows: ModelRow[]) => rows.filter((r) => r.label === "Claude Fable 5.1");

describe("one row per model, not per (harness, model)", () => {
  it("collapses a model two harnesses offer into a single row that remembers both ids", () => {
    const rows = modelRows({ kind: "claude", model: null, canSwitchAgent: true,
      agentProbe: [probe("claude", null), probe("acp:cursor", cursorWithClaude)] });
    expect(fable(rows)).toHaveLength(1);
    expect(fable(rows)[0]).toMatchObject({
      kind: "claude", harnesses: ["claude", "acp:cursor"], alternates: ["acp:cursor"],
      ids: { claude: "claude-fable-5-1", "acp:cursor": CURSOR_FABLE_ID },
    });
  });

  it("shows the model's NAME even when the harness that claimed it reports a bare id", () => {
    const rows = modelRows({ kind: "acp:cursor", model: null, canSwitchAgent: true,
      agentProbe: [probe("claude", null), probe("acp:cursor", cursorWithClaude)] });
    expect(rows.map((r) => r.label)).toContain("Claude Fable 5.1");
    expect(rows.map((r) => r.label)).not.toContain("claude-fable-5-1");
    // A model only ONE harness offers keeps whatever that harness called it.
    expect(rows.map((r) => r.label)).toContain("Auto");
  });

  it("keeps a model on the session's own harness even when that CLI is signed out", () => {
    // Availability is reported, never blocking: the install card is the fix, not a silent reroute.
    const signedOut: AgentProbe = { kind: "claude", available: true, version: "1", loggedIn: false, reason: null, models: null };
    const rows = modelRows({ kind: "claude", model: null, canSwitchAgent: true,
      agentProbe: [signedOut, probe("acp:cursor", cursorWithClaude)] });
    expect(fable(rows)[0]).toMatchObject({ kind: "claude", modelId: "claude-fable-5-1", note: "signed out" });
  });

  it("prefers the vendor's own CLI over a proxy when the session's harness offers neither", () => {
    const rows = modelRows({ kind: "codex", model: null, canSwitchAgent: true,
      agentProbe: [probe("claude", null), probe("acp:cursor", cursorWithClaude)] });
    expect(fable(rows)[0]).toMatchObject({ kind: "claude", modelId: "claude-fable-5-1" });
  });

  it("routes around a harness that isn't installed", () => {
    const rows = modelRows({ kind: "codex", model: null, canSwitchAgent: true,
      agentProbe: [missing("claude"), probe("acp:cursor", cursorWithClaude)] });
    expect(fable(rows)[0]).toMatchObject({ kind: "acp:cursor", modelId: CURSOR_FABLE_ID });
  });

  it("never merges two harnesses' adapter-default rows", () => {
    // "the Codex default" and "the Cursor default" are different models described the same way.
    const rows = modelRows({ kind: "codex", model: null, canSwitchAgent: true,
      agentProbe: [probe("codex", [{ id: "gpt-5.6", label: "GPT-5.6" }]), probe("acp:cursor", cursorWithClaude)] });
    const defaults = rows.filter((r) => r.key.startsWith("default:"));
    const pair = defaults.filter((r) => r.kind === "codex" || r.kind === "acp:cursor");
    expect(pair.map((r) => [r.kind, r.label])).toEqual([["codex", DEFAULT_MODEL_LABEL.codex], ["acp:cursor", DEFAULT_MODEL_LABEL["acp:cursor"]]]);
    expect(defaults.every((r) => r.harnesses.length === 1)).toBe(true);
  });
});

describe("groupRows", () => {
  const group = (groups: ReturnType<typeof groupRows>, label: string) => groups.find((g) => g.label === label);
  const names = (groups: ReturnType<typeof groupRows>, label: string) => group(groups, label)?.rows.map((r) => r.label) ?? [];

  it("lists a model ONCE, under the harness a click runs it through, carrying its other harness", () => {
    /* The old list drew Fable under Claude AND under Cursor, and a detail pane beside it to pick the
       route — the same model read as two, and the choice was made twice. One row now, and the second
       way to run it rides on that row (`alternates`) for the picker to offer in one click. */
    const rows = modelRows({ kind: "claude", model: null, canSwitchAgent: true,
      agentProbe: [probe("claude", null), probe("acp:cursor", cursorWithClaude)] });
    const groups = groupRows(rows, { query: "", kind: "claude" });
    expect(flatten(groups).filter((r) => r.label === "Claude Fable 5.1")).toHaveLength(1);
    expect(names(groups, "Claude")).toContain("Claude Fable 5.1");
    expect(names(groups, "Cursor")).not.toContain("Claude Fable 5.1");
    expect(group(groups, "Claude")!.rows.find((r) => r.label === "Claude Fable 5.1")!.alternates).toEqual(["acp:cursor"]);
  });

  it("puts the model under the session's own harness when it runs there, Claude's still reachable", () => {
    const rows = modelRows({ kind: "acp:cursor", model: null, canSwitchAgent: true,
      agentProbe: [probe("claude", null), probe("acp:cursor", cursorWithClaude)] });
    const groups = groupRows(rows, { query: "", kind: "acp:cursor" });
    expect(groups[0]!.label).toBe("Cursor");
    const row = group(groups, "Cursor")!.rows.find((r) => r.label === "Claude Fable 5.1")!;
    expect(row).toMatchObject({ kind: "acp:cursor", alternates: ["claude"] });
  });

  it("folds every agent with nothing but its own default, or not installed, into Other agents", () => {
    /* Eight ACP agents whose catalog Realm cannot ask each drew a heading over one row reading
       "Default" — the long-list clutter. One group, one row per agent, the agent's name doing the
       work. A missing CLI is there too, still pickable: the install card is where it leads. */
    const rows = modelRows({ kind: "claude", model: null, canSwitchAgent: true, agentProbe: [probe("claude", null), missing("codex")] });
    const groups = groupRows(rows, { query: "", kind: "claude" });
    // Cursor's and Gemini's lone rows fold too — "Composer" under a heading of its own was one more
    // heading for one more click — and DeepSeek, whose two models are curated, keeps its group.
    expect(groups.map((g) => g.label)).toEqual(["Claude", "DeepSeek", "Other agents"]);
    const others = group(groups, "Other agents")!;
    expect(others.byHarness).toBe(true);
    expect(others.rows.map((r) => r.kind)).toEqual(["codex", "acp:cursor", "acp:gemini", "acp:opencode", "acp:copilot", "acp:goose", "acp:qwen", "acp:grok", "acp:fx", "acp:openhands", "acp:hermes"]);
    // One row per agent: the missing Codex contributes its default, not every model it has.
    expect(others.rows.filter((r) => r.kind === "codex")).toHaveLength(1);
  });

  it("never folds the session's own agent away, however little it lists", () => {
    const rows = modelRows({ kind: "acp:openhands", model: null, canSwitchAgent: true, agentProbe: [] });
    const groups = groupRows(rows, { query: "", kind: "acp:openhands" });
    expect(groups[0]).toMatchObject({ label: "OpenHands", kind: "acp:openhands" });
    expect(groups[0]!.rows.map((r) => [r.label, r.selected])).toEqual([["Default", true]]);
    expect(group(groups, "Other agents")!.rows.map((r) => r.kind)).not.toContain("acp:openhands");
  });

  it("leaves out what this session can no longer switch to", () => {
    // After the first message the agent is fixed; a list of rows nobody can pick is the clutter, and
    // the picker says why in one line instead.
    const rows = modelRows({ kind: "claude", model: null, canSwitchAgent: false,
      agentProbe: [probe("claude", null), probe("acp:cursor", cursorWithClaude)] });
    const groups = groupRows(rows, { query: "", kind: "claude" });
    expect(groups.map((g) => g.label)).toEqual(["Claude"]);
    expect(flatten(groups).every((r) => r.kind === "claude" && r.alternates.length === 0)).toBe(true);
  });

  it("leads with Favourites, and a starred model appears there alone", () => {
    const rows = modelRows({ kind: "claude", model: null, canSwitchAgent: true,
      agentProbe: [probe("claude", null), probe("acp:cursor", cursorWithClaude)], favorites: [canonicalModelKey("Claude Fable 5.1")] });
    const groups = groupRows(rows, { query: "", kind: "claude" });
    expect(groups[0]).toMatchObject({ label: "Favourites" });
    expect(groups[0]!.rows.map((r) => r.label)).toEqual(["Claude Fable 5.1"]);
    expect(flatten(groups).filter((r) => r.label === "Claude Fable 5.1")).toHaveLength(1);
    expect(groupRows(modelRows({ kind: "claude", model: null, canSwitchAgent: true, agentProbe: [] }), { query: "", kind: "claude" })
      .map((g) => g.label)).not.toContain("Favourites");
  });

  it("collapses a search into one unlabelled group of the matches", () => {
    const rows = modelRows({ kind: "claude", model: null, canSwitchAgent: true, agentProbe: [] });
    const hits = filterRows(rows, "opus");
    expect(groupRows(hits, { query: "opus", kind: "claude" })).toEqual([{ id: "results", label: "", rows: hits }]);
    expect(groupRows([], { query: "zzz", kind: "claude" })).toEqual([]);
  });

  it("search finds every model a harness can run, not just the ones routed to it", () => {
    const rows = modelRows({ kind: "claude", model: null, canSwitchAgent: true,
      agentProbe: [probe("claude", null), probe("acp:cursor", cursorWithClaude)] });
    const cursorHits = filterRows(rows, "cursor").map((r) => r.label);
    expect(cursorHits).toContain("Claude Fable 5.1");
    expect(cursorHits).toContain("GPT-5.5");
    expect(cursorHits).not.toContain("Claude Sonnet 5"); // claude-only, and Cursor never offered it
  });
});

describe("names", () => {
  const rows = modelRows({ kind: "claude", model: "claude-opus-5-5", canSwitchAgent: true,
    agentProbe: [probe("claude", null), probe("acp:cursor", cursorWithClaude), probe("acp:grok", [{ id: "grok-4.6", label: "Grok 4.6" }])] });
  const row = (label: string) => rows.find((r) => r.label === label)!;

  it("drops the vendor's word where the harness's mark already says it, and only there", () => {
    expect(modelLabel(row("Claude Fable 5.1"))).toBe("Fable 5.1");
    // Through Cursor, the vendor's word is information.
    const viaCursor = { ...row("Claude Fable 5.1"), kind: "acp:cursor" as const };
    expect(modelLabel(viaCursor)).toBe("Claude Fable 5.1");
    // A family that IS the vendor's name keeps it — "4.6" alone is not a model.
    expect(modelLabel(row("Grok 4.6"))).toBe("Grok 4.6");
  });

  it("lets an agent's row say which model its default runs, and nothing when that says nothing", () => {
    const all = modelRows({ kind: "claude", model: null, canSwitchAgent: true, agentProbe: [] });
    const of = (kind: string) => agentRowHint(all.find((r) => r.kind === kind)!);
    expect(of("codex")).toBe("GPT-5.6");
    expect(of("acp:cursor")).toBe("Composer");
    expect(of("acp:gemini")).toBeNull(); // "Gemini, Gemini"
    expect(of("acp:opencode")).toBeNull(); // "OpenCode, Default"
  });

  it("names the chip from the session's own row, a pinned id nothing lists, or the harness default", () => {
    expect(chipLabel("claude", "claude-opus-5-5", rows)).toBe("Opus 5.5");
    expect(chipLabel("claude", "claude-retired-9", modelRows({ kind: "claude", model: "claude-retired-9", canSwitchAgent: true, agentProbe: [] }))).toBe("claude-retired-9");
    expect(chipLabel("acp:hermes", null, [])).toBe(DEFAULT_MODEL_LABEL["acp:hermes"]);
  });
});

describe("effortOptions", () => {
  const entry = (efforts: string[]): ModelInfo => ({ key: "k", label: "L", vendor: "", priceIn: null, priceOut: null, context: null, efforts, blurb: null });
  const ask = (over: Partial<Parameters<typeof effortOptions>[0]> = {}) =>
    effortOptions({ kind: "claude", model: null, agentProbe: [], remembered: {}, ...over });
  const ids = (o: ReturnType<typeof effortOptions>) => o.levels.map((l) => l.id);

  it("offers nothing where the harness takes no level, or nothing has named any", () => {
    // The scripted agent takes none; Codex with no catalog, and an ACP agent with no thought_level
    // option, have named none — a control there would be a setting wired to nothing.
    for (const kind of ["fake", "codex", "acp:cursor", "acp:opencode"] as const) expect(ask({ kind })).toEqual({ levels: [], defaultId: null });
  });

  it("takes Claude's levels from what Claude Code said of the model, and its documented default", () => {
    expect(ask({ model: "claude-haiku-4-5", remembered: { "claude:claude-haiku-4-5": [] } })).toEqual({ levels: [], defaultId: null });
    const sonnet = ask({ model: "claude-sonnet-5", remembered: { "claude:claude-sonnet-5": ["low", "medium", "high"] } });
    expect(ids(sonnet)).toEqual(["low", "medium", "high"]);
    // The SDK documents `high` as the default ("Deep reasoning (default)").
    expect(sonnet.defaultId).toBe("high");
    expect(sonnet.levels.map((l) => l.label)).toEqual(["Low", "Medium", "High"]);
  });

  it("narrows Realm's levels by the public catalog until Claude Code has said, and never to nothing", () => {
    expect(ids(ask())).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(ids(ask({ info: entry(["high", "medium", "low", "minimal"]) }))).toEqual(["low", "medium", "high"]);
    expect(ids(ask({ info: entry([]) }))).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(ask({ info: entry(["low", "medium"]) }).defaultId).toBeNull(); // no `high` here to default to
  });

  it("takes Codex's levels and default from the model's own catalog row, the default row's from the marked model", () => {
    const codex = probe("codex", codexCatalog.map((m, i) => ({ ...m, efforts: i === 1 ? ["low", "medium", "high"] : ["low", "medium", "high", "xhigh"], defaultEffort: "medium" })));
    expect(ask({ kind: "codex", model: "gpt-5.6-terra", agentProbe: [codex] })).toMatchObject({ defaultId: "medium" });
    expect(ids(ask({ kind: "codex", model: "gpt-5.6-terra", agentProbe: [codex] }))).toEqual(["low", "medium", "high"]);
    expect(ids(ask({ kind: "codex", model: null, agentProbe: [codex] }))).toEqual(["low", "medium", "high", "xhigh"]);
    expect(ask({ kind: "codex", model: "gpt-9", agentProbe: [codex] }).levels).toEqual([]);
  });

  it("takes an ACP agent's own names for its levels, this session's over the probe's", () => {
    const opencode: AgentProbe = { ...probe("acp:opencode", null), efforts: [{ id: "low", label: "low" }, { id: "think", label: "Think hard" }], defaultEffort: "low" };
    expect(ask({ kind: "acp:opencode", agentProbe: [opencode] })).toEqual({ levels: [{ id: "low", label: "Low" }, { id: "think", label: "Think hard" }], defaultId: "low" });
    expect(ask({ kind: "acp:opencode", agentProbe: [opencode], init: { efforts: [{ id: "deep", label: "Deep" }], defaultEffort: "deep" } }))
      .toEqual({ levels: [{ id: "deep", label: "Deep" }], defaultId: "deep" });
  });
});

describe("effortCurrent", () => {
  const levels = [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }];

  it("is the session's own level where the model takes it, else the default the harness named", () => {
    expect(effortCurrent({ levels, value: "high", defaultId: "medium" })).toEqual({ index: 2, choice: levels[2], chosen: true });
    expect(effortCurrent({ levels, value: null, defaultId: "medium" })).toEqual({ index: 1, choice: levels[1], chosen: false });
    // A level set under another model is not what runs on this one.
    expect(effortCurrent({ levels, value: "max", defaultId: "medium" })).toEqual({ index: 1, choice: levels[1], chosen: false });
  });

  it("points at nothing where the session chose nothing and the harness named no default", () => {
    expect(effortCurrent({ levels, value: null, defaultId: null })).toEqual({ index: -1, choice: null, chosen: false });
  });
});

describe("fastModeAvailability", () => {
  const claudeRows = modelRows({ kind: "claude", model: null, canSwitchAgent: true, agentProbe: [] });
  const ask = (over: Partial<Parameters<typeof fastModeAvailability>[0]> = {}) =>
    fastModeAvailability({ kind: "claude", model: null, agentProbe: [], remembered: {}, rows: claudeRows, ...over });

  it("is nothing at all where Realm cannot ask the harness", () => {
    expect(ask({ kind: "acp:cursor" })).toEqual({ state: "none" });
    expect(ask({ kind: "fake", remembered: { "fake:": true } })).toEqual({ state: "none" });
  });

  it("is unknown — not absent — on a harness that can be asked, before anything has answered", () => {
    /* THE owner's case: a new session on Claude Fable 5.1 showed no fast mode at all. Claude can be
       asked; nothing has said about this model yet; the honest state is "the first turn will say". */
    expect(ask()).toEqual({ state: "unknown" });
    expect(ask({ model: "claude-fable-5-1" })).toEqual({ state: "unknown" });
  });

  it("takes the remembered answer for the model asked for, and only for that one", () => {
    expect(ask({ model: "claude-opus-5-5", remembered: { "claude:claude-opus-5-5": true } })).toEqual({ state: "offered", source: "remembered" });
    expect(ask({ model: "claude-sonnet-5", remembered: { "claude:claude-opus-5-5": true, "codex:claude-sonnet-5": true } })).toEqual({ state: "unknown" });
    expect(ask({ remembered: { "claude:": true } })).toEqual({ state: "offered", source: "remembered" });
  });

  it("reads Codex's catalog per model, and the marked default for a session that pinned none", () => {
    const codexRows = modelRows({ kind: "codex", model: null, canSwitchAgent: true, agentProbe: [probe("codex", codexCatalog)] });
    const codex = (model: string | null) => fastModeAvailability({ kind: "codex", model, agentProbe: [probe("codex", codexCatalog)], remembered: {}, rows: codexRows });
    expect(codex("gpt-5.6-sol")).toEqual({ state: "offered", source: "catalog" });
    expect(codex(null)).toEqual({ state: "offered", source: "catalog" });
    expect(codex("gpt-5.6-terra")).toEqual({ state: "unavailable", source: "catalog", alternatives: ["GPT-5.6-Sol", "GPT-6-Luna"] });
    // The catalog is the CLI's word today; a remembered answer is an older one.
    expect(fastModeAvailability({ kind: "codex", model: "gpt-5.6-terra", agentProbe: [probe("codex", codexCatalog)], remembered: { "codex:gpt-5.6-terra": true }, rows: codexRows }))
      .toMatchObject({ state: "unavailable", source: "catalog" });
  });

  it("lets the session's own handshake win, while it still describes the model asked for", () => {
    const remembered = { "claude:claude-opus-5-5": true };
    expect(ask({ model: "claude-opus-5-5", remembered, init: { model: "claude-opus-5-5[1m]", supportsFastMode: false } }))
      .toMatchObject({ state: "unavailable", source: "session" });
    // Picked another model since: the handshake is about the old one, and the memory speaks.
    expect(ask({ model: "claude-opus-5-5", remembered, init: { model: "claude-fable-5-1", supportsFastMode: false } }))
      .toEqual({ state: "offered", source: "remembered" });
  });

  it("names the models on the same harness that do offer it", () => {
    const remembered = { "claude:claude-fable-5-1": false, "claude:claude-opus-5-5": true, "claude:claude-sonnet-5": true, "codex:gpt-5.6-sol": true };
    expect(ask({ model: "claude-fable-5-1", remembered })).toEqual({ state: "unavailable", source: "remembered", alternatives: ["Opus 5.5", "Sonnet 5"] });
  });
});

describe("the fast-mode line, the bolt's tooltip and the chip's bolt", () => {
  const fast = (over: Partial<FastMode> = {}): FastMode =>
    ({ on: false, state: null, reason: null, requested: null, onChange: () => {}, availability: { state: "offered", source: "session" },
      tip: "Fast mode: 1.5x speed, increased usage.", ...over });

  it("says nothing under an unpressed bolt — its tooltip says what is true of it", () => {
    // A note that appears every time is a note nobody reads.
    const each: FastMode["availability"][] = [{ state: "unknown" }, { state: "offered", source: "catalog" }, { state: "unavailable", source: "catalog", alternatives: ["GPT-5.6-Sol"] }];
    for (const availability of each) {
      expect(fastModeHint(fast({ availability }), "GPT-5.6-Terra")).toBeNull();
    }
  });

  it("says what a request will meet: the first turn's check, a model that cannot, or the report", () => {
    expect(fastModeHint(fast({ on: true, availability: { state: "unknown" } }), "Fable 5.1")).toBe("Fast mode is asked for — the first turn checks it.");
    expect(fastModeHint(fast({ on: true, availability: { state: "unavailable", source: "catalog", alternatives: ["GPT-5.6-Sol"] } }), "GPT-5.6-Terra"))
      .toBe("Fast mode isn’t offered on GPT-5.6-Terra — GPT-5.6-Sol offers it.");
    expect(fastModeHint(fast({ on: true, availability: { state: "unavailable", source: "catalog", alternatives: ["Opus 5.5", "Sonnet 5", "Fable 5"] } }), "Haiku 4.5"))
      .toBe("Fast mode isn’t offered on Haiku 4.5 — Opus 5.5, Sonnet 5 and Fable 5 offer it.");
    expect(fastModeHint(fast({ on: true, availability: { state: "unavailable", source: "catalog", alternatives: [] } }), "Haiku 4.5")).toBe("Fast mode isn’t offered on Haiku 4.5.");
    expect(fastModeHint(fast({ on: true, state: "off", reason: "free", requested: true }), "Fable 5.1")).toMatch(/plan does not include/);
    expect(fastModeHint(fast({ on: true, state: "off", reason: "free", requested: true, availability: { state: "unknown" } }), "Fable 5.1")).toMatch(/plan does not include/);
  });

  it("titles the bolt with what fast mode buys, what is still unchecked, or which models have it", () => {
    expect(fastModeTitle(fast(), "GPT-5.6-Sol")).toBe("Fast mode: 1.5x speed, increased usage.");
    expect(fastModeTitle(fast({ availability: { state: "unknown" } }), "Fable 5.1")).toBe("Fast mode: 1.5x speed, increased usage. The first turn checks whether Fable 5.1 can run it.");
    expect(fastModeTitle(fast({ availability: { state: "unavailable", source: "catalog", alternatives: ["GPT-5.6-Sol"] } }), "GPT-5.6-Terra"))
      .toBe("Fast mode isn’t offered on GPT-5.6-Terra — GPT-5.6-Sol offers it.");
  });

  it("takes the tooltip's words from the harness catalog where it has them", () => {
    const codex = probe("codex", [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", fastMode: true, fastDescription: "1.5x speed, increased usage", isDefault: true }]);
    expect(fastModeTip("codex", "gpt-5.6-sol", [codex])).toBe("Fast mode: 1.5x speed, increased usage.");
    expect(fastModeTip("codex", null, [codex])).toBe("Fast mode: 1.5x speed, increased usage.");
    expect(fastModeTip("claude", null, [])).toBe("Fast mode: faster responses, at a higher cost.");
  });

  it("wears the bolt for a request nothing has refused, and drops it the moment something has", () => {
    expect(fastModeShown(fast({ on: true }))).toBe(true);
    expect(fastModeShown(fast({ on: true, availability: { state: "unknown" } }))).toBe(true);
    expect(fastModeShown(fast({ on: true, state: "cooldown", requested: true }))).toBe(true);
    // Never claim a speed nobody is serving: refused by the turn that asked, or a model that cannot.
    expect(fastModeShown(fast({ on: true, state: "off", reason: "free", requested: true }))).toBe(false);
    expect(fastModeShown(fast({ on: true, availability: { state: "unavailable", source: "session", alternatives: [] } }))).toBe(false);
    expect(fastModeShown(fast({ on: false }))).toBe(false);
    // A refusal of a turn that never asked is not a verdict on the switch.
    expect(fastModeShown(fast({ on: true, state: "off", reason: "sdk_opt_in_required", requested: false }))).toBe(true);
  });
});

describe("modelAbout", () => {
  const rows = modelRows({ kind: "claude", model: null, agentProbe: [missing("codex")], canSwitchAgent: true });
  const fableRow = rows.find((r) => r.label === "Claude Fable 5.1")!;
  const info = (over: Partial<ModelInfo> = {}): Record<string, ModelInfo> => ({
    [fableRow.key]: { key: fableRow.key, label: "Claude Fable 5.1", vendor: "Anthropic", priceIn: 10, priceOut: 50,
      context: 1_000_000, efforts: ["max", "low"], blurb: "Vendor prose.", ...over },
  });

  it("says what the model is for in Realm's words, then its context and API price", () => {
    expect(modelAbout(fableRow, "claude", info())).toEqual({
      note: MODEL_NOTES.get(fableRow.key), warning: null, specs: "1M context · $10 in · $50 out per Mtok", billing: AGENT_NOTES.claude.billing,
    });
  });

  it("falls back to the catalog's sentence, then to what the harness is for, and never invents a price", () => {
    const other = { ...fableRow, key: canonicalModelKey("Someone Else 9"), label: "Someone Else 9" };
    expect(MODEL_NOTES.has(other.key)).toBe(false);
    expect(modelAbout(other, "claude", { [other.key]: { ...info()[fableRow.key]!, key: other.key, blurb: "Only the vendor's line." } }).note).toBe("Only the vendor's line.");
    expect(modelAbout(other, "claude", {})).toMatchObject({ note: AGENT_NOTES.claude.good, specs: null });
  });

  it("puts what would surprise someone in the note's place: a missing CLI, or a harness's limits", () => {
    const codex = rows.find((r) => r.kind === "codex")!;
    expect(modelAbout(codex, "codex", {}).warning).toMatch(/Codex isn’t installed/);
    const deepseek = rows.find((r) => r.kind === "acp:deepseek")!;
    expect(modelAbout(deepseek, "acp:deepseek", {}).warning).toBe(AGENT_NOTES["acp:deepseek"].limits);
  });
});

describe("billingLead", () => {
  it("keeps the statement of who bills and leaves the aside to the hover", () => {
    expect(billingLead(AGENT_NOTES.codex.billing)).toBe("Bills through your ChatGPT plan or OpenAI API key.");
    expect(billingLead(AGENT_NOTES["acp:cursor"].billing)).toBe(AGENT_NOTES["acp:cursor"].billing);
  });
});

describe("resolveModelName", () => {
  const rows = modelRows({ kind: "claude", model: null, canSwitchAgent: true,
    agentProbe: [probe("claude", null), probe("codex", codexCatalog), probe("acp:cursor", cursorWithClaude)] });
  const resolve = (name: string) => {
    const m = resolveModelName(name, rows);
    return m && { kind: m.kind, modelId: m.modelId, label: m.label, exact: m.exact };
  };

  it("maps a family name to its newest model, on the harness that would run it", () => {
    expect(resolve("Fable")).toEqual({ kind: "claude", modelId: "claude-fable-5-1", label: "Claude Fable 5.1", exact: false });
    expect(resolve("opus")).toMatchObject({ modelId: "claude-opus-5-5" });
  });

  it("takes the newest version even where the catalog lists an older one first", () => {
    // List order is the vendor's, and a live catalog promises nothing about it: "luna" is the newest
    // Luna, not whichever the probe happened to hand over first.
    const lunas = modelRows({ kind: "codex", model: null, canSwitchAgent: true, agentProbe: [probe("codex", [
      { id: "gpt-5.6-luna", label: "GPT-5.6-Luna" }, { id: "gpt-6-luna", label: "GPT-6-Luna" },
    ])] });
    expect(resolveModelName("luna", lunas)).toMatchObject({ modelId: "gpt-6-luna", exact: false });
  });

  it("treats a version as one word, so Fable 5 is never Fable 5.1", () => {
    expect(resolve("fable 5")).toMatchObject({ modelId: "claude-fable-5" });
    expect(resolve("Claude Fable 5.1")).toMatchObject({ modelId: "claude-fable-5-1", exact: true });
  });

  it("finds a model in a live catalog however it is spaced or hyphenated", () => {
    for (const name of ["GPT-6 Luna", "gpt 6 luna", "gpt6 luna", "GPT-6-Luna"]) {
      expect(resolve(name)).toEqual({ kind: "codex", modelId: "gpt-6-luna", label: "GPT-6-Luna", exact: true });
    }
  });

  it("takes the route a name asks for, and only where that harness runs the model", () => {
    expect(resolve("Fable via Cursor")).toMatchObject({ kind: "acp:cursor", modelId: CURSOR_FABLE_ID });
    expect(resolve("GPT-5.5 through Cursor")).toMatchObject({ kind: "acp:cursor", modelId: "gpt-5.5" });
    expect(resolve("Sonnet on Cursor")).toBeNull();
    expect(resolve("Fable on Claude Code")).toMatchObject({ kind: "claude", modelId: "claude-fable-5-1" });
  });

  it("names an agent's own default by the agent", () => {
    expect(resolve("opencode")).toMatchObject({ kind: "acp:opencode", modelId: null });
  });

  it("returns nothing rather than a different model", () => {
    // Codex's catalog unread: no GPT-6 Luna anywhere, so the answer is a question back to the person.
    const bare = modelRows({ kind: "claude", model: null, canSwitchAgent: true, agentProbe: [] });
    expect(resolveModelName("GPT-6 Luna", bare)).toBeNull();
    expect(resolveModelName("", rows)).toBeNull();
    // …and never one this session can no longer be put on.
    const locked = modelRows({ kind: "claude", model: null, canSwitchAgent: false, agentProbe: [probe("codex", codexCatalog)] });
    expect(resolveModelName("GPT-6 Luna", locked)).toBeNull();
  });
});
