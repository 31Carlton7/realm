/**
 * Rubber-banding for the app's own scrollers — what an NSScrollView does at its ends, and what
 * Chromium only ever does for the page body. Every surface in Realm scrolls inside a pane rather than
 * as the document, so without this nothing in the app gives at its edge: a flick to the top of a
 * transcript stops dead, the way a web page in a frame does and no Mac view does.
 *
 * The content is moved with `translate` on the scroller's children (styles.css, `[data-rubber]`), never
 * by scrolling — a scroller cannot scroll past its own ends — and never on the scroller itself, whose
 * box, mask and scrollbar stay where they are, as a clip view's do.
 *
 * Three moments, and the trackpad phase stream (main/scroll-phase.ts) is what tells them apart:
 *  - fingers on the pad, pulling past an end: the content follows with rising resistance;
 *  - fingers lifted: it springs home;
 *  - a coast that reaches an end: it carries past by the speed it arrived with, and settles back —
 *    the bounce, which no amount of further momentum extends.
 * Without the helper (it is optional), a pause in the wheel stands in for the lift.
 */

/** Apple's rubber-band: the further past the end, the less the content follows. `dim` is the
 *  scroller's own height, so a short list gives a shorter stretch than a tall one. */
export function rubberband(over: number, dim: number, c = 0.55): number {
  if (dim <= 0) return 0;
  return (over * dim * c) / (dim + c * Math.abs(over));
}

/** The inverse: how far past the end the content must have been pulled to sit at offset `x` — what
 *  lets a gesture take hold of content that is still springing home, from where it actually is. */
export function unrubberband(x: number, dim: number, c = 0.55): number {
  if (dim <= 0 || x === 0) return 0;
  const ax = Math.min(Math.abs(x), dim * 0.999);
  return (Math.sign(x) * ax * dim) / (c * (dim - ax));
}

/** Critically damped return, in s⁻¹. ~0.35s from a full stretch to rest, AppKit's pace. */
const OMEGA = 14;
/** A coast's bounce: how much of the arriving speed carries past the end. */
const BOUNCE_OMEGA = 18;
/** Without the phase stream, how long the wheel must go quiet before the fingers count as lifted. */
export const IDLE_RELEASE_MS = 110;

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
 */
export class RubberBand<T extends RubberTarget> {
  private el: T | null = null;
  /** Raw distance pulled past the end, before resistance. + is past the top, − past the bottom. */
  private over = 0;
  /** Drawn offset and its velocity while a spring runs. */
  private x = 0;
  private v = 0;
  private springing = false;
  private momentum = false;
  /** A coast already bounced on this gesture; the rest of it is spent. */
  private bounced = false;
  private lastWheel = 0;

  constructor(private readonly apply: (el: T, offset: number) => void) {}

  get active(): boolean { return this.el !== null; }
  /** A coast is running — the fingers are off the pad and the content is still moving. */
  get coasting(): boolean { return this.momentum; }

  /** A wheel delta over `el`, already known to be the scroller this gesture is about. */
  wheel(el: T, dy: number, now: number): void {
    if (this.el && this.el !== el) this.settleNow();
    const atTop = el.scrollTop <= 0;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    this.lastWheel = now;

    if (this.momentum) {
      // A coast. It may bounce once, when it reaches an end; everything after that is spent.
      if (this.bounced || this.springing) return;
      if ((dy < 0 && atTop) || (dy > 0 && atBottom)) {
        this.el = el;
        this.bounced = true;
        this.x = 0;
        // Wheel deltas arrive about once a frame, so the delta IS the speed per 16ms.
        this.v = (-dy / 0.016) * (BOUNCE_OMEGA / OMEGA);
        this.over = 0;
        this.springing = true;
      }
      return;
    }

    if (this.springing && this.el === el) {
      // Fingers back on the pad mid-spring: take hold of the content where it is, not where the
      // stretch started — an interruptible spring, not one that has to finish first.
      this.over = this.bounced ? unrubberband(rubberband(this.x, el.clientHeight), el.clientHeight) : unrubberband(this.x, el.clientHeight);
      this.springing = false;
      this.bounced = false;
    }
    const pulling = (dy < 0 && atTop) || (dy > 0 && atBottom);
    if (!pulling && this.over === 0) return;
    this.el = el;
    const next = this.over - dy;
    // Pulled back through zero: the stretch is undone and the scroller takes over again.
    this.over = this.over !== 0 && Math.sign(next) !== Math.sign(this.over) ? 0 : next;
    this.x = rubberband(this.over, el.clientHeight);
    this.apply(el, this.x);
    if (this.over === 0) this.el = null;
  }

  phase(p: Phase): void {
    if (p.momentum === "began") { this.momentum = true; this.bounced = false; }
    if (p.momentum === "ended" || p.momentum === "cancelled") this.momentum = false;
    if (p.momentum === "none" && (p.phase === "began" || p.phase === "mayBegin")) { this.momentum = false; this.bounced = false; }
    if (p.momentum === "none" && (p.phase === "ended" || p.phase === "cancelled")) this.release();
  }

  /** Fingers lifted: spring home from wherever the content is. */
  release(): void {
    if (!this.el || this.springing) return;
    this.over = 0;
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
    const omega = this.bounced ? BOUNCE_OMEGA : OMEGA;
    // Semi-implicit Euler on x'' = −ω²x − 2ωx', sub-stepped so a dropped frame cannot overshoot.
    const steps = Math.max(1, Math.ceil(dt / 0.004));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.v += (-omega * omega * this.x - 2 * omega * this.v) * h;
      this.x += this.v * h;
    }
    if (Math.abs(this.x) < 0.25 && Math.abs(this.v) < 4) { this.settleNow(); return false; }
    // A bounce springs a raw distance and draws it through the resistance curve, so a fast coast
    // still cannot throw the content further than a stretch could; a release springs the drawn offset.
    this.apply(this.el, this.bounced ? rubberband(this.x, this.el.clientHeight) : this.x);
    return true;
  }

  /** Put the content back with no motion — another scroller took the gesture, or motion is off. */
  settleNow(): void {
    if (this.el) this.apply(this.el, 0);
    this.el = null;
    this.over = this.x = this.v = 0;
    this.springing = false;
  }
}

/** The scrollers that give at their ends: the long reading surfaces and lists. Editors, terminals,
 *  grids and fields keep their own scrolling, which their own engines already own. */
export const RUBBER_SCROLLERS = [
  ".transcript", ".space-body", ".page-content", ".summary-scroll", ".diff-list", ".documents-rich-scroll",
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
 * itself stays on the compositor and this only ever draws an offset beside it.
 */
export function installRubberBand(
  doc: Document,
  { onPhase, reducedMotion }: { onPhase?: (cb: (p: Phase) => void) => () => void; reducedMotion: () => boolean },
): () => void {
  const win = doc.defaultView!;
  const band = new RubberBand<HTMLElement>((el, offset) => {
    if (offset === 0) { el.removeAttribute("data-rubber"); el.style.removeProperty("--rubber"); return; }
    el.setAttribute("data-rubber", "");
    el.style.setProperty("--rubber", `${offset.toFixed(2)}px`);
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
    if (reducedMotion()) { band.settleNow(); return; }
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || e.deltaMode !== 0) return;
    // A notched mouse wheel scrolls in whole lines and never rubber-bands on a Mac; a trackpad does.
    if (phased) { if (!touching && !band.coasting) return; }
    else {
      // No phase stream (the helper is optional): a whole-notch legacy delta is the mouse's mark.
      const legacy = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
      if (legacy !== undefined && legacy !== 0 && legacy % 120 === 0) return;
    }
    const target = e.target instanceof Element ? e.target : null;
    const scroller = target?.closest<HTMLElement>(RUBBER_SCROLLERS);
    if (!target || !scroller || innerScrollerTakes(target, scroller, e.deltaY)) return;
    band.wheel(scroller, e.deltaY, e.timeStamp);
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
    band.phase(p);
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
