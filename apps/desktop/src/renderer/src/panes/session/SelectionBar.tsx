import { Icon } from "@realm/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { placeBar, selectionTarget, type Placement } from "./selection-bar";

/** How long the copy control holds its ✓ — MessageActions' and Markdown's beat, so every copy in the
 *  transcript settles at the same pace. */
const COPIED_MS = 1400;

/** Measured once the bar is on screen. Placement needs the bar's own size before it can centre it,
 *  and these are only the first frame's guess: the layout effect below replaces them with what the
 *  element actually measures, so a font change or a longer label cannot leave the bar off-centre. */
const BAR_GUESS = { width: 168, height: 30 };

type Target = { text: string; range: Range };

/**
 * The bar that opens over a passage the reader has selected in the transcript.
 *
 * It exists because the alternative is retyping: a reader who wants to ask about one sentence of a
 * forty-line answer has to describe which sentence, and "the bit about the catch-up window" is both
 * slower to write and less exact than the sentence itself. Quoting makes the reference literal.
 *
 * **It offers two things and not five.** Quote, which nothing else in Realm can do, and Copy, which
 * is here precisely because it is the other thing anyone does with selected text — a bar that
 * appeared over a selection and refused the obvious half would read as having hijacked the gesture
 * rather than served it. What is deliberately absent is a button that SENDS: the question is the
 * user's to write, and a tool that guessed it would be answering something nobody asked.
 *
 * **It never handles the selection it is reading.** `onMouseDown` is prevented on the bar, so
 * pressing a button cannot collapse the range the button is about to act on — the one bug this kind
 * of control always has.
 */
export function SelectionBar({ scrollRef, wrapRef, onQuote }: {
  /** The scroller. Watched so the bar tracks its passage while the reader scrolls — it is positioned
   *  against the WRAPPER, which does not move, so without this it would hang in the pane while the
   *  text it points at slid away underneath. */
  scrollRef: RefObject<HTMLElement | null>;
  /** The positioning context: `.transcript-wrap`, outside the scroller so the transcript's edge
   *  dissolve cannot fade the bar — see `selection-bar.ts`, and the measurement that shows it. */
  wrapRef: RefObject<HTMLElement | null>;
  /** Put the passage in the prompter. Absent in the read-only mounts, which draw the button not at
   *  all rather than drawing a dead one — `onRate`'s rule, for `onRate`'s reason. */
  onQuote?: (text: string) => void;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const [at, setAt] = useState<Placement | null>(null);
  const [copied, setCopied] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const reposition = useCallback((range: Range) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const size = bar.current?.getBoundingClientRect() ?? BAR_GUESS;
    // Null is "the passage is not on screen" — the bar goes away and comes back when it scrolls
    // into view again. The TARGET is kept either way: the selection still exists, and the reader
    // scrolling back to it should find the bar where they left it.
    setAt(placeBar(range.getBoundingClientRect(), wrap.getBoundingClientRect(), size));
  }, [wrapRef]);

  /* `selectionchange` on the document rather than `mouseup` on the transcript: it is the one event
     that fires for every way a selection is made — drag, double-click, Shift+Arrow, ⌘A — and a
     keyboard reader who never touches a mouse gets the same bar as everyone else. */
  useEffect(() => {
    const read = () => {
      const found = selectionTarget(document.getSelection(), scrollRef.current);
      if (!found) { setTarget(null); setAt(null); return; }
      setTarget({ text: found.text, range: found.range });
      reposition(found.range);
    };
    document.addEventListener("selectionchange", read);
    return () => document.removeEventListener("selectionchange", read);
  }, [scrollRef, reposition]);

  /* The measured size replaces the guess on the frame the bar first paints. Layout, not effect: an
     ordinary effect would let the reader see one frame of the bar off-centre. */
  useLayoutEffect(() => { if (target) reposition(target.range); }, [target, reposition]);

  // Scrolling moves the passage, not the wrapper the bar is positioned in, so the bar has to follow.
  // Passive: this only reads geometry, and a non-passive listener on a scroller costs every frame.
  useEffect(() => {
    if (!target) return;
    const el = scrollRef.current;
    const follow = () => reposition(target.range);
    el?.addEventListener("scroll", follow, { passive: true });
    window.addEventListener("resize", follow);
    return () => { el?.removeEventListener("scroll", follow); window.removeEventListener("resize", follow); };
  }, [target, scrollRef, reposition]);

  // Escape dismisses without clearing the selection: the reader may have pressed it to get the bar
  // out of the way of the text underneath, and taking their selection with it would undo the drag
  // they just made.
  useEffect(() => {
    if (!target) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setTarget(null); setAt(null); } };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [target]);

  if (!target || !at) return null;

  const copy = () => {
    void navigator.clipboard.writeText(target.text);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  const quote = () => {
    onQuote?.(target.text);
    // The passage is in the prompter now and the bar has nothing left to offer about it. The
    // selection stays: it is what the reader is looking at while they type their question.
    setTarget(null);
    setAt(null);
  };

  return (
    <div ref={bar} className="selection-bar" role="toolbar" aria-label="Selected text"
      data-below={at.below || undefined} style={{ left: at.left, top: at.top }}
      // Without this the button steals focus on press, the selection collapses, and every handler
      // above reads an empty range.
      onMouseDown={(e) => e.preventDefault()}>
      {onQuote && (
        <button type="button" className="selection-action primary" onClick={quote}
          title="Put this passage in the prompter as a quote">
          <Icon name="quote" size={12} /> Quote
        </button>
      )}
      {/* `.icon-swap`, the named primitive — not a sixth hand-rolled copy of the same rule, which is
          the exact drift its own comment in styles.css records. Both glyphs stay mounted and
          cross-fade, and the accessible name never changes: a tick is a change of state, not of
          control. */}
      <button type="button" className="selection-action" onClick={copy} aria-label="Copy selection"
        title="Copy">
        <span className="icon-swap" data-on={copied || undefined}>
          <Icon name="copy" size={12} className="swap-off" />
          <Icon name="check" size={12} className="swap-on" />
        </span>
        Copy
      </button>
    </div>
  );
}
