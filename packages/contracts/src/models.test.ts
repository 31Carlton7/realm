import { describe, expect, it } from "vitest";
import { MODEL_ALIASES, canonicalModelKey } from "./models";

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

  it("keeps a version dot, so a reversed version is NOT the same model", () => {
    // The regression that made this function tokenise on `[^a-z0-9.]` rather than `[^a-z0-9]`:
    // splitting the dot and then sorting made these two keys identical.
    expect(canonicalModelKey("Claude Fable 5.1")).not.toBe(canonicalModelKey("Claude Fable 1.5"));
    expect(canonicalModelKey("Claude Fable 5.1")).not.toBe(canonicalModelKey("Claude Fable 5"));
  });

  it("keeps genuinely different models apart", () => {
    const keys = ["Claude Opus 5", "Claude Sonnet 5", "Claude Haiku 4.5", "GPT-5.6", "Gemini 3.7 Flash", "Cursor Grok 4.5"]
      .map(canonicalModelKey);
    expect(new Set(keys).size).toBe(keys.length);
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
