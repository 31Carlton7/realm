import {
  ACCESSORIES, BODIES, customize, EYES, Icon, MOUTHS, PALETTES, PATTERNS, randomSeed, Realmite, realmiteFromSeed, REALMITE_STATES,
  type RealmitePatch, type RealmiteSpec, type RealmiteState,
} from "@realm/ui";
import { useState, type KeyboardEvent } from "react";

type Part = "body" | "palette" | "eyes" | "mouth" | "accessory" | "pattern";

/** The pickers in the order a person builds a creature: its shape and colour, then its face, then
 *  what it wears. Each row is named by what it changes. */
const ROWS: { part: Part; name: string; options: [string, string][] }[] = [
  { part: "body", name: "Body", options: Object.entries(BODIES) },
  { part: "palette", name: "Colour", options: Object.entries(PALETTES).map(([id, p]) => [id, p.label]) },
  { part: "eyes", name: "Eyes", options: Object.entries(EYES) },
  { part: "mouth", name: "Mouth", options: Object.entries(MOUTHS) },
  { part: "accessory", name: "Wears", options: Object.entries(ACCESSORIES) },
  { part: "pattern", name: "Pattern", options: Object.entries(PATTERNS) },
];

const STATE_NAMES: Record<RealmiteState, string> = { idle: "Idle", working: "Working", "needs-you": "Needs you", sleeping: "Asleep" };

/**
 * Making a role's Realmite: the creature large, the four states it will be seen in, Shuffle, and a
 * row of choices per part. Every choice is drawn AS the creature with that part on, so a row is a
 * row of previews rather than a row of words, and picking one changes the big one in the same frame.
 *
 * Controlled: it holds no spec of its own, only the one shuffle that Undo takes back — a shuffle is
 * a single click away from losing a creature someone liked, and one step back is what that needs.
 */
export function RealmiteMaker({ spec, onChange, name }: { spec: RealmiteSpec; onChange: (next: RealmiteSpec) => void; name?: string }) {
  const [before, setBefore] = useState<RealmiteSpec | null>(null);
  const set = (patch: RealmitePatch) => {
    setBefore(null);
    onChange(customize(spec, patch));
  };
  const shuffle = () => {
    setBefore(spec);
    onChange(realmiteFromSeed(randomSeed()));
  };

  return (
    <div className="rmt-maker">
      <div className="rmt-maker-stage">
        <div className="rmt-maker-hero">
          <Realmite spec={spec} size={160} title={name ? `${name}'s Realmite` : "Realmite"} />
        </div>
        <ul className="rmt-maker-states" aria-label="How it looks in each state">
          {REALMITE_STATES.map((state) => (
            <li key={state}>
              <Realmite spec={spec} size={48} state={state} />
              <span>{STATE_NAMES[state]}</span>
            </li>
          ))}
        </ul>
        <div className="rmt-maker-actions">
          <button type="button" className="btn" onClick={shuffle} title="Roll a new Realmite">
            <Icon name="dice" size={14} />Shuffle
          </button>
          {before && (
            <button type="button" className="btn" onClick={() => { onChange(before); setBefore(null); }} title="Back to the Realmite before the shuffle">
              <Icon name="undo" size={14} />Undo
            </button>
          )}
        </div>
      </div>
      <div className="rmt-maker-parts">
        {ROWS.map((row) => (
          <PartRow key={row.part} spec={spec} row={row} onPick={(id) => set({ [row.part]: id })} />
        ))}
        <label className="rmt-maker-row rmt-maker-toggle">
          <span className="rmt-maker-name">Cheeks</span>
          <input type="checkbox" role="switch" className="switch" checked={spec.cheeks} onChange={(e) => set({ cheeks: e.target.checked })} />
        </label>
      </div>
    </div>
  );
}

function PartRow({ spec, row, onPick }: { spec: RealmiteSpec; row: (typeof ROWS)[number]; onPick: (id: string) => void }) {
  const current = spec[row.part];
  const ids = row.options.map(([id]) => id);
  /* One radio group, one tab stop: the arrows move the choice, as a native radio group's do. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = ids[(ids.indexOf(current) + step + ids.length) % ids.length]!;
    onPick(next);
    (e.currentTarget.querySelector(`[data-id="${next}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div className="rmt-maker-row">
      <span className="rmt-maker-name" id={`rmt-part-${row.part}`}>{row.name}</span>
      <div className="rmt-maker-options" role="radiogroup" aria-labelledby={`rmt-part-${row.part}`} onKeyDown={onKeyDown}>
        {row.options.map(([id, label]) => {
          const on = id === current;
          return (
            <button key={id} type="button" role="radio" aria-checked={on} aria-label={label} title={label} data-id={id}
              tabIndex={on ? 0 : -1} className="rmt-maker-option" onClick={() => onPick(id)}>
              <Realmite spec={customize(spec, { [row.part]: id })} size={32} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
