import type { Skill } from "@realm/contracts";
import { useRef } from "react";
import { createPortal } from "react-dom";
import type { RefObject } from "react";
import { useAnchoredPopover } from "../../components/use-anchored-popover";

/** The characters a skill id may contain — must agree with contracts/mentions.ts, or the popover
 *  would offer a completion the send-time scan then refuses to recognise. */
const ID_CHAR = /[A-Za-z0-9._-]/;

/**
 * The `@`-token governing the caret, if any: `start` is the `@`, `end` is one past the token's LAST
 * id character (which may extend beyond the caret — picking replaces the whole token, so a completion
 * in the middle of `@ma|c` never leaves a stray `c` behind), and `query` is what has been typed
 * between the `@` and the caret — the part the user is filtering by.
 *
 * Same token-initial rule as the send-time scan: the `@` must open the text or follow whitespace, so
 * a caret inside `user@mac` opens nothing. Null means no picker.
 */
export function mentionQueryAt(text: string, caret: number): { start: number; end: number; query: string } | null {
  let i = caret;
  while (i > 0 && ID_CHAR.test(text[i - 1]!)) i--;
  if (i === 0 || text[i - 1] !== "@") return null;
  const start = i - 1;
  if (start > 0 && !/\s/.test(text[start - 1]!)) return null; // an email address, not a mention
  let end = caret;
  while (end < text.length && ID_CHAR.test(text[end]!)) end++;
  return { start, end, query: text.slice(i, caret) };
}

/** Case-insensitive substring filter over id and display name — the same "filtered as you type"
 *  contract as the model picker's search, and nothing more: matching here only narrows the MENU;
 *  what resolves at send stays exact-match only. */
export function filterMentionSkills(skills: readonly Skill[], query: string): Skill[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...skills];
  return skills.filter((s) => s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
}

/**
 * The prompter's `@`-mention popover (Plan 8 W4): the session's space's enabled, valid skills — for
 * agents that support them; a Cursor session never renders this at all — anchored above the textarea
 * on the same popover machinery as the Menu and ModelPicker.
 *
 * Unlike those two, focus NEVER moves in here: the user is mid-word in the textarea, so ↑↓/Enter/Esc
 * arrive through the textarea's own keydown handler (Composer) and this surface only renders the
 * state. Mouse picks go through `onMouseDown` preventDefault so the textarea keeps focus.
 */
export function MentionPicker({ skills, activeIndex, anchorRef, onPick, onHover, onClose }: {
  /** Already filtered by the current query, in the order shown. */
  skills: readonly Skill[];
  activeIndex: number;
  anchorRef: RefObject<HTMLElement | null>;
  onPick: (skill: Skill) => void;
  onHover: (index: number) => void;
  /** Outside pointerdown / Escape (via the popover hook) — the Composer records the dismissal. */
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPopover({ ref, anchorRef, placement: "up", onClose });
  const active = Math.min(activeIndex, skills.length - 1);
  return createPortal(
    <div ref={ref} id="mention-list" className="mention-picker" role="listbox" aria-label="Skills"
      style={{ position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999,
        visibility: pos ? "visible" : "hidden", transformOrigin: pos?.origin ?? "bottom left" }}>
      {skills.map((s, i) => (
        <div key={s.id} id={`mention-${s.id}`} role="option" tabIndex={-1}
          className="mention-row" aria-selected={i === active} data-active={i === active || undefined}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => e.preventDefault() /* the textarea keeps focus; the caret must not move */}
          onClick={() => onPick(s)}>
          <span className="mention-row-id">@{s.id}</span>
          <span className="mention-row-desc">{s.name !== s.id ? `${s.name} — ${s.description}` : s.description}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}
