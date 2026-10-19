import { Icon, type IconName } from "@realm/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { placeToastStack, type Rect, type ToastPlacement } from "../state/no-overlay";
import { useApp, useBrowserRects } from "../state/store";
import type { Toast, ToastTone } from "../state/toasts";
import { prefersReducedMotion } from "../reduced-motion";

/** The stack's width, and the narrowest it will go to stay clear of a browser view. */
const WIDTH = 340;
const MIN_WIDTH = 240;
/** Off the window's edges, and off a view or a prompter it stands beside. */
const MARGIN = 16;
/** How much of each toast tucked behind the front one shows above it, and the gap between them fanned
 *  out under the pointer. */
const PEEK = 10;
const GAP = 8;
/** A toast's height before its first measurement: a line and its padding. Measured in the same frame,
 *  before paint, so this only decides where the very first layout pass looks. */
const ESTIMATE = 42;
/** How long a leaving toast stays in the DOM — the same fact as its fade (`--dur-swap`), pinned to it
 *  by styles.test.ts, so the timer can neither clip the fade nor park a finished toast on screen. */
export const TOAST_EXIT_MS = 160;
/** What the stack stands above, never over: a prompter's dock, and any other dock of answers that says
 *  so — Review's decision bar. */
const LIFTS = ".composer-dock, [data-lifts-toasts]";

const TONE_ICON: Record<ToastTone, IconName> = { error: "errorCircle", warning: "alert", success: "checkCircle", info: "info" };

/**
 * Whether the window is the key window and on screen — the toasts' clocks run only then. The signal is
 * the WINDOW's (`data-window-inactive`, from main), not the page's focus: a click into a browser pane
 * blurs the page while the window keeps the keyboard, and a toast that stopped then would never leave.
 * A notice that arrives while someone is in another app waits for them to come back.
 */
function useWindowWatched(): boolean {
  const read = () => !document.documentElement.hasAttribute("data-window-inactive") && document.visibilityState !== "hidden";
  const [watched, setWatched] = useState(read);
  useEffect(() => {
    const update = () => setWatched(read());
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-window-inactive"] });
    document.addEventListener("visibilitychange", update);
    return () => { mo.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);
  return watched;
}

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};

/**
 * The window's toasts (v2): a stack at its foot, newest in front and the two before it tucked behind,
 * fanning out under the pointer. Each one says its piece, runs a thin line across its foot for as long
 * as it is up, and leaves when the line reaches the end. The pointer on the stack, focus in it, or the
 * window not being key all stop every clock — a person reading one, or selecting its text to copy, is
 * never cut off.
 *
 * Where it stands is `placeToastStack`'s question: the bottom-right corner, moved along the foot off
 * any browser view (which would paint over it) and lifted above a prompter (whose send button is in
 * that corner) or Review's decision bar. A dock that arrives, goes or grows while a toast is up moves
 * the stack with it. With no clear spot at all — a browser filling a window whose sidebar is folded
 * away — the view under the corner gives it up for as long as there is something to say (`toastReserve`).
 *
 * Portalled to `document.body` for the reason `Sheet` is: a `.panel` is a containing block for fixed
 * descendants, and a toast placed in window coordinates has to be measured against the window.
 */
export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  const setReserve = useApp((s) => s.setToastReserve);
  // A page over the workspace covers its prompters; standing above one under the page would only
  // push the stack up for nothing.
  const pageOverlay = useApp((s) => s.pageOverlay != null);
  const browserRects = useBrowserRects();
  const watched = useWindowWatched();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [spot, setSpot] = useState<ToastPlacement | null>(null);
  const expanded = hovered || focused;
  const paused = expanded || !watched;

  // Front first: index 0 is the newest, and it is also first in the reading and the tab order.
  const stack = [...toasts].reverse();
  const heightOf = (t: Toast) => heights[t.id] ?? ESTIMATE;
  const frontHeight = stack[0] ? heightOf(stack[0]) : 0;
  /** How far up each toast sits fanned out: the heights of the ones in front of it, and their gaps. */
  const fanned = stack.map((_, k) => stack.slice(0, k).reduce((sum, t) => sum + heightOf(t) + GAP, 0));
  const fannedHeight = stack.length === 0 ? 0 : fanned[stack.length - 1]! + heightOf(stack[stack.length - 1]!);

  const onHeight = useCallback((id: string, h: number) => {
    setHeights((cur) => (cur[id] === h ? cur : { ...cur, [id]: h }));
  }, []);
  // A stack that empties under the pointer or the keyboard never hears it leave — the element the
  // pointer was over is gone — and the next toast would arrive paused.
  useEffect(() => { if (toasts.length === 0) { setHovered(false); setFocused(false); setHeights({}); } }, [toasts.length]);

  useLayoutEffect(() => {
    if (toasts.length === 0) { setReserve(null); return; }
    let docks: Element[] = [];
    const place = () => {
      const win = { width: window.innerWidth, height: window.innerHeight };
      const width = Math.min(WIDTH, win.width - 2 * MARGIN);
      const lift = pageOverlay ? [] : docks.map(rectOf);
      const placed = placeToastStack({ win, width, minWidth: Math.min(MIN_WIDTH, width), height: fannedHeight, margin: MARGIN, avoid: browserRects, lift });
      const next = placed ?? { left: win.width - MARGIN - width, bottom: MARGIN, width };
      setSpot((cur) => (cur && cur.left === next.left && cur.bottom === next.bottom && cur.width === next.width ? cur : next));
      setReserve(placed ? null : {
        x: next.left - MARGIN, y: win.height - next.bottom - fannedHeight - MARGIN,
        width: next.width + 2 * MARGIN, height: fannedHeight + next.bottom + MARGIN,
      });
    };
    // A prompter that grows a line moves its top, and the stack standing over it has to move with it.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    /** The docks in the window now, each watched for its size. True when the set changed. */
    const track = () => {
      const now = [...document.querySelectorAll(LIFTS)];
      if (now.length === docks.length && now.every((el, k) => el === docks[k])) return false;
      ro?.disconnect();
      docks = now;
      for (const el of docks) ro?.observe(el);
      return true;
    };
    track();
    place();
    window.addEventListener("resize", place);
    // A dock that arrives under a toast already up — Review's decision bar as the next review opens —
    // or one that leaves. Only while there is a toast to move: the observer goes with the last one. It
    // reads only what changed, since a transcript streaming beside the toast changes the DOM constantly.
    const mo = new MutationObserver((changes) => {
      const arrived = changes.some((m) => [...m.addedNodes].some((n) => n instanceof Element && (n.matches(LIFTS) || n.querySelector(LIFTS) !== null)));
      if ((arrived || docks.some((el) => !el.isConnected)) && track()) place();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => { window.removeEventListener("resize", place); ro?.disconnect(); mo.disconnect(); };
  }, [toasts.length, fannedHeight, browserRects, pageOverlay, setReserve]);
  useEffect(() => () => setReserve(null), [setReserve]);

  const style: CSSProperties = spot
    ? { left: spot.left, bottom: spot.bottom, width: spot.width, height: expanded ? fannedHeight : frontHeight }
    : { visibility: "hidden" };
  return createPortal(
    // "Notices", not "Notifications": that is the feed's page, and two landmarks of one name are one
    // too many for anyone moving between them by name.
    <section className="toasts" aria-label="Notices" style={style} data-expanded={expanded || undefined}
      onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}>
      {stack.map((t, index) => (
        <ToastCard key={t.id} toast={t} index={index} count={stack.length}
          y={expanded ? -fanned[index]! : -PEEK * index} scale={expanded ? 1 : 1 - 0.05 * index}
          height={expanded || index === 0 ? heightOf(t) : frontHeight}
          paused={paused} onHeight={onHeight} onGone={dismiss} />
      ))}
    </section>,
    document.body,
  );
}

function ToastCard({ toast, index, count, y, scale, height, paused, onHeight, onGone }: {
  toast: Toast; index: number; count: number; y: number; scale: number; height: number; paused: boolean;
  onHeight: (id: string, h: number) => void; onGone: (id: string) => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);
  /** What is left of its time. Spent only while the clock runs; a pause keeps the rest. */
  const remaining = useRef(toast.life);

  const leave = useCallback(() => {
    // Focus on its way out with it would land on <body>, which nobody chose. The next toast's close
    // takes it if there is one, so a reader dismissing by keyboard can go on doing so.
    const el = card.current;
    if (el?.contains(document.activeElement)) {
      const next = [...(el.parentElement?.querySelectorAll<HTMLElement>(".toast-close") ?? [])].find((b) => !el.contains(b));
      if (next) next.focus();
      else (document.activeElement as HTMLElement | null)?.blur();
    }
    setLeaving(true);
  }, []);

  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => onGone(toast.id), prefersReducedMotion() ? 0 : TOAST_EXIT_MS);
    return () => clearTimeout(t);
  }, [leaving, onGone, toast.id]);

  // The clock, and the line across the foot is drawn on the same one: both stop and start on `paused`,
  // so the line reaching the end and the toast leaving are the same moment.
  useEffect(() => {
    if (paused || leaving) return;
    const started = performance.now();
    const t = setTimeout(leave, remaining.current);
    return () => { clearTimeout(t); remaining.current = Math.max(0, remaining.current - (performance.now() - started)); };
  }, [paused, leaving, leave]);

  // Its own height, which the stack fans out by. The body is measured rather than the card, because
  // a toast tucked behind is clipped to the front one's height.
  useLayoutEffect(() => {
    const el = body.current; if (!el) return;
    const measure = () => onHeight(toast.id, el.offsetHeight);
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [onHeight, toast.id]);

  return (
    <div ref={card} className="toast" role={toast.tone === "error" ? "alert" : "status"} aria-atomic="true"
      data-tone={toast.tone} data-front={index === 0 || undefined} data-leaving={leaving || undefined} data-paused={paused || undefined}
      style={{ zIndex: count - index, "--toast-y": `${y}px`, "--toast-scale": scale, "--toast-h": `${height}px`, "--toast-life": `${toast.life}ms` } as CSSProperties}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); leave(); } }}>
      <div ref={body} className="toast-body">
        <span className="toast-icon"><Icon name={toast.icon ?? TONE_ICON[toast.tone]} size={16} /></span>
        {/* The words select, so an error's wording can be copied; nothing on the card acts on a press
            but its buttons, which stay chrome. */}
        <p className="toast-text" data-selectable="">{toast.text}</p>
        {/* Taken, it is done with: the toast goes as the thing it offered happens. */}
        {toast.action && (
          <button type="button" className="btn-quiet toast-action" onClick={() => { toast.action!.run(); leave(); }}>
            {toast.action.label}
          </button>
        )}
        <button type="button" className="icon-btn toast-close" aria-label="Dismiss" title="Dismiss" onClick={leave}>
          <Icon name="close" size={12} />
        </button>
      </div>
      <span className="toast-progress" aria-hidden="true" />
    </div>
  );
}
