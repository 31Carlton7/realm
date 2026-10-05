import { Icon } from "@realm/ui";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { TIP_DELAY_MS, TIP_WARM_MS } from "../../tooltips";
import { currentPrompt, savedNear, tickPositions, TICK_PITCH, type TrackPrompt } from "./scroll-track";
import { stampLabel } from "./timestamps";

type TrackProps = {
  /** The transcript's scroller. Its only child is the column the prompts' rows are in. */
  scrollRef: RefObject<HTMLDivElement | null>;
  prompts: readonly TrackPrompt[];
  /** Bring the log to `top`, as the reader's own scroll would — at once when `instant`. Must be stable. */
  onJump: (top: number, instant?: boolean) => void;
  /** The reader's day, for how the card's time is said (timestamps.ts). */
  now: number;
  /** Save a turn, or unsave it: the card's bookmark, and S on the track. Absent where nothing can be
   *  saved, which draws no bookmark rather than one that does nothing. Must be stable. */
  onSave?: (seq: number, saved: boolean) => void;
  /** A prompt to go to once the track has it, as a pulse: a saved turn opened from the Library. */
  reveal?: { seq: number; n: number } | null;
  /** The pulse is spent. */
  onRevealed?: (n: number) => void;
};

/** Where the rows are, in the log's own coordinates, and how much room the track has to show them. */
type Geometry = { offsets: number[]; inset: number; room: number };

/** How far the lens reaches either side of the tick under the pointer, in ticks. */
const LENS = 3;
/** The card's distance from the edges of the log it floats over. */
const CARD_MARGIN = 8;
/** Below this pitch a 2px line touches the next one. */
const DENSE_PITCH = 4;
/** How long the card waits for a pointer that has left the track on its way to the card's bookmark:
 *  ten pixels of gap cross in a fraction of this, and a pointer gone for good is gone in no more. */
const CARD_GRACE_MS = 200;

/** Each prompt's row, measured where it is LAID OUT, never where it is painted: a log that has just
 *  loaded is mid-entrance, every row risen 6px by a transform, and the rubber band translates the
 *  column at an end — a rect read then puts every tick, and every jump, off by that much. Offsets are
 *  taken against the column, so the scroller's own position cancels out of them. */
function measure(el: HTMLElement, track: HTMLElement, prompts: readonly TrackPrompt[]): Geometry | null {
  const col = el.firstElementChild;
  if (!(col instanceof HTMLElement)) return null;
  const rows = new Map<string, HTMLElement>();
  for (const row of col.children) { const key = row.getAttribute("data-prompt"); if (key !== null && row instanceof HTMLElement) rows.set(key, row); }
  const inset = parseFloat(getComputedStyle(el).paddingTop) || 0;
  const offsets: number[] = [];
  for (const p of prompts) {
    const row = rows.get(p.key);
    if (!row) return null;
    // A row's offset parent is the column only if the column is positioned; otherwise they share one.
    offsets.push(inset + row.offsetTop - (row.offsetParent === col ? 0 : col.offsetTop));
  }
  return { offsets, inset, room: track.clientHeight };
}

const sameGeometry = (a: Geometry | null, b: Geometry): boolean =>
  !!a && a.inset === b.inset && a.room === b.room && a.offsets.length === b.offsets.length
  && a.offsets.every((y, i) => Math.abs(y - b.offsets[i]!) < 0.5);

const plural = (n: number) => (n === 1 ? "1 file" : `${n} files`);

/**
 * The scroll track: a tick down the log's left edge for every prompt in it, placed by where the prompt
 * sits in the scrollback, the one being read longer and darker. Pointing at a tick says what was asked,
 * how the answer opened and when; a click goes there, and so do ↑ and ↓ once the track has the keyboard.
 *
 * Outside the scroller, for the selection bar's reason: `.transcript` carries the edge dissolve, and a
 * mask applies to everything its element paints. It lays out from the rows themselves — one read pass,
 * batched to a frame, whenever the log or the pane changes size — so the length of a session costs a
 * measurement, not a listener per tick.
 */
export const ScrollTrack = memo(function ScrollTrack(props: TrackProps) {
  // One prompt has nowhere to go but where it already is.
  return props.prompts.length < 2 ? null : <Track {...props} />;
});

function Track({ scrollRef, prompts, onJump, now, onSave, reveal = null, onRevealed }: TrackProps) {
  const ref = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const cardId = useId();
  const [geom, setGeom] = useState<Geometry | null>(null);
  /* The prompt being read — null until the log has settled where it opens. The track lays out before
     the transcript does (a child's layout effects run first), so a reading taken in the same commit is
     of a log not yet stuck to its end, and would light the first tick for a frame on the way. */
  const [current, setCurrent] = useState<number | null>(null);
  /** The tick under the pointer: the lens follows it at once, the card after the tooltip's delay. */
  const [hover, setHover] = useState<number | null>(null);
  const [shown, setShown] = useState(false);
  /** The tick with the keyboard, which shows its card until Escape puts it away. */
  const [focus, setFocus] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  /* The prompt a jump went to, held as the current one until the reader scrolls for themselves. A
     prompt near the end cannot be brought up to the reading line — the log runs out first — and the
     tick that lights after a click has to be the one that was clicked. */
  const pinned = useRef<number | null>(null);
  const live = useRef({ prompts, geom });
  live.current = { prompts, geom };

  /* Every read happens in one frame: a resize, a reflow and a burst of scroll events all land as one
     measurement, and nothing is written to the DOM between the reads. */
  const frame = useRef(0);
  const owed = useRef(true);
  /** The geometry, measured again if a measurement is owed. Null while there is nothing to read. */
  const remeasure = useCallback((): Geometry | null => {
    const el = scrollRef.current, track = ref.current;
    // A pane in a hidden tab lays nothing out; its geometry waits for it to be shown.
    if (!el || !track || el.clientHeight === 0) return null;
    const g = live.current.geom;
    if (!owed.current && g) return g;
    const next = measure(el, track, live.current.prompts);
    owed.current = next === null;
    if (!next || sameGeometry(g, next)) return g;
    live.current.geom = next;
    setGeom(next);
    return next;
  }, [scrollRef]);
  const read = useCallback(() => {
    frame.current = 0;
    const el = scrollRef.current, g = remeasure();
    if (!el || !g) return;
    setCurrent(pinned.current ?? currentPrompt(g.offsets, { top: el.scrollTop, height: el.clientHeight, scrollHeight: el.scrollHeight, inset: g.inset }));
  }, [scrollRef, remeasure]);
  const schedule = useCallback((again: boolean) => {
    if (again) owed.current = true;
    if (!frame.current) frame.current = requestAnimationFrame(read);
  }, [read]);

  useLayoutEffect(() => {
    const el = scrollRef.current, track = ref.current;
    if (!el || !track) return;
    // The column growing (a streamed answer, a picture landing), the pane resizing, and the track's own
    // room changing are the three things that move a tick.
    const ro = new ResizeObserver(() => schedule(true));
    ro.observe(el);
    ro.observe(track);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    const spy = () => schedule(false);
    // The reader taking the scroller back is what ends a jump's hold on the current tick.
    const unpin = () => { if (pinned.current !== null) { pinned.current = null; schedule(false); } };
    el.addEventListener("scroll", spy, { passive: true });
    el.addEventListener("wheel", unpin, { passive: true });
    el.addEventListener("pointerdown", unpin);
    el.addEventListener("keydown", unpin);
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", spy);
      el.removeEventListener("wheel", unpin);
      el.removeEventListener("pointerdown", unpin);
      el.removeEventListener("keydown", unpin);
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [scrollRef, schedule]);

  /* A prompt arriving moves every tick, so it is measured before the frame paints rather than one
     frame late — and the jump it follows is over: sending is the reader choosing where to be. Where
     the reader IS waits for the next frame, once the transcript has put the log where it goes. */
  const keys = prompts.map((p) => p.key).join(" ");
  useLayoutEffect(() => {
    pinned.current = null;
    owed.current = true;
    remeasure();
    schedule(false);
  }, [keys, remeasure, schedule]);

  const positions = useMemo(() => (geom ? tickPositions(geom.offsets, geom.room) : null), [geom]);
  /* Each tick answers the pointer across the whole cell between it and its neighbours, so a pointer
     anywhere in the band is on the nearest prompt and a dense track has no dead pixels. The band is
     centred in the room the track has. */
  const cells = useMemo(() => {
    if (!geom || !positions) return null;
    const lift = Math.round((geom.room - positions.at(-1)!) / 2);
    return positions.map((y, i) => {
      const above = i === 0 ? TICK_PITCH / 2 : (y - positions[i - 1]!) / 2;
      const below = i === positions.length - 1 ? TICK_PITCH / 2 : (positions[i + 1]! - y) / 2;
      return { top: lift + y - above, height: above + below, line: above };
    });
  }, [geom, positions]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const going = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warmUntil = useRef(0);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (going.current) clearTimeout(going.current);
  }, []);
  /* The tooltip's timing (tooltips.ts): the card a fifth of a second after the pointer arrives, and at
     once for the next tick, or for a pointer back on the track within the grace period. */
  const enter = useCallback((i: number) => {
    setHover(i);
    if (shownRef.current || timer.current) return;
    const show = () => { timer.current = null; setShown(true); };
    if (performance.now() < warmUntil.current) show();
    else timer.current = setTimeout(show, TIP_DELAY_MS);
  }, []);
  const leave = useCallback(() => {
    going.current = null;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (shownRef.current) warmUntil.current = performance.now() + TIP_WARM_MS;
    setHover(null);
    setShown(false);
  }, []);
  /* The card holds a control, so a pointer leaving the track may only be crossing to it: an open card
     waits for it, and arriving on the card or back on a tick keeps it. One that never opened goes. */
  const leaving = useCallback(() => {
    if (going.current) clearTimeout(going.current);
    if (shownRef.current) going.current = setTimeout(leave, CARD_GRACE_MS); else leave();
  }, [leave]);
  const staying = useCallback(() => { if (going.current) { clearTimeout(going.current); going.current = null; } }, []);

  const jump = useCallback((i: number, instant = false) => {
    const g = live.current.geom;
    if (!g || g.offsets[i] === undefined) return;
    pinned.current = i;
    setCurrent(i);
    // The row comes to rest where the first message of a fresh log does: at the log's top padding.
    onJump(g.offsets[i]! - g.inset, instant);
  }, [onJump]);
  const focusTick = useCallback((i: number) => { setFocus(i); setDismissed(false); }, []);
  /** Save the turn at `i`, or unsave it — whichever it is not. A prompt with no stored event has
   *  nothing a saved turn could name, and is left alone. */
  const save = useCallback((i: number) => {
    const p = live.current.prompts[i];
    if (p && p.seq !== null) onSave?.(p.seq, !p.saved);
  }, [onSave]);

  /* A saved turn opened from the Library: gone to as soon as its row is laid out, and at once — the
     pane has just come forward, and a long glide up from the log's end would be the window making the
     reader wait for what they already asked for. A passive effect, so it lands after the transcript's
     own first paint has put the log at its end. */
  useEffect(() => {
    if (!reveal || !geom) return;
    const i = prompts.findIndex((p) => p.seq === reveal.seq);
    if (i < 0 || geom.offsets[i] === undefined) return;
    jump(i, true);
    onRevealed?.(reveal.n);
  }, [reveal, geom, prompts, jump, onRevealed]);

  const n = cells?.length ?? 0;
  const onKeyDown = (e: KeyboardEvent) => {
    if (n === 0) return;
    const from = focus ?? current ?? 0;
    // S saves the turn the keyboard is on, or unsaves it: the card's bookmark, for a hand on the keys.
    if (e.key.toLowerCase() === "s" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (onSave) { e.preventDefault(); save(from); }
      return;
    }
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    // ⌥↑ and ⌥↓ go to the saved turn before or after, past every turn that is not one.
    const near = step !== 0 && e.altKey ? savedNear(prompts, from, step) : null;
    const to = step !== 0 ? (e.altKey ? (near !== null && near < n ? near : null) : Math.min(n - 1, Math.max(0, from + step)))
      : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (step !== 0) e.preventDefault();
    if (to === null) {
      // Escape puts the card away and nothing else: the keyboard stays on the track — on the tick, if
      // it was on the card's bookmark, which is about to go with the card.
      if (e.key === "Escape" && focus !== null && !dismissed) {
        e.stopPropagation();
        setDismissed(true);
        if (cardRef.current?.contains(document.activeElement)) ref.current?.querySelectorAll<HTMLElement>(".track-tick")[focus]?.focus();
      }
      return;
    }
    e.preventDefault();
    ref.current?.querySelectorAll<HTMLElement>(".track-tick")[to]?.focus();
    jump(to);
  };

  const lens = hover ?? (focus !== null && !dismissed ? focus : null);
  const open = hover !== null ? (shown ? hover : null) : lens;
  // The card keeps what it last said while it fades, rather than emptying under the reader.
  const said = useRef(0);
  if (open !== null) said.current = open;
  const card = prompts[Math.min(said.current, prompts.length - 1)]!;

  /* Centred on its tick, and kept inside the log it floats over. Placed before paint, from the card's
     own height, which depends on how much the answer had to say. */
  useLayoutEffect(() => {
    const el = cardRef.current, track = ref.current, cell = open === null ? null : cells?.[open];
    if (!el || !track || !cell) return;
    const room = (track.offsetParent as HTMLElement | null)?.clientHeight ?? 0;
    const h = el.offsetHeight, y = cell.top + cell.line;
    const lowest = room - track.offsetTop - h - CARD_MARGIN;
    el.style.top = `${Math.round(Math.max(CARD_MARGIN - track.offsetTop, Math.min(lowest, y - h / 2)))}px`;
  }, [open, cells, card]);

  const rove = Math.min(focus ?? current ?? 0, n - 1);
  // Too many prompts for the room to space them a few pixels apart: the lines thin, so a log of
  // hundreds still reads as ticks rather than as one solid bar.
  const dense = n > 1 && geom !== null && geom.room / (n - 1) < DENSE_PITCH;
  // What a tick's card says beyond its name, for the keyboard: the answer, then when and what changed.
  const described = `${cardId}-reply ${cardId}-foot`;
  return (
    <div ref={ref} className="scroll-track" role="toolbar" aria-orientation="vertical" aria-label="Prompts" data-dense={dense || undefined}
      onKeyDown={onKeyDown} onPointerLeave={leaving} onPointerEnter={staying}
      onBlur={(e) => { if (!ref.current?.contains(e.relatedTarget as Node | null)) setFocus(null); }}>
      {cells?.map((cell, i) => {
        const p = prompts[i];
        if (!p) return null;
        const d = lens === null ? null : Math.abs(i - lens);
        return <Tick key={p.key} index={i} title={p.title} top={cell.top} height={cell.height} line={cell.line}
          current={i === current} near={d !== null && d <= LENS ? d : null} edited={p.edited > 0} saved={p.saved} focusable={i === rove}
          describedBy={open === i ? described : undefined} onEnter={enter} onPick={jump} onFocusTick={focusTick} />;
      })}
      <div ref={cardRef} className="track-card" data-open={open !== null || undefined}>
        <div className="track-card-head">
          <span className="track-card-title">{card.title}</span>
          {/* Codex's place for it, and the one control the card holds: the next stop after its tick while
              the card is up, and S on the track from the keys. */}
          {onSave && card.seq !== null && (
            <button type="button" className="track-card-save" aria-label="Save turn" aria-pressed={card.saved}
              title={card.saved ? "Unsave this turn" : "Save this turn"}
              onMouseDown={(e) => e.preventDefault()} onClick={() => save(said.current)}>
              <Icon name="saved" size={14} />
            </button>
          )}
        </div>
        <p className="track-card-reply" id={`${cardId}-reply`} hidden={!card.reply}>{card.reply}</p>
        <p className="track-card-foot" id={`${cardId}-foot`}>
          <time dateTime={new Date(card.ts).toISOString()}>{stampLabel(card.ts, now)}</time>
          {[card.from && `Asked by ${card.from}`, card.edited > 0 && `Edited ${plural(card.edited)}`].filter(Boolean).map((part) => ` · ${part}`).join("")}
        </p>
      </div>
    </div>
  );
}

/** One prompt's tick: a cell the pointer and the keyboard can land on, with its line drawn inside. */
const Tick = memo(function Tick({ index, title, top, height, line, current, near, edited, saved, focusable, describedBy, onEnter, onPick, onFocusTick }: {
  index: number; title: string; top: number; height: number; line: number;
  current: boolean; near: number | null; edited: boolean; saved: boolean; focusable: boolean; describedBy: string | undefined;
  onEnter: (i: number) => void; onPick: (i: number) => void; onFocusTick: (i: number) => void;
}) {
  return (
    <button type="button" className="track-tick" style={{ top, height }} tabIndex={focusable ? 0 : -1}
      aria-label={title} aria-current={current || undefined} aria-describedby={describedBy} aria-description={saved ? "Saved" : undefined}
      data-current={current || undefined} data-near={near ?? undefined} data-edited={edited || undefined} data-saved={saved || undefined}
      onPointerEnter={() => onEnter(index)}
      // A tick is a place to go, like a scrollbar's track: it takes the click and leaves the keyboard
      // where it was, in the prompter, for the next thing the reader types.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(index)} onFocus={() => onFocusTick(index)}>
      <span className="track-line" style={{ top: line }} />
    </button>
  );
});
