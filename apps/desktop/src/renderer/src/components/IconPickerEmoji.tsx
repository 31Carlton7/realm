import { useMemo, useState } from "react";
import { EMOJI_GROUPS, searchEmoji } from "./emoji-search";

/**
 * The icon picker's Emoji tab, in its own module so its data is in its own chunk.
 *
 * `emoji-search.ts` pulls 387KB of `unicode-emoji-json` and 270KB of `emojilib`, and builds its
 * index over all ~1,900 entries at module scope. Imported from IconPicker directly, both files are
 * parsed and walked during startup — before the window paints — on behalf of a tab most users never
 * open. Behind a `lazy()` boundary the whole cost moves to the first time someone asks for emoji.
 */

/** How many matches the grid draws. Rendering 1,900 buttons is slower than the search that narrows
 *  them, and nobody scrolls that far — the search box is the way to the rest. Now that a search is
 *  RANKED, this is a cut off the bottom of a sorted list rather than off an arbitrary one: what a
 *  query most likely meant is in the first screenful, not somewhere past the cap. */
const MAX_SHOWN = 400;

export default function IconPickerEmoji({ icon, query, onPick }: {
  icon: string; query: string; onPick: (icon: string) => void;
}) {
  // The chosen category lives here rather than in the popover: it means nothing to the other three
  // tabs, and it must not survive this chunk being unmounted and the tab reopened fresh.
  const [group, setGroup] = useState<string | null>(null);
  const rows = useMemo(() => searchEmoji(query, group), [query, group]);
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
        {rows.slice(0, MAX_SHOWN).map(({ char, entry }) => (
          <button key={char} type="button" role="radio" aria-checked={icon === `emoji:${char}`} aria-label={entry.name}
            title={entry.name} className="icon-choice ip-emoji" data-selected={icon === `emoji:${char}` || undefined}
            onClick={() => onPick(`emoji:${char}`)}>{char}</button>
        ))}
        {rows.length === 0 && <p className="ip-empty">No emoji match “{query.trim()}”.</p>}
      </div>
    </>
  );
}
