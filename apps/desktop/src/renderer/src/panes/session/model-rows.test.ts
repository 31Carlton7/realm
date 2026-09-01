import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_LABEL } from "@realm/contracts";
import { filterRows, modelRows, railKinds } from "./model-rows";
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
