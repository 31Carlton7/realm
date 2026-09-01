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
 * Three normalisations, each earning its place against a real disagreement seen in the wild:
 *
 * 1. **Case and punctuation go — except a dot between digits.** `claude-fable-5.1` (Cursor's ACP
 *    catalog) and `Claude Fable 5.1` (Realm's curated Claude list) are the same model typed two ways.
 *    The dot in a VERSION survives because rule 2 would otherwise reverse it: split into `5` and `1`
 *    and then sorted, `5.1` and `1.5` become the same key, and a picker that folds Fable 5.1 into a
 *    Fable 1.5 row has hidden a model behind a different one.
 * 2. **Tokens sort.** Cursor says `claude-4.5-sonnet`; Anthropic says `Claude Sonnet 4.5`. Sorting
 *    the tokens makes word order stop mattering, which removes the largest single class of alias
 *    table entries — vendors reorder qualifiers constantly and agree on the words themselves.
 * 3. **`MODEL_ALIASES` gets the last word**, for the residue that no rule can fold.
 *
 * With versions kept whole, sorting can only over-merge names built from the SAME tokens in a
 * different order, and two models whose names are anagrams of each other are two names for one model
 * in every case observed.
 *
 * The key is never transmitted and never displayed — it exists to answer "are these the same model".
 */
export function canonicalModelKey(label: string): string {
  const tokens = label.toLowerCase()
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
