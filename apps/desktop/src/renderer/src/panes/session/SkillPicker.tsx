import { type Skill } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RefObject } from "react";
import { useAnchoredPopover } from "../../components/use-anchored-popover";

/**
 * Rank a skill against a query. Higher is better; `null` is "does not match at all".
 *
 * Substring, not fuzzy, for the same reason `filterMentionSkills` is: the picker's job is to NARROW a
 * list the user is reading, and a fuzzy match that surfaces `deslop` for "design" makes the list less
 * trustworthy, not more findable. What it adds over a flat `includes` is ORDER — a query that is the
 * start of a skill's id should not sit below one that appears mid-sentence in another's description.
 */
export function rankSkill(skill: Skill, q: string): number | null {
  const id = skill.id.toLowerCase();
  const name = skill.name.toLowerCase();
  const desc = skill.description.toLowerCase();
  // The unqualified tail (`agents.apple-design` → `apple-design`) is what the user thinks the skill is
  // called, so it is matched and ranked as if the prefix were not there.
  const tail = id.includes(".") ? id.slice(id.indexOf(".") + 1) : id;
  if (id === q || tail === q) return 100;
  if (tail.startsWith(q) || name.toLowerCase().startsWith(q)) return 80;
  if (id.includes(q) || name.includes(q)) return 60;
  if (desc.includes(q)) return 30;
  return null;
}

/**
 * Filter and order the picker's list.
 *
 * With no query the order is deliberate rather than alphabetical: what this space already has ON comes
 * first. The list spans every directory on the machine — around a hundred skills here — and a picker
 * that opens on `agents.animation-vocabulary` because the alphabet says so buries the two skills the
 * user actually works with. Within each of those two bands, ties fall back to id order so the list is
 * stable between renders.
 */
export function filterSkills(skills: readonly Skill[], query: string): Skill[] {
  const q = query.trim().toLowerCase();
  const usable = skills.filter((s) => s.valid);
  if (!q) {
    return [...usable].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.id.localeCompare(b.id));
  }
  return usable
    .map((s) => ({ s, r: rankSkill(s, q) }))
    .filter((x): x is { s: Skill; r: number } => x.r !== null)
    .sort((a, b) => b.r - a.r || Number(b.s.enabled) - Number(a.s.enabled) || a.s.id.localeCompare(b.s.id))
    .map((x) => x.s);
}

/** Group into the sections the list renders, in first-appearance order — so the ranking above decides
 *  which section leads, and the grouping never reorders a search result behind the user's back. */
export function groupSkills(skills: readonly Skill[]): Array<{ label: string; skills: Skill[] }> {
  const groups = new Map<string, { label: string; skills: Skill[] }>();
  for (const s of skills) {
    const label = s.origin.kind === "library" ? "Realm library" : s.origin.label;
    const g = groups.get(label) ?? { label, skills: [] };
    g.skills.push(s);
    groups.set(label, g);
  }
  return [...groups.values()];
}

/**
 * The "+ → Skills" surface: every skill on this machine, searchable, with this space's switch on each.
 *
 * This replaces priming the `@`-mention picker, which could only ever offer what was already enabled —
 * so the one list that could answer "what skills do I have" showed two of the hundred installed. The
 * two jobs the user came here for are one row each: the switch turns a skill on for this space (which
 * is what makes it reach the agent at all), and clicking the row inserts `@id` into the draft.
 *
 * Enabling is a real write to the space's preferences, not a per-message choice — the same switch the
 * settings panel shows, so the two surfaces can never claim different things about one skill.
 */
export function SkillPicker({ skills, anchorRef, onToggle, onMention, onClose, onManage }: {
  /** Every skill visible to this space, enabled or not, valid or not — the picker filters. */
  skills: readonly Skill[];
  anchorRef: RefObject<HTMLElement | null>;
  /** Turn one on or off for this space. */
  onToggle: (skill: Skill, enabled: boolean) => void;
  /** Insert `@id` into the draft. Only ever called for a skill that is on — an `@mention` of a
   *  disabled skill resolves to nothing at send, so the row enables first. */
  onMention: (skill: Skill) => void;
  onClose: () => void;
  /** Open the space's skills settings, for scan directories and the per-agent notes. */
  onManage: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const { pos } = useAnchoredPopover({ ref, anchorRef, placement: "up", onClose });

  const shown = useMemo(() => filterSkills(skills, query), [skills, query]);
  const groups = useMemo(() => groupSkills(shown), [shown]);
  const enabledCount = useMemo(() => skills.filter((s) => s.valid && s.enabled).length, [skills]);

  // Unlike the @-mention popover, focus DOES move here: the user opened a menu, not a word, so there
  // is no caret to protect and a search box that needs a second click to type in is a broken search box.
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { setActive(0); }, [query]);

  const pick = (s: Skill) => {
    if (!s.enabled) onToggle(s, true);
    onMention(s);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, shown.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const s = shown[active]; if (s) pick(s); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  // One flat counter across the groups, so ↑↓ walks the list the way it reads rather than restarting
  // at each header.
  let flat = -1;

  return createPortal(
    <div ref={ref} className="skill-picker" role="dialog" aria-label="Skills"
      style={{ position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999,
        visibility: pos ? "visible" : "hidden", transformOrigin: pos?.origin ?? "bottom left" }}
      onKeyDown={onKeyDown}>
      <div className="skill-picker-search">
        <Icon name="search" size={13} className="skill-picker-search-glyph" />
        <input ref={input} type="text" className="skill-picker-input" placeholder="Search skills…"
          aria-label="Search skills" role="combobox" aria-expanded aria-controls="skill-picker-list"
          value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="skill-picker-count">{enabledCount} on</span>
      </div>
      <div id="skill-picker-list" className="skill-picker-list" role="listbox" aria-label="Skills">
        {shown.length === 0 ? (
          <p className="skill-picker-empty">
            {skills.length === 0 ? "No skills found on this Mac yet." : `Nothing matches “${query}”.`}
          </p>
        ) : groups.map((g) => (
          <div key={g.label} className="skill-picker-group">
            <div className="skill-picker-group-label">{g.label}</div>
            {g.skills.map((s) => {
              flat += 1;
              const i = flat;
              return (
                <div key={s.id} role="option" aria-selected={i === active} data-active={i === active || undefined}
                  className="skill-picker-row" onMouseEnter={() => setActive(i)} onClick={() => pick(s)}>
                  <div className="skill-picker-row-main">
                    <span className="skill-picker-row-id">{s.id}</span>
                    <span className="skill-picker-row-desc">{s.description}</span>
                  </div>
                  {/* The switch must not also fire the row's insert — one click, one meaning. */}
                  <input type="checkbox" role="switch" className="switch" checked={s.enabled}
                    aria-label={`Skill ${s.name} in this space`}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onToggle(s, e.target.checked)} />
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <button type="button" className="skill-picker-manage" onClick={() => { onClose(); onManage(); }}>
        Manage skills &amp; folders…
      </button>
    </div>,
    document.body,
  );
}
