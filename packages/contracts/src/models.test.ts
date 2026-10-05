import { describe, expect, it } from "vitest";
import { MODEL_ALIASES, canonicalModelKey, fastSupportKey, readFastSupport } from "./models";

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
