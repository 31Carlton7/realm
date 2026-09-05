import type { BlockedDownload, BrowserPickedElement } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { StoreApi } from "zustand";
import type { PaneProps } from "../registry";
import { useAppStoreMaybe, type AppState, type BrowserActionTick } from "../../state/store";
import { cancelViewDestroy, getBrowserBridges, scheduleViewDestroy } from "./browser-client";
import { sessionForPick } from "./pick-target";
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
 * Plan 23 W4 — the user's own downloads.
 *
 * Realm blocks every download that is not covered by a grant an approved agent act minted, and
 * `will-download` cannot tell a human's click from `Input.dispatchMouseEvent` — so the pane cannot
 * simply let the user's clicks through. What it can do is stop failing silently: remember what was
 * blocked, say so, and offer one button whose press is consent a page could not have forged (a page
 * lives in its own `WebContentsView` and cannot reach this renderer).
 */
function useBlockedDownloads(browserId: string, spaceId: string) {
  const [blocked, setBlocked] = useState<BlockedDownload[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const { host } = getBrowserBridges();
    let live = true;
    void host.blockedDownloads(browserId).then((rows) => { if (live) setBlocked(rows); });
    const off = host.onDownloadBlocked((m) => {
      if (m.browserId !== browserId) return;
      setNote(null);
      setBlocked((prev) => [...prev, m.blocked]);
    });
    return () => { live = false; off(); };
  }, [browserId]);

  const top = blocked.length > 0 ? blocked[blocked.length - 1]! : null;

  const drop = (id: string) => setBlocked((prev) => prev.filter((b) => b.id !== id));

  const dismiss = (id: string) => {
    drop(id);
    void getBrowserBridges().host.dismissDownload(browserId, id);
  };

  const save = async (entry: BlockedDownload) => {
    setBusy(true);
    setNote(null);
    try {
      const { host, server } = getBrowserBridges();
      // The SERVER decides where downloads go, by the same rule the agent's follow. A space with no
      // project has no destination, and saying so is better than inventing one.
      const dir = await server.downloadDir(spaceId);
      if (dir === null) {
        setNote("This space has no project folder, so there's nowhere to save downloads yet.");
        return;
      }
      const result = await host.saveDownload(browserId, entry.id, dir);
      drop(entry.id);
      setNote(result.ok ? `Saved ${result.name} to downloads/` : result.error);
    } finally {
      setBusy(false);
    }
  };

  return { top, busy, note, dismiss, save, clearNote: () => setNote(null) };
}

/**
 * The element picker's pane-side half.
 *
 * The picker is armed and disarmed here, but nothing about it is drawn here: the highlight is
 * Chrome's own overlay, inside the view, which is the only way to point at something in a rectangle
 * React cannot paint into (W2's no-overlay invariant). All this owns is the toolbar button's lit
 * state and where the result goes.
 *
 * The result goes into a SESSION's composer, chosen structurally by `sessionForPick` — a pick that
 * lands nowhere says so rather than being quietly dropped, because the user's evidence that it
 * worked is a chip appearing in a pane they may not be looking at.
 */
function useElementPicker(browserId: string, store: StoreApi<AppState> | null) {
  const [armed, setArmed] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Only when armed: a pane that never picked has nothing to take down, and main would be answering
  // a cancel for a view it holds no pick on. Through a ref so the effect does not re-run — and so
  // does not disarm — every time the button lights up.
  const armedRef = useRef(false);
  armedRef.current = armed;
  useEffect(() => () => { if (armedRef.current) void getBrowserBridges().host.cancelPick(browserId).catch(() => {}); }, [browserId]);

  const toggle = async () => {
    if (armed) {
      setArmed(false);
      await getBrowserBridges().host.cancelPick(browserId).catch(() => {});
      return;
    }
    setArmed(true);
    setNote(null);
    // `finally`, because main throws rather than answering when the debugger will not attach (DevTools
    // already has it). Without this the rejection crosses the IPC, nothing catches it, and the button
    // stays lit over a view that is not picking — the one failure this whole path exists to avoid.
    let picked: BrowserPickedElement | null = null;
    try {
      picked = await getBrowserBridges().host.pickElement(browserId);
    } catch {
      setNote("Realm could not take control of this page — is DevTools open on it?");
    } finally {
      setArmed(false);
    }
    if (!picked) return; // cancelled, navigated, or the pane went away — nothing to say
    const state = store?.getState();
    const target = state ? sessionForPick(state.items, state.layout, state.focusedLeafId) : null;
    if (!target || !state) {
      setNote("Nothing to send this to — open a session pane in this group first.");
      return;
    }
    // Named twice over, because neither name is guessable from here: the store answers with the label
    // it actually used (a second identical button is disambiguated on the way in), and the session is
    // said out loud because with two open the chip lands in a prompter the user is not looking at.
    const label = state.addElementChip(target.refId, picked);
    setNote(label === null
      ? `${target.title} is already carrying as many picked elements as one message can.`
      : `Added ${label} to ${target.title}.`);
  };

  return { armed, note, toggle, clearNote: () => setNote(null) };
}

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
  const downloads = useBlockedDownloads(browserId, item.spaceId);
  const picker = useElementPicker(browserId, store);
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
          <Icon name="chevronLeft" size={14} />
        </button>
        <button className="icon-btn" aria-label="Forward" title="Forward" disabled={!state?.canGoForward} onClick={() => nav("forward")}>
          <Icon name="chevronRight" size={14} />
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
        {/* Inline, like every other control here: the native view composites over this pane's
            rectangle, so a picker that opened a panel would open it underneath the page. */}
        <button className="icon-btn browser-pick" aria-label="Pick an element" aria-pressed={picker.armed}
          title="Pick an element to send to the prompter"
          disabled={!hasUrl} onClick={() => { void picker.toggle(); }}>
          <Icon name="target" size={14} />
        </button>
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
      {/* Below the chrome and ABOVE the view host, never over it: the native view composites over
          anything inside its rectangle, so a floating toast here would be invisible (W2's invariant).
          Its height comes out of the view's, which the ResizeObserver already syncs. */}
      {(downloads.top || downloads.note) && (
        <div className="browser-notice" role="status">
          <Icon name="attach" size={12} />
          {/* The note, when there is one, is the answer to what the user just pressed — so it wins the
              text. The entry's own buttons stay put underneath it: a save that failed because the
              space has no project is one the user can retry after adding one, and swallowing the
              Save button at that moment would strand them. */}
          <span className="browser-notice-text">
            {downloads.note ?? (
              <>
                Blocked a download: <strong>{downloads.top!.name}</strong>
                {!downloads.top!.retryable && " — Realm doesn't save this file type"}
              </>
            )}
          </span>
          {downloads.top?.retryable && (
            <button type="button" className="btn-quiet" disabled={downloads.busy}
              onClick={() => { void downloads.save(downloads.top!); }}>
              {downloads.busy ? "Saving…" : "Save"}
            </button>
          )}
          <button type="button" className="icon-btn" aria-label="Dismiss"
            onClick={() => { if (downloads.top) downloads.dismiss(downloads.top.id); else downloads.clearNote(); }}>
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
      {picker.note && (
        <div className="browser-notice" role="status">
          <Icon name="target" size={12} />
          <span className="browser-notice-text">{picker.note}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={picker.clearNote}>
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
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
