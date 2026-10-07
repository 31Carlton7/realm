import type { Skill } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { Fragment, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { RefObject } from "react";
import { useDissolve } from "../../components/ScrollFades";
import { useAnchoredPopover } from "../../components/use-anchored-popover";
import { useAutoHideScrollbar } from "../../components/use-auto-hide-scrollbar";
import { fileMark, type MentionRow } from "./mention-sources";

/**
 * The scroller inside a typed-into popover (this one and the `/` list), and what it owes the keyboard.
 *
 * The popover's box is the SURFACE — its fill, its corner, its shadow — and a mask on it would fade
 * the surface out along with the rows. So the rows scroll in a plain box inside it, and that box is
 * what dissolves. The highlight is moved by the textarea's arrows, so it is brought into view here,
 * clear of the band; a change the pointer made is left where it is, or hovering a row in the band
 * would scroll the list out from under the pointer.
 */
export function usePickerScroller(active: number) {
  const list = useRef<HTMLDivElement>(null);
  const hovered = useRef<number | null>(null);
  useAutoHideScrollbar(list);
  useDissolve(list);
  useEffect(() => {
    if (active === hovered.current) return;
    list.current?.querySelector<HTMLElement>("[data-active]")?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  return { list, hovered };
}

/** The characters a skill id may contain — must agree with contracts/mentions.ts, or the popover
 *  would offer a completion the send-time scan then refuses to recognise. */
const ID_CHAR = /[A-Za-z0-9._-]/;
/** What the QUERY after an `@` may contain: an id's characters, and a path's `/` — a file is found
 *  by `src/au` as often as by `auth`. What a pick inserts is always a whole token of its own, so a
 *  slash typed here never ends up inside one. */
const QUERY_CHAR = /[A-Za-z0-9._/-]/;

/**
 * The `@`-token governing the caret, if any: `start` is the `@`, `end` is one past the token's LAST
 * query character (which may extend beyond the caret — picking replaces the whole token, so a
 * completion in the middle of `@ma|c` never leaves a stray `c` behind), and `query` is what has been
 * typed between the `@` and the caret — the part the user is filtering by.
 *
 * Same token-initial rule as the send-time scan: the `@` must open the text or follow whitespace, so
 * a caret inside `user@mac` opens nothing. Null means no picker.
 */
export function mentionQueryAt(text: string, caret: number): { start: number; end: number; query: string } | null {
  let i = caret;
  while (i > 0 && QUERY_CHAR.test(text[i - 1]!)) i--;
  if (i === 0 || text[i - 1] !== "@") return null;
  const start = i - 1;
  if (start > 0 && !/\s/.test(text[start - 1]!)) return null; // an email address, not a mention
  let end = caret;
  while (end < text.length && QUERY_CHAR.test(text[end]!)) end++;
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

/** A row's DOM id — what the textarea's `aria-activedescendant` names. Whitespace is not allowed in
 *  an id, and a file's path may hold some. */
export const mentionOptionId = (key: string): string => `mention-${key.replace(/\s/g, "_")}`;

/** The mark at the head of a row: what KIND of thing it names, at a glance — an app's own icon, a
 *  file's type, a skill's spark, and for @Mac the Apple mark Realm already draws for this Mac. */
function RowMark({ row, appIcons }: { row: MentionRow; appIcons: Readonly<Record<string, string | null>> }) {
  if (row.kind === "app") {
    const src = appIcons[row.app.path];
    // A held 16px box while the icon is on its way, so the name beside it never shifts when it lands.
    return <span className="mention-row-mark" data-app="">{src ? <img src={src} alt="" width={16} height={16} draggable={false} /> : src === null ? <Icon name="pointer" size={14} /> : null}</span>;
  }
  const name = row.kind === "mac" ? "apple" : row.kind === "skill" ? "sparkles" : fileMark(row.path);
  return <span className="mention-row-mark"><Icon name={name} size={row.kind === "mac" ? 14 : 16} /></span>;
}

/**
 * The prompter's `@` popover: files, the Library, skills, apps and @Mac in one list (`mention-sources`
 * decides what is in it and in what order), anchored above the textarea on the same popover machinery
 * as the Menu and ModelPicker.
 *
 * Unlike those two, focus NEVER moves in here: the user is mid-word in the textarea, so ↑↓/Enter/Esc
 * arrive through the textarea's own keydown handler (Composer) and this surface only renders the
 * state. Mouse picks go through `onMouseDown` preventDefault so the textarea keeps focus. A group's
 * head is not a row: the arrows step over it, because only rows can be picked.
 */
export function MentionPicker({ rows, activeIndex, anchorRef, appIcons, onPick, onHover, onClose }: {
  /** Already ranked for the current query, in the order shown. */
  rows: readonly MentionRow[];
  activeIndex: number;
  anchorRef: RefObject<HTMLElement | null>;
  appIcons: Readonly<Record<string, string | null>>;
  onPick: (row: MentionRow) => void;
  onHover: (index: number) => void;
  /** Outside pointerdown / Escape (via the popover hook) — the Composer records the dismissal. */
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // No exit, because this one is driven by typing: it opens and closes between keystrokes, and a
  // ghost of it trailing the caret while the sentence carries on is noise rather than motion.
  const { pos } = useAnchoredPopover({ ref, anchorRef, placement: "up", onClose });
  const active = Math.min(activeIndex, rows.length - 1);
  const { list, hovered } = usePickerScroller(active);
  return createPortal(
    <div ref={ref} id="mention-list" className="mention-picker" role="listbox" aria-label="Mentions"
      style={{ position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999,
        visibility: pos ? "visible" : "hidden", transformOrigin: pos?.origin ?? "bottom left" }}>
      {/* `presentation`, so the options stay the listbox's own children to assistive tech. */}
      <div ref={list} className="mention-list" role="presentation">
        {rows.map((r, i) => (
          <Fragment key={r.key}>
            {r.head && <div className="mention-head" aria-hidden="true">{r.head}</div>}
            {/* An app row grants computer use when it is sent, so an agent driving Realm's own
                window may not click it: the user's pick is the consent, and only theirs counts. */}
            <div id={mentionOptionId(r.key)} role="option" tabIndex={-1}
              className="mention-row" data-kind={r.kind} aria-selected={i === active} data-active={i === active || undefined}
              data-no-agent={r.kind === "app" ? "computer use grant" : undefined}
              onMouseEnter={() => { hovered.current = i; onHover(i); }}
              onMouseDown={(e) => e.preventDefault() /* the textarea keeps focus; the caret must not move */}
              onClick={() => onPick(r)}>
              <RowMark row={r} appIcons={appIcons} />
              <span className="mention-row-name">{r.name}</span>
              {r.detail && <span className="mention-row-desc">{r.detail}</span>}
            </div>
          </Fragment>
        ))}
      </div>
    </div>,
    document.body,
  );
}
