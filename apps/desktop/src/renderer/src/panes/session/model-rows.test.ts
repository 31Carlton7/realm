import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_LABEL, canonicalModelKey } from "@realm/contracts";
import { filterRows, modelIdOn, modelRows, railKinds, sortFavoritesFirst } from "./model-rows";
import type { AgentProbe } from "../../state/store";

const probe = (kind: AgentProbe["kind"], models: AgentProbe["models"]): AgentProbe =>
  ({ kind, available: true, version: "1", loggedIn: true, reason: null, models });

/** The catalog cursor-agent actually reported live: parameterized ids, `default[]` for Auto. */
const cursorCatalog = [
  { id: "default[]", label: "Auto" },
  { id: "composer-2.5[fast=true]", label: "composer-2.5" },
  { id: "gpt-5.3-codex[reasoning=medium,fast=false]", label: "gpt-5.3-codex" },
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

  it("transmits catalog ids verbatim — Auto keeps its real id, and nothing produces a literal \"auto\"", () => {
    const rows = modelRows({ kind: "acp:cursor", model: null, agentProbe: [probe("acp:cursor", cursorCatalog)], canSwitchAgent: true });
    expect(rows.find((r) => r.label === "Auto")?.modelId).toBe("default[]"); // the id set_model accepts
    expect(rows.some((r) => r.modelId === "auto")).toBe(false);              // the id it rejects
  });

  it("selects the catalog row whose id the session pins", () => {
    const rows = modelRows({ kind: "acp:cursor", model: "gpt-5.3-codex[reasoning=medium,fast=false]", agentProbe: [probe("acp:cursor", cursorCatalog)], canSwitchAgent: true });
    expect(rows.filter((r) => r.selected).map((r) => r.modelId)).toEqual(["gpt-5.3-codex[reasoning=medium,fast=false]"]);
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
      expect(claude.map((r) => r.modelId)).toEqual(["claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]);
      expect(claude[0]!.selected).toBe(true); // static lists pin first row = adapter default (presets.test.ts)
    }
  });

  it("a probe catalog for the session's own kind still yields exactly one selected row", () => {
    const codexCatalog = [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }, { id: "gpt-5.6-terra", label: "GPT-5.6-Terra" }];
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

  it("carries all 40 catalog rows plus the default row", () => {
    expect(rows.filter((r) => r.kind === "acp:cursor")).toHaveLength(41);
  });

  it("search still narrows by model name across the whole catalog", () => {
    expect(filterRows(rows, { query: "model 39", provider: null }).map((r) => r.label)).toEqual(["Model 39"]);
    expect(filterRows(rows, { query: "model 3", provider: null }).length).toBe(11); // 3, 30..39
  });

  it("the provider rail still narrows a large mixed list to one kind", () => {
    const cursorOnly = filterRows(rows, { query: "", provider: "acp:cursor" });
    expect(cursorOnly).toHaveLength(41);
    expect(new Set(cursorOnly.map((r) => r.kind))).toEqual(new Set(["acp:cursor"]));
    expect(railKinds(rows)).toContain("acp:cursor");
  });
});

/** Cursor proxies models other harnesses also run — the overlap the model-first list has to collapse. */
const cursorWithClaude = [
  { id: "default[]", label: "Auto" },
  { id: "claude-fable-5.1", label: "Claude Fable 5.1" }, // Claude's own list calls this claude-fable-5-1
  { id: "gpt-5.5", label: "GPT-5.5" },
];
const missing = (kind: AgentProbe["kind"]): AgentProbe =>
  ({ kind, available: false, version: null, loggedIn: null, reason: "not on PATH", models: null });
const fable = (rows: ReturnType<typeof modelRows>) => rows.filter((r) => r.label === "Claude Fable 5.1");

describe("one row per model, not per (harness, model)", () => {
  it("collapses a model two harnesses offer into a single row that remembers both ids", () => {
    const rows = modelRows({ kind: "claude", model: null, canSwitchAgent: true,
      agentProbe: [probe("claude", null), probe("acp:cursor", cursorWithClaude)] });
    expect(fable(rows)).toHaveLength(1); // pre-dedupe this was two rows, one per harness
    expect(fable(rows)[0]).toMatchObject({
      kind: "claude", harnesses: ["claude", "acp:cursor"],
      ids: { claude: "claude-fable-5-1", "acp:cursor": "claude-fable-5.1" },
    });
  });

  it("routes a merged row through the session's own harness, so picking it switches no agent", () => {
    const rows = modelRows({ kind: "acp:cursor", model: null, canSwitchAgent: true,
      agentProbe: [probe("claude", null), probe("acp:cursor", cursorWithClaude)] });
    // Same model, same two harnesses — but this session is on Cursor, so Cursor runs it.
    expect(fable(rows)[0]).toMatchObject({ kind: "acp:cursor", modelId: "claude-fable-5.1" });
  });

  it("keeps a model on the session's own harness even when that CLI is signed out", () => {
    // Availability is reported, never blocking (the install card is the fix, not a silent reroute).
    // Without the own-harness short-circuit this row would quietly move the session onto Cursor
    // because Cursor's probe is the happier one — switching the agent under a user who asked for
    // neither. The note still shows; the route does not change.
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
    // Declaration order still puts claude first, but it can't run anything — Cursor gets the model.
    expect(fable(rows)[0]).toMatchObject({ kind: "acp:cursor", modelId: "claude-fable-5.1" });
  });

  it("blocks a merged row once the session has run and its own harness can't reach the model", () => {
    const rows = modelRows({ kind: "codex", model: null, canSwitchAgent: false,
      agentProbe: [probe("codex", null), probe("claude", null), probe("acp:cursor", cursorWithClaude)] });
    expect(fable(rows)[0]!.blockedReason).toMatch(/already run/);
    expect(rows.filter((r) => r.kind === "codex").every((r) => r.blockedReason === null)).toBe(true);
  });

  it("still marks exactly one row selected once rows are deduped", () => {
    const rows = modelRows({ kind: "claude", model: "claude-fable-5-1", canSwitchAgent: true,
      agentProbe: [probe("claude", null), probe("acp:cursor", cursorWithClaude)] });
    expect(rows.filter((r) => r.selected).map((r) => r.label)).toEqual(["Claude Fable 5.1"]);
  });

  it("never merges two harnesses' adapter-default rows", () => {
    // "the Codex default" and "the Cursor default" are different models described the same way.
    const rows = modelRows({ kind: "codex", model: null, canSwitchAgent: true,
      agentProbe: [probe("codex", [{ id: "gpt-5.6", label: "GPT-5.6" }]), probe("acp:cursor", cursorWithClaude)] });
    const defaults = rows.filter((r) => r.key.startsWith("default:"));
    expect(defaults.map((r) => [r.kind, r.label])).toEqual([["codex", DEFAULT_MODEL_LABEL.codex], ["acp:cursor", DEFAULT_MODEL_LABEL["acp:cursor"]]]);
    expect(defaults.every((r) => r.harnesses.length === 1)).toBe(true);
  });
});

describe("modelIdOn", () => {
  const rows = modelRows({ kind: "claude", model: null, canSwitchAgent: true,
    agentProbe: [probe("claude", null), probe("acp:cursor", cursorWithClaude)] });

  it("hands back the id the target harness actually accepts", () => {
    // What the harness chip re-reads when it moves a chosen model onto another route.
    expect(modelIdOn(fable(rows)[0]!, "acp:cursor")).toBe("claude-fable-5.1");
    expect(modelIdOn(fable(rows)[0]!, "claude")).toBe("claude-fable-5-1");
  });

  it("says undefined — not null — for a harness that doesn't offer the model at all", () => {
    // null would read as "use that harness's default", which is a different answer from "can't".
    expect(modelIdOn(fable(rows)[0]!, "codex")).toBeUndefined();
  });
});

describe("favourites", () => {
  const withFavs = (favorites: string[]) => modelRows({ kind: "claude", model: null, canSwitchAgent: true,
    agentProbe: [probe("claude", null), probe("acp:cursor", cursorWithClaude)], favorites });

  it("stars a model by canonical key, whichever harness ends up running it", () => {
    const rows = withFavs([canonicalModelKey("Claude Fable 5.1")]);
    expect(rows.filter((r) => r.favorite).map((r) => r.label)).toEqual(["Claude Fable 5.1"]);
  });

  it("defaults to nothing starred", () => {
    expect(modelRows({ kind: "claude", model: null, agentProbe: [], canSwitchAgent: true }).some((r) => r.favorite)).toBe(false);
  });

  it("floats favourites to the top without disturbing either group's order", () => {
    const rows = withFavs([canonicalModelKey("GPT-5.5"), canonicalModelKey("Claude Sonnet 5")]);
    const sorted = sortFavoritesFirst(rows);
    expect(sorted.slice(0, 2).map((r) => r.label)).toEqual(["Claude Sonnet 5", "GPT-5.5"]); // row order, not favourites-array order
    expect(sorted.filter((r) => !r.favorite).map((r) => r.key)).toEqual(rows.filter((r) => !r.favorite).map((r) => r.key));
  });

  it("the favourites tab shows starred rows and nothing else", () => {
    const rows = withFavs([canonicalModelKey("GPT-5.5")]);
    expect(filterRows(rows, { query: "", provider: "favorites" }).map((r) => r.label)).toEqual(["GPT-5.5"]);
    expect(filterRows(rows, { query: "", provider: null }).length).toBe(rows.length);
  });
});

describe("the rail after dedupe", () => {
  const rows = modelRows({ kind: "claude", model: null, canSwitchAgent: true,
    agentProbe: [probe("claude", null), probe("acp:cursor", cursorWithClaude)] });

  it("a harness tab shows every model that harness can run, not just the ones routed to it", () => {
    // Fable resolved to the Claude CLI, but Cursor offers it too — hiding it under Cursor's tab
    // would tell the user Cursor can't run a model it just listed.
    const cursorTab = filterRows(rows, { query: "", provider: "acp:cursor" }).map((r) => r.label);
    expect(cursorTab).toContain("Claude Fable 5.1");
    expect(cursorTab).toContain("GPT-5.5");
    expect(cursorTab).not.toContain("Claude Sonnet 5"); // claude-only, and Cursor never offered it
  });

  it("lists every reachable harness, including ones no row resolved to", () => {
    expect(railKinds(rows)).toContain("acp:cursor");
    expect(railKinds(rows)).toContain("claude");
  });
});
