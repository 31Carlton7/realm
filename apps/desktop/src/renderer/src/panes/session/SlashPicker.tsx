import { Icon } from "@realm/ui";
import { useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPopover } from "../../components/use-anchored-popover";
import type { SlashCommand } from "./slash-commands";

/**
 * The prompter's `/`-command popover — the same surface, keys and anchoring as the `@`-mention
 * picker, because to the person typing they are one gesture with two sigils.
 *
 * Focus never moves in here for the same reason it never moves into the mention picker: the user is
 * mid-word in the textarea, so ↑↓/Enter/Tab/Esc arrive through the Composer's own keydown handler
 * and this surface only draws the state. A mouse pick goes through `onMouseDown` preventDefault so
 * the textarea keeps focus and the caret does not jump.
 */
export function SlashPicker({ commands, activeIndex, anchorRef, onPick, onHover, onClose }: {
  /** Already filtered by the current query, in the order shown. */
  commands: readonly SlashCommand[];
  activeIndex: number;
  anchorRef: RefObject<HTMLElement | null>;
  onPick: (command: SlashCommand) => void;
  onHover: (index: number) => void;
  /** Outside pointerdown / Escape (via the popover hook) — the Composer records the dismissal. */
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // No exit, matching the mention picker: this opens and closes between keystrokes, and a ghost of
  // it trailing the caret while the sentence carries on is noise rather than motion.
  const { pos } = useAnchoredPopover({ ref, anchorRef, placement: "up", onClose });
  const active = Math.min(activeIndex, commands.length - 1);
  return createPortal(
    <div ref={ref} id="slash-list" className="mention-picker slash-picker" role="listbox" aria-label="Commands"
      style={{ position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999,
        visibility: pos ? "visible" : "hidden", transformOrigin: pos?.origin ?? "bottom left" }}>
      {commands.map((c, i) => (
        <div key={c.id} id={`slash-${c.id}`} role="option" tabIndex={-1}
          className="mention-row slash-row" aria-selected={i === active} data-active={i === active || undefined}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => e.preventDefault() /* the textarea keeps focus; the caret must not move */}
          onClick={() => onPick(c)}>
          <Icon name={c.icon} size={12} className="slash-row-glyph" />
          <span className="mention-row-id">/{c.id}</span>
          <span className="mention-row-desc">{c.hint}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}
