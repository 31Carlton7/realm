import { describe, expect, it } from "vitest";
import type { AgentKind } from "@realm/contracts";
import { delegableModels, modelMenu, resolveModelName, type ProbedAgent } from "./models";

/**
 * The model resolver, against a catalog shaped like a real Mac's: Claude on its curated list (its
 * CLI has no enumeration channel), Codex and Cursor on live catalogs, Cursor's labelled with its
 * own raw ids the way cursor-agent reports them, and an ACP harness that is not installed.
 *
 * Each `it` names the mutant it exists to kill — a rule that no test can fail is a rule nobody can
 * be sure still holds.
 */

const CODEX_MODELS = [
  { id: "gpt-6-luna", label: "GPT-6 Luna" }, { id: "gpt-6-astra", label: "GPT-6 Astra" },
  { id: "gpt-6-astra-pro", label: "GPT-6 Astra Pro" }, { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
];
const CURSOR_MODELS = [
  { id: "claude-fable-5-1", label: "claude-fable-5-1" }, { id: "gpt-5.3-codex[reasoning=medium,fast=false]", label: "gpt-5.3-codex" },
  { id: "composer", label: "Composer" }, { id: "composer-2", label: "Composer 2" }, { id: "grok-4.6", label: "grok-4.6" },
];

function probes(over: Partial<Record<AgentKind, Partial<ProbedAgent>>> = {}): ProbedAgent[] {
  const base: ProbedAgent[] = [
    { kind: "claude", available: true, loggedIn: true, reason: null, models: null },
    { kind: "codex", available: true, loggedIn: true, reason: null, models: CODEX_MODELS },
    { kind: "acp:cursor", available: true, loggedIn: true, reason: null, models: CURSOR_MODELS },
    { kind: "acp:grok", available: false, loggedIn: null, reason: "grok not found on PATH", models: null },
  ];
  return base.map((p) => ({ ...p, ...over[p.kind] }));
}
const KINDS: AgentKind[] = ["claude", "codex", "acp:cursor", "acp:grok"];

function resolve(name: string, opts: { kind?: AgentKind; probes?: ProbedAgent[] } = {}) {
  const rows = opts.probes ?? probes();
  return resolveModelName(name, delegableModels(rows, KINDS), { kind: opts.kind, kinds: KINDS, probes: rows });
}
const choice = (name: string, opts?: { kind?: AgentKind; probes?: ProbedAgent[] }) => {
  const r = resolve(name, opts);
  if (!r.ok) throw new Error(`expected "${name}" to resolve, got: ${r.message}`);
  return r.choice;
};
const refusal = (name: string, opts?: { kind?: AgentKind; probes?: ProbedAgent[] }) => {
  const r = resolve(name, opts);
  if (r.ok) throw new Error(`expected "${name}" to be refused, got ${r.choice.kind} ${r.choice.model}`);
  return r.message;
};

describe("a model's name picks the harness that runs it", () => {
  it("GPT-6 Luna is Codex, by its name or by its id", () => {
    expect(choice("GPT-6 Luna")).toEqual({ kind: "codex", model: "gpt-6-luna", label: "GPT-6 Luna" });
    expect(choice("gpt-6-luna")).toEqual({ kind: "codex", model: "gpt-6-luna", label: "GPT-6 Luna" });
  });

  it("an Anthropic id written with hyphens is the model its name is (claude-opus-5-5 = Claude Opus 5.5)", () => {
    expect(choice("claude-opus-5-5")).toMatchObject({ kind: "claude", model: "claude-opus-5-5" });
    expect(choice("Opus 5.5")).toMatchObject({ kind: "claude", model: "claude-opus-5-5", label: "Claude Opus 5.5" });
  });

  it("filler around a name is not part of it — 'use the GPT-6 Luna model'", () => {
    // Mutant: stop dropping FILLER, and "use", "the" and "model" become words no model has.
    expect(choice("use the GPT-6 Luna model").model).toBe("gpt-6-luna");
  });

  it("an ACP id's parameter suffix is a setting, not part of the name", () => {
    expect(choice("gpt-5.3-codex")).toMatchObject({ kind: "acp:cursor", model: "gpt-5.3-codex[reasoning=medium,fast=false]" });
    // Two settings of one model, labelled with their raw ids: one model to a person, not two names
    // to choose between. Mutant: keep the suffix — "reasoning", "high" and "medium" become words of
    // two different names, and the plain name is ambiguous between them.
    const rows = probes({ "acp:cursor": { models: [
      { id: "gpt-5.3-codex[reasoning=medium]", label: "gpt-5.3-codex[reasoning=medium]" },
      { id: "gpt-5.3-codex[reasoning=high]", label: "gpt-5.3-codex[reasoning=high]" }] } });
    expect(choice("gpt-5.3-codex", { probes: rows })).toEqual({ kind: "acp:cursor", model: "gpt-5.3-codex[reasoning=medium]", label: "gpt-5.3-codex" });
  });
});

describe("a family name means its newest member", () => {
  it("Fable is the newest Fable, on Claude's own CLI rather than through Cursor", () => {
    // Two mutants: newest-first reversed (→ Fable 5), and harness order lost (→ Cursor's route).
    expect(choice("Fable")).toEqual({ kind: "claude", model: "claude-fable-5-1", label: "Claude Fable 5.1" });
  });

  it("Opus is Opus 5.5; Opus 5 is exactly Opus 5", () => {
    expect(choice("Opus").model).toBe("claude-opus-5-5");
    // Mutant: drop the exact-name preference — then "Opus 5" is just another Opus and the newest wins.
    expect(choice("Opus 5").model).toBe("claude-opus-5");
    expect(choice("Claude Opus 5").model).toBe("claude-opus-5");
  });

  it("…but a name that IS a model's whole name means that model, not a newer sibling", () => {
    // Cursor lists both "Composer" and "Composer 2". Mutant: drop the exact-name preference — they
    // are then one family two versions apart, and the newer one answers to the older one's name.
    expect(choice("Composer")).toMatchObject({ kind: "acp:cursor", model: "composer" });
    expect(choice("Composer 2")).toMatchObject({ kind: "acp:cursor", model: "composer-2" });
  });

  it("Sonnet and Haiku each name their one model", () => {
    expect(choice("Sonnet").model).toBe("claude-sonnet-5");
    expect(choice("haiku").model).toBe("claude-haiku-4-5");
  });

  it("Luna is the newest Luna across versions — GPT-6 over GPT-5.6", () => {
    expect(choice("Luna").model).toBe("gpt-6-luna");
  });

  it("the fewest words left unsaid wins: Astra is GPT-6 Astra, not GPT-6 Astra Pro", () => {
    // Mutant: drop the `unsaid` narrowing — Astra and Astra Pro are then two families, and ambiguous.
    expect(choice("Astra").model).toBe("gpt-6-astra");
    expect(choice("Astra Pro").model).toBe("gpt-6-astra-pro");
  });
});

describe("a name that could mean two models is a question", () => {
  it("GPT-6 could be Astra or Luna, and the refusal names both", () => {
    const m = refusal("GPT-6");
    expect(m).toContain('"GPT-6" could mean');
    expect(m).toContain("GPT-6 Astra (Codex)");
    expect(m).toContain("GPT-6 Luna (Codex)");
    expect(m).not.toContain("Astra Pro");
  });

  it("GPT alone spans every family Codex has", () => {
    expect(refusal("GPT")).toMatch(/could mean .*GPT-5\.6 Sol/);
  });
});

describe("a harness named on its own runs its default", () => {
  it("Codex, Cursor and Claude each resolve to their harness with no pinned model", () => {
    expect(choice("Codex")).toEqual({ kind: "codex", model: null, label: "GPT-5.6" });
    expect(choice("Cursor")).toEqual({ kind: "acp:cursor", model: null, label: "Composer" });
    // "Claude" is ALSO a word in every Claude model's name; as the whole name it is the harness.
    expect(choice("Claude")).toMatchObject({ kind: "claude", model: null });
  });

  it("a model whose name contains a harness word is still the model — GPT-5.3-Codex is not Codex", () => {
    expect(choice("GPT-5.3-Codex").kind).toBe("acp:cursor");
  });

  it("a harness that is not installed hands its name to a model that is: Grok is Cursor's Grok 4.6", () => {
    expect(choice("Grok")).toMatchObject({ kind: "acp:cursor", model: "grok-4.6" });
  });

  it("and says why when nothing else answers to it", () => {
    const rows = probes({ "acp:cursor": { models: CURSOR_MODELS.filter((m) => !m.id.startsWith("grok")) } });
    expect(refusal("Grok", { probes: rows })).toContain("Grok is not installed on this Mac (grok not found on PATH)");
  });
});

describe("a route word picks the route", () => {
  it("Fable through Cursor runs Fable on Cursor", () => {
    expect(choice("Fable through Cursor")).toMatchObject({ kind: "acp:cursor", model: "claude-fable-5-1", label: "Claude Fable 5.1" });
    expect(choice("Claude Fable 5.1 via Cursor").kind).toBe("acp:cursor");
  });

  it("an explicit agentKind narrows the lookup to that harness", () => {
    expect(choice("Fable", { kind: "acp:cursor" })).toMatchObject({ kind: "acp:cursor", model: "claude-fable-5-1" });
  });

  it("…and refuses a model that harness does not offer, saying where it does run", () => {
    // Mutant: fall back to the global lookup — the caller's agentKind would be silently overridden.
    const m = refusal("Fable", { kind: "codex" });
    expect(m).toContain('Codex has no model called "Fable"');
    expect(m).toMatch(/runs on Claude or Cursor/);
  });

  it("a harness word that contradicts agentKind is refused", () => {
    expect(refusal("Codex", { kind: "claude" })).toContain("constraints.agentKind asks for Claude");
  });
});

describe("readiness", () => {
  it("prefers a route that is ready: with Claude signed out, Fable goes through Cursor", () => {
    // Mutant: `pickRoute` takes routes[0] — a child on a signed-out CLI fails on its first message.
    const rows = probes({ claude: { loggedIn: false, reason: "run claude login" } });
    expect(choice("Fable", { probes: rows })).toMatchObject({ kind: "acp:cursor", model: "claude-fable-5-1" });
  });

  it("refuses a model whose only harness cannot run, in the probe's own words", () => {
    const rows = probes({ codex: { loggedIn: false, reason: "Run `codex login`." } });
    expect(refusal("GPT-6 Luna", { probes: rows })).toBe(
      "refused: GPT-6 Luna runs on Codex, which is not signed in on this Mac (Run `codex login`.). Pick a model on an agent that is ready, or leave constraints.model out to use your own.");
  });

  it("an agent nobody has probed yet is not held against it", () => {
    const rows = probes().filter((p) => p.kind !== "claude");
    expect(choice("Sonnet", { probes: rows })).toMatchObject({ kind: "claude", model: "claude-sonnet-5" });
  });
});

describe("an unknown name is refused with the names that would work", () => {
  it("lists every harness's models, ready ones first", () => {
    const m = refusal("GPT-7");
    expect(m).toContain('no model called "GPT-7"');
    expect(m).toContain("- Claude: Claude Fable 5.1, Claude Fable 5, Claude Opus 5.5");
    expect(m).toContain("- Codex: GPT-6 Luna, GPT-6 Astra");
    expect(m).toContain("- Cursor: gpt-5.3-codex, Composer, Composer 2, grok-4.6");
  });

  it("points at a near miss without picking it — 5.6 is not 6", () => {
    const m = refusal("GPT-5 Luna");
    expect(m).toContain("Did you mean GPT-6 Luna or GPT-5.6 Luna?");
  });

  it("refuses a name that is all filler", () => {
    expect(refusal("the model")).toContain('"the model" names no model');
  });
});

describe("the catalog", () => {
  it("is one entry per model, keeping the better of two names and every route", () => {
    const models = delegableModels(probes(), KINDS);
    const fable = models.filter((m) => m.key === "5.1-claude-fable");
    expect(fable).toHaveLength(1);
    expect(fable[0]!.label).toBe("Claude Fable 5.1");
    expect(fable[0]!.routes.map((r) => r.kind)).toEqual(["claude", "acp:cursor"]);
  });

  it("takes a written name over an id from whichever harness reports one, even a later one", () => {
    // Cursor reports Grok by its bare id and comes first; Grok's own CLI names it. Mutant: keep the
    // first label — the menu and every report would say "grok-4.6" where a name exists.
    const rows = probes({ "acp:grok": { available: true, loggedIn: true, reason: null, models: [{ id: "grok-4.6", label: "Grok 4.6" }] } });
    const grok = delegableModels(rows, KINDS).find((m) => m.key === "4.6-grok")!;
    expect(grok.label).toBe("Grok 4.6");
    expect(grok.routes.map((r) => r.kind)).toEqual(["acp:cursor", "acp:grok"]);
  });

  it("lists a registered kind's static models when its probe reported none", () => {
    const models = delegableModels([], ["claude"]);
    expect(models.map((m) => m.id)).toContain("claude-opus-5-5");
  });

  it("the menu caps a long catalog and puts a harness that cannot run last", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `m-${i}`, label: `Model ${i}` }));
    const rows = probes({ "acp:cursor": { loggedIn: false, models: many } });
    const lines = modelMenu(delegableModels(rows, KINDS), { perHarness: 5 });
    expect(lines.at(-1)).toBe("Cursor (not ready): Model 0, Model 1, Model 2, Model 3, Model 4 and 25 more");
    expect(lines[0]!.startsWith("Claude: ")).toBe(true);
  });
});
