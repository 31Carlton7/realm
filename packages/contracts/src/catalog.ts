import { canonicalModelKey } from "./models";

/**
 * What a model COSTS and how big it is — the two facts a picker cannot honestly guess, fetched from
 * a public catalog rather than hardcoded.
 *
 * Realm's own model lists come from the harnesses (a live ACP catalog, Codex's `model/list`, or the
 * curated `AGENT_MODELS`), and not one of those channels carries a price, a context window, or the
 * reasoning efforts a model accepts. A CLI has no reason to tell a client what its vendor charges.
 * So the picker either says nothing about cost — which is what it did, leaving "Fable 5.1 or GPT-5.6
 * Luna?" as a question with no visible answer — or it reads a catalog that does carry those numbers.
 *
 * OpenRouter's `/api/v1/models` is that catalog: **public, unauthenticated**, ~425 models across 45
 * vendors, each with per-token prices, a context length and (for reasoning models) the effort levels
 * it accepts. Verified live 2026-09-03: `200`, no key, no CORS games — the server fetches it.
 *
 * Two consequences worth being explicit about, because both bound what this data may be used for:
 *
 * 1. **These are API LIST prices, not the user's bill.** Claude Code bills through a Claude
 *    subscription and Cursor through a Cursor plan; a session run there costs the user nothing extra
 *    per token. The picker therefore always shows the price NEXT TO the harness's `AGENT_NOTES.billing`
 *    line, never alone, and never as a total.
 * 2. **A model missing from the catalog is normal, not an error.** Cursor's Composer and every
 *    harness's "Default" row have no OpenRouter entry at all. Those rows simply show no price. A
 *    picker that hid them, or invented a number, would be worse than one that admits the gap.
 */
export type ModelInfo = {
  /** `canonicalModelKey` of the vendor-stripped name — the same key `ModelRow` uses, which is the
   *  whole reason this can be joined onto rows built from a completely different source. */
  key: string;
  /** The catalog's own name with the vendor prefix removed: "Anthropic: Claude Fable 5.1" → "Claude
   *  Fable 5.1". Never displayed in place of a row's own label; kept for debugging the join. */
  label: string;
  /** The vendor the catalog attributed it to ("Anthropic"), or "" when the name carried no prefix. */
  vendor: string;
  /** USD per MILLION input tokens — converted here, once, so no caller multiplies by 1e6 itself.
   *  `0` is a real answer (free tiers exist); `null` means the catalog quoted no price. */
  priceIn: number | null;
  /** USD per million output tokens. Output is the number that dominates an agent's bill. */
  priceOut: number | null;
  /** Context window in tokens, or null when the catalog omits it. */
  context: number | null;
  /** Reasoning effort levels this model accepts, in the catalog's own order; `[]` for a model with
   *  no reasoning axis at all. Realm shows its own EFFORT_LEVELS regardless — this is what tells the
   *  user whether the level they pick is one the model has. */
  efforts: string[];
  /** The first sentence of the catalog's description, or null. Marketing prose, so it is only ever
   *  the FALLBACK: `MODEL_NOTES` wins wherever Realm has written its own line. */
  blurb: string | null;
};

/** The public catalog. No key, no headers, no attribution required for a plain GET. */
export const MODEL_CATALOG_URL = "https://openrouter.ai/api/v1/models";
/** `settings` row holding the cached catalog: `{ fetchedAt, rows }`. Generic table, so no migration. */
export const MODEL_CATALOG_KEY = "models.catalog";
/** How stale a cached catalog may be before a refresh is attempted. A day: prices move on the scale
 *  of model launches, and a picker that hit the network every time it opened would be a worse trade
 *  than one showing yesterday's cent-accurate number. A failed refresh keeps serving the cache. */
export const MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** Catalog prices are strings ("0.00001"), and a few rows quote `"0"`. Both are numbers; anything
 *  unparseable is `null` rather than 0 — free and unknown are different claims. */
const perMillion = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n * 1_000_000 : null;
};

/**
 * Split "Anthropic: Claude Fable 5.1" into its vendor and the model's own name.
 *
 * The prefix has to go before the name is folded to a key, or every OpenRouter row would key on a
 * token no harness's name carries and NOTHING would join. Only the first ": " splits, and only when
 * both halves are non-empty — a name that is all vendor, or one with no prefix at all ("Composer"),
 * passes through whole.
 */
export function splitVendor(name: string): { vendor: string; label: string } {
  const i = name.indexOf(": ");
  if (i <= 0) return { vendor: "", label: name };
  const label = name.slice(i + 2).trim();
  return label ? { vendor: name.slice(0, i).trim(), label } : { vendor: "", label: name };
}

/**
 * Normalize a catalog response into `ModelInfo` rows, keyed for joining onto the picker's models.
 *
 * Three filters, each removing rows that would otherwise STEAL a key from the model they are a
 * variant of — the failure mode is not a missing row but a wrong price on a real one:
 *
 * - **Variant ids are dropped** (`anthropic/claude-opus-5:batch`, `z-ai/glm-5.2:free`). Same model,
 *   different billing; the batch row's half-price would land on the interactive row's key.
 * - **Non-text models are dropped** (image, embedding, video). `architecture.output_modalities` says
 *   so; a row that cannot answer a prompt is not a row this picker can offer.
 * - **First entry per key wins.** The catalog is ordered newest-first, and where two rows still fold
 *   to one key after the above, the newer one is the one a harness is likely to be running.
 *
 * Anything malformed is skipped rather than repaired: a row with no id or no name cannot be joined,
 * and a half-parsed price is the one kind of wrong this file must never produce.
 */
export function parseModelCatalog(raw: unknown): ModelInfo[] {
  const data = asObj(raw).data;
  if (!Array.isArray(data)) return [];
  const byKey = new Map<string, ModelInfo>();
  for (const entry of data) {
    const m = asObj(entry);
    const id = typeof m.id === "string" ? m.id : null;
    const name = typeof m.name === "string" ? m.name : null;
    if (!id || !name || id.includes(":")) continue;
    const arch = asObj(m.architecture);
    const outputs = Array.isArray(arch.output_modalities) ? arch.output_modalities : null;
    if (outputs && !outputs.includes("text")) continue;
    const { vendor, label } = splitVendor(name);
    const key = canonicalModelKey(label);
    if (byKey.has(key)) continue;
    const pricing = asObj(m.pricing);
    const reasoning = asObj(m.reasoning);
    const efforts = Array.isArray(reasoning.supported_efforts)
      ? reasoning.supported_efforts.filter((e): e is string => typeof e === "string") : [];
    byKey.set(key, {
      key, label, vendor,
      priceIn: perMillion(pricing.prompt), priceOut: perMillion(pricing.completion),
      context: typeof m.context_length === "number" ? m.context_length : null,
      efforts,
      blurb: firstSentence(typeof m.description === "string" ? m.description : ""),
    });
  }
  return [...byKey.values()];
}

/**
 * The first sentence of a catalog description, or null.
 *
 * Catalog descriptions run to paragraphs of vendor prose; the picker has room for a line. Cutting at
 * the first `. ` keeps a whole grammatical sentence rather than an ellipsis mid-clause — and a
 * sentence still longer than 200 characters is dropped entirely, because at that length it is a
 * marketing run-on that would push the price off the panel.
 */
export function firstSentence(text: string): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return null;
  const end = t.search(/\.\s/);
  const s = end > 0 ? t.slice(0, end + 1) : t;
  return s.length > 200 ? null : s;
}

/** `$10`, `$0.66`, `$0.07` — never more than two decimals, never a trailing `.00`. Sub-cent prices
 *  are real (DeepSeek V4 Flash is $0.065/Mtok in) and round UP to `$0.07` rather than to `$0.06`,
 *  so a printed price is never lower than the one the vendor charges. */
export function formatPrice(usdPerMillion: number): string {
  if (usdPerMillion === 0) return "free";
  if (usdPerMillion < 1) return `$${(Math.ceil(usdPerMillion * 100) / 100).toFixed(2)}`;
  const r = Math.round(usdPerMillion * 100) / 100;
  return `$${Number.isInteger(r) ? r : r.toFixed(2)}`;
}

/** `1M`, `200K`, `128K` — the unit a context window is spoken in, never raw digits. */
export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m >= 10 || Number.isInteger(m) ? Math.round(m) : m.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}
