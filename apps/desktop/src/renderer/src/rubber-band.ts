/**
 * Rubber-banding for the app's own scrollers — what an NSScrollView does at its ends, and what
 * Chromium only ever does for the page body (Chromium 138 has no elastic overscroll for an inner
 * scroller, under any feature switch). Every surface in Realm scrolls inside a pane rather than as the
 * document, so without this nothing in the app gives at its edge.
 *
 * The content is moved with `translate` on the scroller's children (styles.css, `[data-rubber]`), never
 * by scrolling — a scroller cannot scroll past its own ends — and never on the scroller itself, whose
 * box, mask and scrollbar stay where they are, as a clip view's do.
 *
 * Three moments, and the trackpad phase stream (main/scroll-phase.ts) is what tells them apart:
 *  - fingers on the pad, pulling past an end: the content follows with rising resistance;
 *  - fingers lifted: it springs home;
 *  - a coast that reaches an end: it carries on past the end at the speed it arrived with, slows
 *    against the resistance and springs home — the bounce, which no amount of further momentum extends.
 * Without the helper (it is optional), a pause in the wheel stands in for the lift, and content that
 * arrives at an end already moving counts as a coast.
 */

/** Apple's rubber-band: the further past the end, the less the content follows. `dim` is the
 *  scroller's own height, so a short list gives a shorter stretch than a tall one. */
export function rubberband(over: number, dim: number, c = RESISTANCE): number {
  if (dim <= 0) return 0;
  return (over * dim * c) / (dim + c * Math.abs(over));
}

/** The curve's constant, and its slope at the end: the first pixel past the end moves the content c px. */
const RESISTANCE = 0.55;
/** The spring home, critically damped, in s⁻¹: a full stretch is back within half a second. */
export const OMEGA = 16;
/** Without the phase stream, how long the wheel must go quiet before the fingers count as lifted. */
export const IDLE_RELEASE_MS = 110;
/** After a lift, wheel deltas this soon are the coast, even before the stream has said "momentum". The
 *  stream and the wheel reach the renderer by different roads, and a coast that hits an end in its
 *  first frames must still bounce rather than stop dead. */
export const LIFT_GRACE_MS = 150;
/** The fastest arrival that is honoured, px/s. */
const MAX_SPEED = 12000;

export type Phase = { phase: string; momentum: string };

export interface RubberTarget {
  /** Content height of the viewport, for the resistance curve. */
  readonly clientHeight: number;
  readonly scrollTop: number;
  readonly scrollHeight: number;
}

/**
 * The state machine, with no DOM in it: `wheel` and `phase` are the inputs, `frame` advances a
 * spring, and `apply` is told the offset to draw. Driven by `installRubberBand` below; tested alone.
 *
 * Everything runs on the raw distance past the end and is drawn through `rubberband`, so a pull, a
 * release and a bounce share one curve, and a gesture can take hold of a spring from where it is.
 */
export class RubberBand<T extends RubberTarget> {
  private el: T | null = null;
  /** Raw distance past the end, before resistance. + is past the top, − past the bottom. */
  private over = 0;
  /** Its velocity while a spring runs, raw px/s. */
  private v = 0;
  private springing = false;
  private momentum = false;
  private phased = false;
  private liftedAt = -Infinity;
  /** This gesture's coast already bounced; the rest of it is spent. */
  private spent = false;
  /** The scroll's speed along y, px/s (the sign of the wheel's deltaY), smoothed over the last frames. */
  private speed = 0;
  private lastWheel = -Infinity;
  /** The previous delta of this wheel stream found the scroller already at the end it pushed toward. */
  private wasAtEnd = false;

  constructor(private readonly apply: (el: T, offset: number) => void) {}

  get active(): boolean { return this.el !== null; }
  /** The fingers are off the pad and the content may still be moving. */
  coasting(now: number): boolean { return this.momentum || now - this.liftedAt < LIFT_GRACE_MS; }

  /** A wheel delta over `el`, already known to be the scroller this gesture is about. */
  wheel(el: T, dy: number, now: number): void {
    const gap = now - this.lastWheel;
    const quiet = gap >= IDLE_RELEASE_MS;
    // Deltas arrive about once a frame; a coalesced or late one says so in its timestamp.
    const instant = dy / (quiet ? 1 / 60 : Math.min(Math.max(gap, 4), 50) / 1000);
    this.speed = quiet ? instant : (this.speed + instant) / 2;
    this.lastWheel = now;
    if (this.el && this.el !== el) this.settleNow();
    if (!this.phased && quiet) { this.spent = false; this.wasAtEnd = false; }

    const atTop = el.scrollTop <= 0;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    const atEnd = (dy < 0 && atTop) || (dy > 0 && atBottom);
    const arrivedMoving = !this.wasAtEnd && !quiet;
    this.wasAtEnd = atEnd;
    if (this.spent) return;

    // A coast, or (with no stream to say so) content that reached the end still moving: it carries on
    // past the end with the speed it arrived with, and everything after that is spent.
    const coast = this.phased ? this.coasting(now) : this.over === 0 && arrivedMoving;
    if (coast) {
      if (this.springing || !atEnd) return;
      this.el = el;
      this.over = 0;
      const speed = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, this.speed));
      // The curve's slope at the end is RESISTANCE, so this raw velocity draws as exactly the speed
      // the content had: no hitch at the edge, it decelerates from there.
      this.v = -speed / RESISTANCE;
      this.springing = true;
      this.spent = true;
      return;
    }

    // Fingers back on the pad mid-spring: take hold of the content where it is.
    if (this.springing && this.el === el) this.springing = false;
    if (!atEnd && this.over === 0) return;
    this.el = el;
    const next = this.over - dy;
    // Pulled back through zero: the stretch is undone and the scroller takes over again.
    this.over = this.over !== 0 && Math.sign(next) !== Math.sign(this.over) ? 0 : next;
    this.v = 0;
    this.apply(el, rubberband(this.over, el.clientHeight));
    if (this.over === 0) this.el = null;
  }

  phase(p: Phase, now: number): void {
    this.phased = true;
    if (p.momentum === "began") this.momentum = true;
    if (p.momentum === "ended" || p.momentum === "cancelled") this.momentum = false;
    if (p.momentum === "none" && (p.phase === "began" || p.phase === "mayBegin")) {
      this.momentum = false;
      this.spent = false;
      this.liftedAt = -Infinity;
    }
    if (p.momentum === "none" && (p.phase === "ended" || p.phase === "cancelled")) {
      this.liftedAt = now;
      this.release();
    }
  }

  /** Fingers lifted: spring home from wherever the content is. */
  release(): void {
    if (!this.el || this.springing) return;
    this.v = 0;
    this.springing = true;
  }

  /** The no-helper stand-in for a lift: the wheel has been quiet long enough. */
  idle(now: number): void {
    if (!this.springing && this.el && now - this.lastWheel >= IDLE_RELEASE_MS) this.release();
  }

  /** Advance the spring by `dt` seconds. Returns whether another frame is wanted. */
  frame(dt: number): boolean {
    if (!this.springing || !this.el) return false;
    // Semi-implicit Euler on x'' = −ω²x − 2ωx', sub-stepped so a dropped frame cannot overshoot.
    const steps = Math.max(1, Math.ceil(dt / 0.004));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.v += (-OMEGA * OMEGA * this.over - 2 * OMEGA * this.v) * h;
      this.over += this.v * h;
    }
    const drawn = rubberband(this.over, this.el.clientHeight);
    if (Math.abs(drawn) < 0.25 && Math.abs(this.v) < 10) { this.settleNow(); return false; }
    this.apply(this.el, drawn);
    return true;
  }

  /** Put the content back with no motion — another scroller took the gesture. */
  settleNow(): void {
    if (this.el) this.apply(this.el, 0);
    this.el = null;
    this.over = this.v = 0;
    this.springing = false;
  }
}

/** The scrollers that give at their ends: the long reading surfaces and lists. Editors, terminals,
 *  grids and fields keep their own scrolling, which their own engines already own. */
export const RUBBER_SCROLLERS = [
  ".transcript", ".space-body", ".page-content", ".summary-scroll", ".diff-list", ".documents-rich-scroll",
  ".pdf-view",
].join(", ");

/** Whether something between the pointer and `scroller` would still scroll that way itself — a code
 *  block or a nested list in the transcript gets the gesture before its pane does. */
function innerScrollerTakes(target: Element, scroller: Element, dy: number): boolean {
  for (let n: Element | null = target; n && n !== scroller; n = n.parentElement) {
    if (n.scrollHeight <= n.clientHeight + 1) continue;
    const oy = getComputedStyle(n).overflowY;
    if (oy !== "auto" && oy !== "scroll") continue;
    if (dy < 0 ? n.scrollTop > 0 : n.scrollTop + n.clientHeight < n.scrollHeight - 1) return true;
  }
  return false;
}

/**
 * Wire the machine to the document. Passive throughout: the wheel is never cancelled, so scrolling
 * itself stays on the compositor and this only ever draws an offset beside it. It stays on under
 * Reduce motion, as an NSScrollView's does: the stretch follows the hand, it is not decoration.
 */
export function installRubberBand(
  doc: Document,
  { onPhase }: { onPhase?: (cb: (p: Phase) => void) => () => void } = {},
): () => void {
  const win = doc.defaultView!;
  /* The offset is written on each CHILD, where it is read, and never on the scroller. `--rubber` is
     registered as not inherited (styles.css), so a write restyles the few children that move and
     nothing inside them; written on the scroller as an inherited property, every frame of a stretch
     restyled the whole list under it — 3,500 elements and ~10 ms a frame in the sidebar's Activity
     view, which is what stuttered at its ends. */
  const band = new RubberBand<HTMLElement>((el, offset) => {
    const kids = Array.from(el.children) as HTMLElement[];
    if (offset === 0) {
      el.removeAttribute("data-rubber");
      for (const kid of kids) kid.style.removeProperty("--rubber");
      return;
    }
    el.setAttribute("data-rubber", "");
    const value = `${offset.toFixed(2)}px`;
    for (const kid of kids) kid.style.setProperty("--rubber", value);
  });
  let raf = 0;
  let last = 0;
  let idleTimer = 0;
  let phased = false;
  /** Fingers on the pad, per the phase stream. A mouse wheel has no phases at all, which is the one
   *  exact way to tell it from a trackpad — and a Mac mouse wheel does not rubber-band. */
  let touching = false;

  const loop = (t: number) => {
    const dt = last ? Math.min((t - last) / 1000, 0.05) : 1 / 60;
    last = t;
    raf = band.frame(dt) ? win.requestAnimationFrame(loop) : 0;
    if (!raf) last = 0;
  };
  const kick = () => { if (!raf) raf = win.requestAnimationFrame(loop); };

  const onWheel = (e: WheelEvent) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || e.deltaMode !== 0) return;
    // A notched mouse wheel scrolls in whole lines and never rubber-bands on a Mac; a trackpad does.
    if (phased) { if (!touching && !band.coasting(win.performance.now())) return; }
    else {
      // No phase stream (the helper is optional): a whole-notch legacy delta is the mouse's mark.
      const legacy = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
      if (legacy !== undefined && legacy !== 0 && legacy % 120 === 0) return;
    }
    const target = e.target instanceof Element ? e.target : null;
    const scroller = target?.closest<HTMLElement>(RUBBER_SCROLLERS);
    if (!target || !scroller || innerScrollerTakes(target, scroller, e.deltaY)) return;
    // The event's own time when it has a sane one (a trackpad's, coalesced or late, says when it
    // happened); one posted without a time stamps 0, and the clock at dispatch has to do.
    const now = win.performance.now();
    band.wheel(scroller, e.deltaY, e.timeStamp > 0 && Math.abs(now - e.timeStamp) < 1000 ? e.timeStamp : now);
    kick();
    if (!phased) {
      win.clearTimeout(idleTimer);
      idleTimer = win.setTimeout(() => { band.idle(win.performance.now()); kick(); }, IDLE_RELEASE_MS);
    }
  };
  const offPhase = onPhase?.((p) => {
    phased = true;
    if (p.momentum === "none" && (p.phase === "began" || p.phase === "mayBegin" || p.phase === "changed")) touching = true;
    if (p.phase === "ended" || p.phase === "cancelled") touching = false;
    band.phase(p, win.performance.now());
    kick();
  });

  doc.addEventListener("wheel", onWheel, { passive: true, capture: true });
  return () => {
    doc.removeEventListener("wheel", onWheel, { capture: true });
    offPhase?.();
    win.clearTimeout(idleTimer);
    if (raf) win.cancelAnimationFrame(raf);
    band.settleNow();
  };
}
