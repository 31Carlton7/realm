import { Icon } from "@realm/ui";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { StoreApi } from "zustand";
import type { PaneProps } from "../registry";
import { useAppStoreMaybe, type AppState, type BrowserActionTick } from "../../state/store";
import { cancelViewDestroy, getBrowserBridges, scheduleViewDestroy } from "./browser-client";
import { SETTLE_MS, isRealmItemDrag, shouldShowView } from "./view-sync";

/** How long after the last main→renderer state change the url/title persist to the server. Debounced:
 *  a redirect chain writes once, and a restart restores the last committed page. */
const PERSIST_MS = 500;

const NO_ACTIONS: BrowserActionTick[] = [];

/** W4's watching feed for one browser: the recent-actions ring (the ticker) and the in-flight flag
 *  (the driving dot). Store-maybe like everything else in this pane — bare unit tests render with no
 *  store and simply show no ticker. */
function useAgentWatch(store: StoreApi<AppState> | null, browserId: string) {
  const subscribe = useCallback((cb: () => void) => (store ? store.subscribe(cb) : () => {}), [store]);
  const actions = useSyncExternalStore(subscribe, () => store?.getState().browserActions[browserId] ?? NO_ACTIONS);
  const driving = useSyncExternalStore(subscribe, () => store?.getState().browserDriving[browserId] ?? false);
  return { actions, driving };
}

const tickTime = (ts: number): string =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * The browser pane (Plan 11 W1): DOM chrome ABOVE a native `WebContentsView` that Electron main owns.
 * The view composites over everything in its rectangle (wontfix), so every control here is an INLINE
 * toolbar button — no dropdowns, no menus, nothing that would ever need to open "over" the view.
 * That is W2's no-overlay invariant starting at home.
 *
 * The div below the chrome is only a placeholder: its rect is synced to main (ResizeObserver + rAF
 * throttle), and during pane drags the view hides outright rather than visibly trailing the
 * placeholder (the research's bounds-lag mitigation; drags are on the do-NOT-animate list).
 */
export function BrowserPane({ item, visible, focused }: PaneProps) {
  const browserId = item.refId;
  const [state, setState] = useState<BrowserViewState | null>(null);
  /** Non-null while the address input is being edited; otherwise it shows the live url. */
  const [draft, setDraft] = useState<string | null>(null);
  const [initialUrl, setInitialUrl] = useState<string | null>(null); // null until the row loads
  const hostRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Nullable on purpose: unit tests render the pane bare, and a missing store just means no
  // no-overlay registration (there is nothing floating in those tests either).
  const store = useAppStoreMaybe();

  const url = state?.url ?? initialUrl ?? "";
  const hasUrl = url !== "";
  const { actions, driving } = useAgentWatch(store, browserId);
  const lastAction = actions.length > 0 ? actions[actions.length - 1]! : null;

  useEffect(() => {
    const { host, server } = getBrowserBridges();
    const el = hostRef.current!;
    let disposed = false;
    let created = false;
    const flags = { dragging: false, settled: false, hasUrl: false };

    const sync = () => {
      if (!created || disposed) return;
      const r = el.getBoundingClientRect();
      host.setBounds(browserId, { x: r.x, y: r.y, width: r.width, height: r.height }, window.devicePixelRatio,
        shouldShowView({ paneVisible: visibleRef.current, dragging: flags.dragging, settled: flags.settled, hasUrl: flags.hasUrl }));
      // W2's no-overlay registration: the rect the native view paints (or will paint — transient
      // hides like drags and the mount settle KEEP the rect registered, because the view returns to
      // exactly this rect and a surface placed "over" it during the blink would be covered the
      // moment it comes back). Cleared when the pane has no page or is in a hidden leaf.
      store?.getState().setBrowserRect(item.id,
        visibleRef.current && flags.hasUrl ? { x: r.x, y: r.y, width: r.width, height: r.height } : null);
    };
    let raf = 0;
    const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; sync(); }); };

    // Persist last committed url/title, debounced; the item title tracks the page server-side.
    let persistTimer: ReturnType<typeof setTimeout> | undefined;
    let persisted = { url: "", title: "" };
    const persist = (s: BrowserViewState) => {
      if (s.loading || s.url === "" || (s.url === persisted.url && s.title === persisted.title)) return;
      clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persisted = { url: s.url, title: s.title };
        void server.update(browserId, persisted).catch(() => { /* row may be mid-delete */ });
      }, PERSIST_MS);
    };

    const offState = host.onState((s) => {
      if (s.id !== browserId || disposed) return;
      setState(s);
      flags.hasUrl = s.url !== "";
      schedule();
      persist(s);
    });

    // Pane/sidebar item drags: hide NOW (synchronously, before the drag image renders), show on end.
    const onDragStart = (e: DragEvent) => { if (isRealmItemDrag(e)) { flags.dragging = true; sync(); } };
    const onDragEnd = () => { if (flags.dragging) { flags.dragging = false; schedule(); } };
    window.addEventListener("dragstart", onDragStart);
    window.addEventListener("dragend", onDragEnd);
    window.addEventListener("drop", onDragEnd);
    window.addEventListener("resize", schedule);

    const ro = new ResizeObserver(schedule);
    ro.observe(el);

    // The pane-slot enter animation (rl-settle) is moving the placeholder for the first ~150ms;
    // the view appears once the layout has actually settled, not mid-tween.
    const settleTimer = setTimeout(() => { flags.settled = true; schedule(); }, SETTLE_MS);

    cancelViewDestroy(browserId); // a StrictMode remount adopts the still-live view
    void (async () => {
      try {
        const [row, allowlist] = await Promise.all([server.get(browserId), server.allowlist(item.spaceId)]);
        if (disposed) return;
        setInitialUrl(row.url);
        await host.create(browserId, row.url, allowlist);
        if (disposed) return;
        created = true;
        // `||`: the live state channel may already have spoken (an adopted view emits state during
        // create) and its url is truer than a row whose debounced persist never landed.
        flags.hasUrl = flags.hasUrl || row.url !== "";
        persisted = { url: row.url, title: row.title };
        schedule();
      } catch (e) {
        // The pane shows its DOM empty state; an unhandled rejection here would kill the whole
        // chain silently (and with it the no-overlay rect updates).
        console.error("browser pane adopt failed", e);
      }
    })();

    return () => {
      disposed = true;
      offState();
      ro.disconnect();
      cancelAnimationFrame(raf);
      clearTimeout(settleTimer);
      clearTimeout(persistTimer);
      window.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("dragend", onDragEnd);
      window.removeEventListener("drop", onDragEnd);
      window.removeEventListener("resize", schedule);
      // The no-overlay rect lives and dies WITH THE VIEW, so its clear rides the same deferred
      // destroy: on a layout remount (leaf reparented by a split/unwrap) the adopted view never
      // stops painting, and clearing the rect eagerly would open a window — until the remount's
      // async re-adopt lands — where floating surfaces believe no view exists. A remount cancels
      // this timer and the rect never blinks; a real close clears rect and view together.
      // (Deferred one macrotask so a StrictMode double-mount re-adopts instead of reloading.)
      scheduleViewDestroy(browserId, () => {
        store?.getState().setBrowserRect(item.id, null); // nothing paints here any more
        void host.destroy(browserId);
      });
    };
  }, [browserId, item.id, item.spaceId, store]);

  // An empty pane's natural target is the address bar (like a fresh browser tab).
  useEffect(() => {
    if (focused && !hasUrl && initialUrl !== null) inputRef.current?.focus();
  }, [focused, hasUrl, initialUrl]);

  const nav = (action: "back" | "forward" | "reload" | "stop") => { void getBrowserBridges().host.nav(browserId, action); };
  const submit = async () => {
    const input = draft ?? url;
    const loaded = await getBrowserBridges().host.navigate(browserId, input);
    if (loaded !== null) { setDraft(null); inputRef.current?.blur(); }
  };

  return (
    <div className="browser-pane">
      <div className="browser-chrome">
        <button className="icon-btn" aria-label="Back" title="Back" disabled={!state?.canGoBack} onClick={() => nav("back")}>
          <Icon name="chevronLeft" size={15} />
        </button>
        <button className="icon-btn" aria-label="Forward" title="Forward" disabled={!state?.canGoForward} onClick={() => nav("forward")}>
          <Icon name="chevronRight" size={15} />
        </button>
        {state?.loading ? (
          <button className="icon-btn" aria-label="Stop" title="Stop" onClick={() => nav("stop")}>
            <Icon name="close" size={14} />
          </button>
        ) : (
          <button className="icon-btn" aria-label="Reload" title="Reload" disabled={!hasUrl} onClick={() => nav("reload")}>
            <Icon name="reload" size={14} />
          </button>
        )}
        <form className="browser-address" data-loading={state?.loading || undefined}
          onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <input ref={inputRef} aria-label="Address" placeholder="Enter a URL"
            value={draft ?? url} spellCheck={false} autoCorrect="off" autoCapitalize="off"
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => setDraft(null)}
            onKeyDown={(e) => { if (e.key === "Escape") { setDraft(null); e.currentTarget.blur(); } }} />
        </form>
        {/* W4's action ticker: the last settled agent action (its permission-card wording — page
            text only ever inside the attributed framing), a quiet time, and the driving dot while
            an act is in flight. Hover reveals the recent few via title. An inline strip, per the
            no-dropdowns rule: nothing here ever opens over the view. */}
        {(driving || lastAction) && (
          <div className="browser-ticker"
            title={[...actions].reverse().map((a) => `${tickTime(a.ts)}  ${a.text}${a.ok ? "" : " — failed"}`).join("\n")}>
            {driving && <span className="status-dot" data-status="driving" title="Agent is driving" aria-label="Agent is driving" />}
            {lastAction && (
              <>
                <span className="browser-ticker-text" data-failed={!lastAction.ok || undefined}>{lastAction.text}</span>
                <span className="browser-ticker-time">{tickTime(lastAction.ts)}</span>
              </>
            )}
          </div>
        )}
      </div>
      <div className="browser-view-host" ref={hostRef}>
        {!hasUrl && initialUrl !== null && (
          <div className="browser-hint muted">
            <div className="browser-hint-title">Where to?</div>
            <div>Type a URL above — https is assumed.</div>
          </div>
        )}
      </div>
    </div>
  );
}
