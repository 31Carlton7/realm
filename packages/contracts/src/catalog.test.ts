import { describe, expect, it } from "vitest";
import { canonicalModelKey } from "./models";
import { firstSentence, formatContext, formatPrice, parseModelCatalog, splitVendor } from "./catalog";

/** Four rows copied verbatim from a live `GET https://openrouter.ai/api/v1/models` on 2026-09-03,
 *  trimmed to the fields the parser reads. Real shapes, real prices — a hand-written fixture would
 *  agree with the parser and with nothing else. */
const live = {
  data: [
    { id: "anthropic/claude-fable-5.1", name: "Anthropic: Claude Fable 5.1", context_length: 1_000_000,
      description: "Claude Fable 5.1 improves on Claude Fable 5 across the board. It is strong at agentic coding.",
      architecture: { output_modalities: ["text"] },
      pricing: { prompt: "0.00001", completion: "0.00005" },
      reasoning: { supported_efforts: ["max", "xhigh", "high", "medium", "low"] } },
    { id: "anthropic/claude-fable-5.1:batch", name: "Anthropic: Claude Fable 5.1 (batch)", context_length: 1_000_000,
      architecture: { output_modalities: ["text"] }, pricing: { prompt: "0.000005", completion: "0.000025" } },
    { id: "deepseek/deepseek-v4-flash-0731", name: "DeepSeek: DeepSeek V4 Flash 0731", context_length: 1_310_720,
      architecture: { output_modalities: ["text"] }, pricing: { prompt: "0.000000065", completion: "0.00000018" } },
    { id: "google/gemini-3-pro-image", name: "Google: Nano Banana Pro", context_length: 131_072,
      architecture: { output_modalities: ["image"] }, pricing: { prompt: "0.000002", completion: "0.000012" } },
  ],
};

describe("parseModelCatalog", () => {
  const rows = parseModelCatalog(live);

  it("keys rows the same way the picker keys its models, so the two can be joined", () => {
    // The whole reason a vendor prefix is stripped: `canonicalModelKey("Anthropic: Claude Fable 5.1")`
    // carries an "anthropic" token no harness's own name has, and nothing would ever match.
    expect(rows.map((r) => r.key)).toContain(canonicalModelKey("Claude Fable 5.1"));
    expect(rows.find((r) => r.label === "Claude Fable 5.1")?.vendor).toBe("Anthropic");
  });

  it("converts per-token prices to per-million, keeping sub-cent rates exact", () => {
    const flash = rows.find((r) => r.label === "DeepSeek V4 Flash 0731")!;
    expect(flash.priceIn).toBeCloseTo(0.065, 6);
    expect(flash.priceOut).toBeCloseTo(0.18, 6);
    expect(rows.find((r) => r.label === "Claude Fable 5.1")!.priceOut).toBe(50);
  });

  it("drops billing variants, which would otherwise steal the real model's key and halve its price", () => {
    expect(rows.filter((r) => r.key === canonicalModelKey("Claude Fable 5.1"))).toHaveLength(1);
    expect(rows.find((r) => r.key === canonicalModelKey("Claude Fable 5.1"))!.priceOut).toBe(50); // not the batch 25
  });

  it("drops models that cannot answer a prompt", () => {
    expect(rows.map((r) => r.label)).not.toContain("Nano Banana Pro");
  });

  it("carries the context window and the efforts the model actually accepts", () => {
    const fable = rows.find((r) => r.label === "Claude Fable 5.1")!;
    expect(fable.context).toBe(1_000_000);
    expect(fable.efforts).toEqual(["max", "xhigh", "high", "medium", "low"]);
    expect(rows.find((r) => r.label === "DeepSeek V4 Flash 0731")!.efforts).toEqual([]);
  });

  it("survives every shape a broken answer can take", () => {
    expect(parseModelCatalog(null)).toEqual([]);
    expect(parseModelCatalog({})).toEqual([]);
    expect(parseModelCatalog({ data: "nope" })).toEqual([]);
    // A row with no name cannot be joined onto anything, so it is skipped rather than half-parsed.
    expect(parseModelCatalog({ data: [{ id: "x/y" }, { name: "No id" }, 7] })).toEqual([]);
    // A price that is not a number is unknown, NOT free — those are different claims.
    const [row] = parseModelCatalog({ data: [{ id: "x/y", name: "X", pricing: { prompt: "n/a", completion: "0" } }] });
    expect(row!.priceIn).toBeNull();
    expect(row!.priceOut).toBe(0);
  });
});

describe("splitVendor", () => {
  it("splits on the first ': ' only, and leaves a name that has no prefix alone", () => {
    expect(splitVendor("Anthropic: Claude Fable 5.1")).toEqual({ vendor: "Anthropic", label: "Claude Fable 5.1" });
    expect(splitVendor("Composer")).toEqual({ vendor: "", label: "Composer" });
    expect(splitVendor("Z.ai: GLM 5.3: Turbo")).toEqual({ vendor: "Z.ai", label: "GLM 5.3: Turbo" });
    // All prefix and no model: splitting would leave nothing to key on, so it stays whole.
    expect(splitVendor("OpenAI: ")).toEqual({ vendor: "", label: "OpenAI: " });
  });
});

describe("formatting", () => {
  it("prints a price to at most two decimals, and never rounds one down", () => {
    expect(formatPrice(10)).toBe("$10");
    expect(formatPrice(1.5)).toBe("$1.50");
    expect(formatPrice(0.065)).toBe("$0.07"); // never $0.06 — a printed price is never under the real one
    expect(formatPrice(0)).toBe("free");
  });

  it("prints a context window in the unit it is spoken in", () => {
    expect(formatContext(1_000_000)).toBe("1M");
    expect(formatContext(1_310_720)).toBe("1.3M");
    expect(formatContext(200_000)).toBe("200K");
    expect(formatContext(512)).toBe("512");
  });

  it("takes one sentence of vendor prose, and none at all when there is no sentence in sight", () => {
    expect(firstSentence("First one. Second one.")).toBe("First one.");
    expect(firstSentence("  ")).toBeNull();
    expect(firstSentence("x".repeat(240))).toBeNull(); // a run-on would push the price off the panel
  });
});
