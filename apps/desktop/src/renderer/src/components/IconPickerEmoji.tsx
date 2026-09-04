import { useMemo, useState } from "react";
import emojiData from "unicode-emoji-json/data-by-emoji.json";

/**
 * The icon picker's Emoji tab, in its own module so its data is in its own chunk.
 *
 * `data-by-emoji.json` is 387KB and the two constants below walk all ~1,900 entries at module scope.
 * Imported from IconPicker directly, that JSON is parsed and walked during startup — before the
 * window paints — on behalf of a tab most users never open. Behind a `lazy()` boundary the whole
 * cost moves to the first time someone actually asks for emoji.
 */
type EmojiEntry = { name: string; slug: string; group: string; emoji_version: string; unicode_version: string; skin_tone_support: boolean };
const EMOJI: [string, EmojiEntry][] = Object.entries(emojiData as Record<string, EmojiEntry>);
/** First-appearance order, i.e. `unicode-emoji-json`'s own Unicode-recommended ordering — not sorted
 *  alphabetically, which would scatter e.g. all the flags across the alphabet by country name. */
const EMOJI_GROUPS: string[] = Array.from(new Set(EMOJI.map(([, e]) => e.group)));

/** How many matches the grid draws. Rendering 1,900 buttons is slower than the search that narrows
 *  them, and nobody scrolls that far — the search box is the way to the rest. */
const MAX_SHOWN = 400;

export default function IconPickerEmoji({ icon, query, onPick }: {
  icon: string; query: string; onPick: (icon: string) => void;
}) {
  // The chosen category lives here rather than in the popover: it means nothing to the other three
  // tabs, and it must not survive this chunk being unmounted and the tab reopened fresh.
  const [group, setGroup] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const rows = useMemo(() => EMOJI
    .filter(([, e]) => group === null || e.group === group)
    .filter(([, e]) => !q || e.name.includes(q) || e.slug.includes(q.replace(/\s+/g, "_"))), [q, group]);
  return (
    <>
      <div className="ip-emoji-groups" role="group" aria-label="Emoji category">
        <button type="button" className="ip-emoji-group-btn" aria-pressed={group === null} onClick={() => setGroup(null)}>All</button>
        {EMOJI_GROUPS.map((g) => (
          <button key={g} type="button" className="ip-emoji-group-btn" aria-pressed={group === g}
            onClick={() => setGroup(group === g ? null : g)}>{g}</button>
        ))}
      </div>
      <div className="ip-grid" role="radiogroup" aria-label="Emoji">
        {rows.slice(0, MAX_SHOWN).map(([char, e]) => (
          <button key={char} type="button" role="radio" aria-checked={icon === `emoji:${char}`} aria-label={e.name}
            title={e.name} className="icon-choice ip-emoji" data-selected={icon === `emoji:${char}` || undefined}
            onClick={() => onPick(`emoji:${char}`)}>{char}</button>
        ))}
        {rows.length === 0 && <p className="ip-empty">No emoji match “{query.trim()}”.</p>}
      </div>
    </>
  );
}
