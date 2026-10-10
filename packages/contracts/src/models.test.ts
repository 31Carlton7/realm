import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS_KEY, MODEL_ALIASES, canonicalModelKey, fastSupportKey, offeredModel, readDefaultModels, readEffortSupport, readFastSupport, resolveDefaultModel } from "./models";

describe("the remembered fast-mode answers", () => {
  it("files the harness default under its own entry, apart from any named model", () => {
    // A session with no model asks for whatever the harness defaults to — a different question from
    // naming that model, and the only one answerable before it starts.
    expect(fastSupportKey("claude", null)).toBe("claude:");
    expect(fastSupportKey("claude", "claude-opus-5-5")).toBe("claude:claude-opus-5-5");
    expect(fastSupportKey("codex", "claude-opus-5-5")).not.toBe(fastSupportKey("claude", "claude-opus-5-5"));
  });

  it("keeps a `false` — it is an answer — and drops everything that is not one", () => {
    expect(readFastSupport({ "claude:": true, "codex:gpt": false, "x:y": "yes", "z:": null })).toEqual({ "claude:": true, "codex:gpt": false });
    for (const junk of [null, undefined, 3, "x", [true], []]) expect(readFastSupport(junk)).toEqual({});
  });
});

describe("the remembered reasoning levels", () => {
  it("keeps a list of levels — an empty one is an answer — and drops everything that is not one", () => {
    expect(readEffortSupport({ "claude:": ["low", "high"], "claude:claude-haiku-4-5": [], "x:y": "high", "z:": [1], "w:": null }))
      .toEqual({ "claude:": ["low", "high"], "claude:claude-haiku-4-5": [] });
    for (const junk of [null, undefined, 3, "x", [["low"]], []]) expect(readEffortSupport(junk)).toEqual({});
  });
});

const SONNET = "claude-sonnet-5";
const LUNA = "gpt-6-luna";
/** Codex's list as a probe reads it. Codex has no curated list, so this is all there is to check one
 *  of its models against. */
const codexLive = [{ id: LUNA }, { id: "gpt-6-astra" }];

describe("the models chosen for new sessions", () => {
  it("is stored under the key the Settings row has always written", () => {
    expect(DEFAULT_MODELS_KEY).toBe("sessions.defaultModels");
  });

  it("reads the row as a map from agent to model id", () => {
    expect(readDefaultModels({ claude: SONNET, codex: LUNA })).toEqual({ claude: SONNET, codex: LUNA });
  });

  it("drops an entry that is not a non-empty model id for a known agent", () => {
    expect(readDefaultModels({ claude: null, codex: "", nope: SONNET, "acp:cursor": 5, "acp:goose": "   ", fake: ["fake"] })).toEqual({});
  });

  it("reads a row that is not a map as no choice made", () => {
    for (const junk of [null, undefined, 3, SONNET, [SONNET], []]) expect(readDefaultModels(junk)).toEqual({});
  });

  it("offers a model the agent's live list carries, and passes over one it does not", () => {
    expect(offeredModel("codex", LUNA, codexLive)).toBe(LUNA);
    expect(offeredModel("codex", "gpt-4-retired", codexLive)).toBeNull();
  });

  it("goes by the live list over the curated one where an agent has both", () => {
    expect(offeredModel("claude", "claude-sonnet-5-5", [{ id: "claude-sonnet-5-5" }])).toBe("claude-sonnet-5-5");
    expect(offeredModel("claude", SONNET, [{ id: "claude-opus-5-5" }])).toBeNull();
  });

  it("goes by the curated list where no live list is held, and an empty live list is none", () => {
    for (const live of [null, undefined, []]) {
      expect(offeredModel("claude", SONNET, live)).toBe(SONNET);
      expect(offeredModel("claude", "claude-retired-9", live)).toBeNull();
    }
  });

  it("lets a model stand for an agent with neither list", () => {
    for (const live of [null, undefined, []]) expect(offeredModel("codex", LUNA, live)).toBe(LUNA);
  });

  it("leaves the harness's own default as it is, whatever the lists carry", () => {
    expect(offeredModel("codex", null, codexLive)).toBeNull();
    expect(offeredModel("claude", null, null)).toBeNull();
  });

  it("resolves an agent's choice to the id stored for it, where the agent still offers it", () => {
    expect(resolveDefaultModel("codex", { claude: SONNET, codex: LUNA }, codexLive)).toBe(LUNA);
    expect(resolveDefaultModel("claude", { claude: SONNET, codex: LUNA }, null)).toBe(SONNET);
  });

  it("resolves a choice the agent no longer offers to none", () => {
    expect(resolveDefaultModel("codex", { codex: "gpt-4-retired" }, codexLive)).toBeNull();
    expect(resolveDefaultModel("claude", { claude: "claude-retired-9" }, null)).toBeNull();
  });

  it("resolves an agent with no choice of its own to none, whatever another agent has chosen", () => {
    expect(resolveDefaultModel("codex", { claude: SONNET }, null)).toBeNull();
    expect(resolveDefaultModel("codex", {}, codexLive)).toBeNull();
  });

  it("resolves a row that is not a map to none, even for an agent whose ids are never checked", () => {
    for (const junk of [null, LUNA, [LUNA], 7]) expect(resolveDefaultModel("codex", junk, null)).toBeNull();
  });
});

describe("canonicalModelKey", () => {
  it("folds the same model typed two ways into one key", () => {
    // Cursor's ACP catalog vs Realm's curated Claude list — the duplication the model-first list exists to remove.
    expect(canonicalModelKey("claude-fable-5.1")).toBe(canonicalModelKey("Claude Fable 5.1"));
    expect(canonicalModelKey("GPT-5.6-Sol")).toBe(canonicalModelKey("gpt-5.6-sol"));
  });

  it("folds a reordered qualifier", () => {
    // Cursor writes the version in the middle; Anthropic writes it last. Same model, same key.
    expect(canonicalModelKey("claude-4.5-sonnet")).toBe(canonicalModelKey("Claude Sonnet 4.5"));
  });

  it("folds a hyphenated version onto a dotted one — the live-catalog case", () => {
    // Labels taken verbatim from cursor-agent 2026.07.25's ACP catalog, which writes Anthropic
    // versions with hyphens and OpenAI/Google ones with dots IN THE SAME LIST. An earlier fixture
    // here invented pretty labels for Cursor, and the app shipped a duplicate "Claude Fable 5.1"
    // row until this was checked against a real probe.
    expect(canonicalModelKey("claude-fable-5-1")).toBe(canonicalModelKey("Claude Fable 5.1"));
    expect(canonicalModelKey("claude-haiku-4-5")).toBe(canonicalModelKey("Claude Haiku 4.5"));
    expect(canonicalModelKey("claude-sonnet-4-5")).toBe(canonicalModelKey("Claude Sonnet 4.5"));
  });

  it("still tells apart models the live catalog lists separately", () => {
    // The same probe carried all of these; folding any pair together would hide a real model.
    const live = ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5",
      "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4", "gpt-5.4", "gpt-5.4-mini",
      "gpt-5.4-nano", "gpt-5-mini", "gpt-5.1", "gpt-5.3-codex", "gemini-3.7-flash", "gemini-3-flash",
      "gemini-3.6-flash", "gemini-3.1-pro", "grok-4.6", "grok-4.5", "kimi-k3", "kimi-k2.7-code"];
    const keys = live.map(canonicalModelKey);
    expect(new Set(keys).size).toBe(live.length);
  });

  it("unifies every separator in a multi-part version", () => {
    // A consuming regex would fix the first separator and skip the second.
    expect(canonicalModelKey("model-1-2-3")).toBe(canonicalModelKey("Model 1.2.3"));
    expect(canonicalModelKey("model-1-2-3")).not.toBe(canonicalModelKey("Model 3.2.1"));
  });

  it("keeps a version dot, so a reversed version is NOT the same model", () => {
    // The regression that made this function tokenise on `[^a-z0-9.]` rather than `[^a-z0-9]`:
    // splitting the dot and then sorting made these two keys identical.
    expect(canonicalModelKey("Claude Fable 5.1")).not.toBe(canonicalModelKey("Claude Fable 1.5"));
    expect(canonicalModelKey("Claude Fable 5.1")).not.toBe(canonicalModelKey("Claude Fable 5"));
  });

  it("does not merge on a shared number alone", () => {
    expect(canonicalModelKey("Model 3")).not.toBe(canonicalModelKey("Model 30"));
  });

  it("applies MODEL_ALIASES to the residue no rule can fold", () => {
    // Cursor drops the vendor prefix on Anthropic models it proxies; nothing in the tokens relates
    // "sonnet-4.5" to "Claude Sonnet 4.5", so the table is the only way across.
    expect(canonicalModelKey("sonnet-4.5")).toBe(canonicalModelKey("Claude Sonnet 4.5"));
  });

  it("every alias entry is keyed by a normalised form and points at a real one", () => {
    // An entry keyed by a raw label would silently never fire — the lookup only ever sees folded keys.
    for (const [from, to] of Object.entries(MODEL_ALIASES)) {
      expect(from, `${from} is not in normalised form`).toBe(from.toLowerCase());
      expect(from).not.toBe(to);              // a self-alias is a typo, not a fold
      expect(MODEL_ALIASES[to]).toBeUndefined(); // no chains: one hop is all the lookup does
    }
  });
});
