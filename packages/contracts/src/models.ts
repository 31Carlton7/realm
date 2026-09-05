/**
 * Model IDENTITY across harnesses — the one thing that makes a model-first picker possible.
 *
 * Realm reaches the same model through more than one harness: Claude Fable 5.1 runs under the
 * `claude` CLI and under Cursor's ACP, and the two report it by different ids AND different names.
 * A picker that keys on the wire id therefore shows the model twice, once per harness, which is the
 * duplication the model-first design exists to remove. So rows key on a CANONICAL key derived from
 * the model's displayed name, and each row remembers the per-harness id it must actually transmit.
 *
 * Deriving identity from the display name rather than the id is deliberate, and it is the honest
 * choice rather than the lazy one: ids are namespaced per provider and carry ACP parameter suffixes
 * (`gpt-5.3-codex[reasoning=medium,fast=false]`), so no id-to-id mapping exists that isn't a
 * hand-maintained table. Names, by contrast, are what both vendors are trying to say out loud, and
 * they agree far more often than the ids do.
 */

/**
 * The `settings` row holding the user's starred models, as an array of canonical keys.
 *
 * Keys rather than model ids, and one flat list rather than a per-harness map, because a star is on a
 * MODEL: favouriting Fable 5.1 while a session runs it through Cursor should still light the row up
 * when a later session reaches it through the `claude` CLI. Lives in the generic `settings` table,
 * so this needed no migration and no RPC of its own.
 */
export const MODEL_FAVORITES_KEY = "models.favorites";

/**
 * Fold a model's displayed name to a comparison key.
 *
 * Four normalisations, each earning its place against a real disagreement seen in the wild:
 *
 * 1. **A version's separator is unified to a dot, and the version stays ONE token.** Cursor's live
 *    ACP catalog writes Anthropic versions with hyphens and everyone else's with dots — verified
 *    against cursor-agent 2026.07.25, which reported `claude-haiku-4-5` and `gpt-5.3-codex` in the
 *    same list — while Anthropic's own CLI says `Claude Haiku 4.5`. Without this, that model gets a
 *    row per harness, which is the exact duplication this key exists to remove.
 *
 *    Keeping it one token is what makes rule 3 safe: split into `4` and `5` and then sorted, `4.5`
 *    and `5.4` collapse into the same key, and a picker that folds Fable 5.1 into a Fable 1.5 row
 *    has hidden a model behind a different one.
 * 2. **Case and remaining punctuation go.** `claude-fable-5.1` and `Claude Fable 5.1` are the same
 *    model typed two ways.
 * 3. **Tokens sort.** Cursor says `claude-4.5-sonnet`; Anthropic says `Claude Sonnet 4.5`. Sorting
 *    the tokens makes word order stop mattering, which removes the largest single class of alias
 *    table entries — vendors reorder qualifiers constantly and agree on the words themselves.
 * 4. **`MODEL_ALIASES` gets the last word**, for the residue that no rule can fold.
 *
 * With versions kept whole, sorting can only over-merge names built from the SAME tokens in a
 * different order, and two models whose names are anagrams of each other are two names for one model
 * in every case observed.
 *
 * The key is never transmitted and never displayed — it exists to answer "are these the same model".
 */
export function canonicalModelKey(label: string): string {
  const tokens = label.toLowerCase()
    // Lookahead, not a consumed digit: `1-2-3` has to become `1.2.3`, and a consuming match would
    // skip past the `2` and leave the second separator alone.
    .replace(/(\d)[-_](?=\d)/g, "$1.")
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, "")) // a dot that bounds a token separated, it never versioned
    .filter(Boolean)
    .sort();
  const key = tokens.join("-");
  return MODEL_ALIASES[key] ?? key;
}

/**
 * Names that survive normalisation still disagreeing — folded by hand, keyed by the normalised form.
 *
 * Keep this SMALL and keep it evidenced. An entry here says "these two names, which no rule can
 * relate, are the same model"; a wrong entry silently hides a model behind another one's row, which
 * is worse than the duplicate row it was added to remove. Add one only after seeing both names in a
 * real catalog, and say where each came from.
 */
export const MODEL_ALIASES: Record<string, string> = {
  // Cursor's catalog abbreviates the vendor prefix off Anthropic models it proxies ("sonnet-4.5"),
  // where the Claude CLI's own list names the vendor ("Claude Sonnet 4.5"). Same model, and the
  // shorter name carries no token to sort against.
  "4.5-sonnet": "4.5-claude-sonnet",
  "4.5-haiku": "4.5-claude-haiku",
  "4.5-opus": "4.5-claude-opus",
};

/**
 * Realm's own one-line answer to "what is this model FOR", for the models a user is actually choosing
 * between — keyed, like everything else here, by canonical name.
 *
 * These override the catalog's `blurb`, which is the vendor's marketing first sentence and reads like
 * it ("delivering enhanced performance across complex workflows"). A line here is written to help
 * someone choose: it says what the model is better at than its neighbours in the list, and where it
 * is worth the money or worth the wait. Every claim is the vendor's own positioning of the model
 * against ITS OWN siblings, which is the one comparison a vendor has no incentive to get wrong.
 *
 * Keep this list SHORT and current. A blurb for a retired model is dead weight the fallback would
 * have covered anyway; a model with no entry loses nothing but a sharper sentence. Curated
 * 2026-09-03 against the live OpenRouter catalog.
 */
export const MODEL_NOTES: ReadonlyMap<string, string> = new Map(([
  ["Claude Fable 5.1", "Anthropic's newest — strongest here at long agentic runs, big refactors and front-end work."],
  ["Claude Fable 5", "The previous Fable. Same shape as 5.1 and usually a step behind it on agentic coding."],
  ["Claude Opus 5", "Deep reasoning over long horizons: end-to-end tasks, code review, bug hunts."],
  ["Claude Sonnet 5", "Frontier coding at a fifth of Fable's price — the sensible everyday default."],
  ["Claude Haiku 4.5", "Fastest Claude. For small edits, lookups and subagents, where latency beats depth."],
  ["GPT-6 Astra", "OpenAI's newest flagship: long-horizon work — end-to-end tasks, deep research, large refactors."],
  ["GPT-6 Astra Pro", "Astra with reasoning turned up. Slower and dearer; for the problems Astra alone stalls on."],
  ["GPT-5.6 Sol", "The previous OpenAI flagship, tuned for command-line and multi-step coding work."],
  ["GPT-5.6 Terra", "The balanced GPT-5.6 tier: everyday coding without Sol's output price."],
  ["GPT-5.6 Luna", "Cheap and fast, for high-volume or latency-sensitive work rather than hard problems."],
  ["GPT-5.3-Codex", "The Codex-tuned GPT — trained for the agent loop the `codex` CLI runs."],
  ["Gemini 3.1 Pro", "Google's frontier reasoning model; strong multimodal input and long-context work."],
  ["Gemini 3.8 Flash", "Google's fast tier, now good enough for real software engineering, at Flash prices."],
  ["Grok 4.6", "xAI's smartest: frontier coding and STEM, mid-tier pricing, 500K context."],
  ["Composer", "Cursor's own model, tuned for fast in-editor edits rather than long reasoning."],
  ["DeepSeek V4 Pro", "Near-frontier coding for roughly a fifteenth of Fable's price. Open weights."],
  ["DeepSeek V4 Flash", "Cheap enough to leave running on repetitive agent work all day; 1.3M context."],
  ["Kimi K3", "Open-weight multimodal reasoning at 2.8T parameters; strong on long agentic work."],
  ["GLM 5.3", "Built for long-horizon agent tasks and software engineering, at a fraction of frontier cost."],
  ["Qwen3 Max Thinking", "Qwen's deep-reasoning tier for multi-step problems rather than quick edits."],
  ["Devstral 2 2512", "Open-source and specialised in agentic coding; runs well behind your own keys."],
] as const).map(([name, note]) => [canonicalModelKey(name), note]));
