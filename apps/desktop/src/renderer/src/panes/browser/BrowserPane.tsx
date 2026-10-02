import type { BlockedDownload, BrowserAnnotateResult, BrowserHistoryPage, BrowserMenuState, BrowserPickedElement, PasskeyNotice } from "@realm/contracts";
import { Icon, type IconName } from "@realm/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { StoreApi } from "zustand";
import type { PaneProps } from "../registry";
import { useAppStoreMaybe, type AppState, type BrowserActionTick } from "../../state/store";
import { cancelViewRelease, getBrowserBridges, scheduleViewRelease } from "./browser-client";
import { NewTabPage } from "./NewTabPage";
import { browserMenuItems, parseBrowserMenuChoice, type BrowserMenuChoice } from "./browser-menu";
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
 * Why a passkey request did not go through (passkeys.ts).
 *
 * A refused WebAuthn request is silent by design — the page gets `NotAllowedError`, which every site
 * renders as some variant of "that didn't work" — and the four reasons it can happen here need four
 * different things from the user. The first one is the one that matters on a Mac: the passkeys in
 * iCloud Keychain are not reachable from Electron, so a site the user already has a passkey on has
 * none HERE until they register a second one.
 *
 * `rpId` is main's own derivation from the pane's real URL, never the page's claim, so naming a site
 * in this bar is safe.
 */
function passkeyNoticeText(notice: PasskeyNotice): string {
  switch (notice.refused) {
    case "none":
      return `No passkey for ${notice.rpId} in Realm yet. Sign in another way, then create one from that site's security settings — Realm can't use the passkeys in your iCloud Keychain.`;
    case "no_presence":
      return `Touch ID didn't confirm, so the passkey for ${notice.rpId} wasn't used.`;
    case "rp_mismatch":
      return `This page asked for a passkey belonging to ${notice.rpId}. Realm refused it.`;
    case "unavailable":
      return "This Mac has no Touch ID sensor, so Realm can't unlock a passkey.";
  }
}

/** The pane's passkey bar: the last refusal, until the user dismisses it or navigates. */
function usePasskeyNotice(browserId: string) {
  const [notice, setNotice] = useState<PasskeyNotice | null>(null);
  useEffect(() => {
    const off = getBrowserBridges().host.onPasskey((m) => {
      if (m.browserId !== browserId) return;
      setNotice(m);
    });
    return off;
  }, [browserId]);
  return { notice, clear: () => setNotice(null) };
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
function useElementPicker(browserId: string, store: StoreApi<AppState> | null, setNote: (note: string | null) => void) {
  const [armed, setArmed] = useState(false);

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
      // The overlay wears the user's own accent. Read off the live document rather than from the
      // theme store, because the value that matters is the one the page will actually be painted
      // beside — the same resolved colour every other surface in the window is using.
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--rl-accent").trim();
      picked = await getBrowserBridges().host.pickElement(browserId, accent || undefined);
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

  return { armed, toggle };
}

/**
 * Annotate (Plan 26 W7d): the picker kept armed. While it is on, every click in the page pins a
 * numbered outline that stays, and the page's own toolbar — drawn inside the view, because nothing of
 * Realm's can be drawn over it — counts them and offers Send. This side owns the button's lit state
 * and where a Send goes: ONE chip in the same session a pick would go to (`sessionForPick`), carrying
 * every pinned element, with the screenshot of the pins attached beside it.
 */
function useAnnotate(browserId: string, spaceId: string, store: StoreApi<AppState> | null, say: (text: string | null, icon?: IconName) => void) {
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  armedRef.current = armed;
  // A pane closed mid-annotation takes the page's toolbar and pins down with it.
  useEffect(() => () => { if (armedRef.current) void getBrowserBridges().host.cancelAnnotate(browserId).catch(() => {}); }, [browserId]);

  const toggle = async () => {
    const { host, server } = getBrowserBridges();
    if (armed) {
      setArmed(false);
      await host.cancelAnnotate(browserId).catch(() => {});
      return;
    }
    setArmed(true);
    say(null);
    let result: BrowserAnnotateResult = { outcome: "closed" };
    try {
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--rl-accent").trim();
      const dir = await server.screenshotDir(spaceId).catch(() => null);
      result = await host.annotate(browserId, accent || undefined, dir);
    } catch {
      say("Realm could not take control of this page — is DevTools open on it?");
    } finally {
      setArmed(false);
    }
    if (result.outcome === "left") { say("The page changed, so its pins were cleared.", "pin"); return; }
    if (result.outcome !== "sent") return; // closed by the user — nothing to say
    const st = store?.getState();
    const target = st ? sessionForPick(st.items, st.layout, st.focusedLeafId) : null;
    if (!st || !target) { say("Nothing to send these to — open a session pane in this group first.", "pin"); return; }
    const label = st.addAnnotationChip(target.refId, result.elements, result.shot?.name ?? null);
    if (label === null) { say(`${target.title} is already carrying as many picked elements as one message can.`, "pin"); return; }
    if (result.shot) st.attachPicked(target.refId, [{ path: result.shot.path, mime: "image/png", name: result.shot.name, size: result.shot.size }]);
    say(`Added ${label} to ${target.title}.`, "pin");
  };
  return { armed, toggle };
}

/**
 * The pane's receipt — for a pick, a screenshot, a cleared partition.
 *
 * It goes away on its own. It was a banner across the chrome with a manual dismiss, and it stayed
 * until you closed it — which for "Added button#submit to Refactor the parser" is a receipt for
 * something you have already watched happen. A toast is the right shape.
 *
 * It lives in the browser CHROME rather than floating over the pane, and that is not a compromise: a
 * native `WebContentsView` composites over anything in its rectangle (W2's no-overlay rule), so a
 * toast placed over the view is a toast nobody sees.
 */
function useToast() {
  const [note, setNote] = useState<{ text: string; icon: IconName } | null>(null);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), PICK_NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);
  /** The glyph names what the receipt is FOR — the picker's target, a screenshot's picture. */
  const say = useCallback((text: string | null, icon: IconName = "target") => setNote(text === null ? null : { text, icon }), []);
  return { note, say };
}

/**
 * Find in page (Plan 26 W7b): a strip ABOVE the view, like the download bar, because nothing can be
 * drawn over the page — the view's height gives up the strip's, through the same ResizeObserver.
 *
 * The search runs in the page (`webContents.findInPage`), so Chromium does the matching and the
 * highlighting, and what comes back is a count. Typing starts a new search; Return and the arrows step
 * through it. A navigation ends the search the page was answering, so the next step starts a new one
 * rather than asking Chromium to continue a session it has already thrown away.
 */
function useFindInPage(browserId: string, url: string) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ active: number; matches: number } | null>(null);
  /** Bumped by every request to open, so a second ⌘F re-focuses and re-selects a strip already up. */
  const [focusTick, setFocusTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const live = useRef(false);
  const openRef = useRef(false);
  openRef.current = open;

  useEffect(() => getBrowserBridges().host.onFound((m) => {
    if (m.browserId !== browserId) return;
    setResult({ active: m.activeMatchOrdinal, matches: m.matches });
  }), [browserId]);

  useEffect(() => { live.current = false; setResult(null); }, [url]);

  useEffect(() => {
    if (focusTick === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusTick]);

  // A pane closed with its strip up takes the highlight down with it.
  useEffect(() => () => { if (openRef.current) void getBrowserBridges().host.stopFind(browserId).catch(() => {}); }, [browserId]);

  const run = (q: string, step: "start" | "next" | "previous") => {
    live.current = q !== "";
    void getBrowserBridges().host.find(browserId, q, step).catch(() => {});
  };

  const show = () => {
    if (!open && query !== "") run(query, "start"); // reopened on the last query, as browsers do
    setOpen(true);
    setFocusTick((n) => n + 1);
  };
  const search = (q: string) => { setQuery(q); setResult(null); run(q, "start"); };
  const step = (dir: "next" | "previous") => {
    if (query === "") return;
    run(query, live.current ? dir : "start");
  };
  const close = () => {
    setOpen(false);
    setResult(null);
    live.current = false;
    void getBrowserBridges().host.stopFind(browserId).catch(() => {});
  };
  return { open, query, result, inputRef, show, search, step, close };
}

/** How long typing has to pause before the history is asked. Short enough to feel like the list is
 *  keeping up; long enough that a word typed at speed is one query, not one per letter. */
export const SUGGEST_DEBOUNCE_MS = 80;

export type SuggestionRow = { kind: "page"; page: BrowserHistoryPage } | { kind: "search"; query: string };

/** An address as a person reads it in a list: no scheme, no lone trailing slash. */
const shortUrl = (url: string) => url.replace(/^https?:\/\//i, "").replace(/\/$/, "");

/**
 * The address field's suggestions (Plan 26 W7c): the pages this space's profile has visited that
 * match what is being typed, best first, then a row that searches the web for it.
 *
 * Asked only while the field is focused and holds text someone typed — focusing the field shows the
 * page's own address, and that is not a question. A response that comes back after the text has moved
 * on is dropped rather than shown against words it was not asked about.
 */
function useSuggestions(spaceId: string, text: string | null, focused: boolean) {
  const [pages, setPages] = useState<BrowserHistoryPage[]>([]);
  /** Which row ↑/↓ is on; -1 is the field itself, where Return goes to what was typed. */
  const [highlight, setHighlight] = useState(-1);
  const query = focused && text !== null ? text.trim() : "";
  useEffect(() => {
    setHighlight(-1);
    if (query === "") { setPages([]); return; }
    let live = true;
    const t = setTimeout(() => {
      void getBrowserBridges().server.suggest(spaceId, query)
        .then((rows) => { if (live) setPages(rows); })
        .catch(() => { if (live) setPages([]); });
    }, SUGGEST_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(t); };
  }, [spaceId, query]);
  const rows: SuggestionRow[] = query === "" ? [] : [...pages.map((page) => ({ kind: "page" as const, page })), { kind: "search", query }];
  const move = (by: 1 | -1) => setHighlight((h) => Math.max(-1, Math.min(rows.length - 1, h + by)));
  return { rows, highlight: Math.min(highlight, rows.length - 1), setHighlight, move };
}

/**
 * The browser pane (Plan 11 W1): DOM chrome ABOVE a native `WebContentsView` that Electron main owns.
 * The view composites over everything in its rectangle (wontfix), so every control here is an INLINE
 * toolbar button — no DOM dropdown, nothing of this window's that would ever need to open "over" the
 * view. That is W2's no-overlay invariant starting at home. The one menu, ⋯, is the OS's: main draws
 * it, above the app, where the page cannot cover it. Anything a row opens is a strip ABOVE the view.
 *
 * The div below the chrome is only a placeholder: its rect is synced to main (ResizeObserver + rAF
 * throttle), and during pane drags the view hides outright rather than visibly trailing the
 * placeholder (the research's bounds-lag mitigation; drags are on the do-NOT-animate list).
 */
/** How long the pick receipt stays up. Long enough to read a session name, short enough that it is
 *  gone before you look for the thing it is covering. */
export const PICK_NOTE_MS = 3200;

export function BrowserPane({ item, visible, focused }: PaneProps) {
  const browserId = item.refId;
  const [state, setState] = useState<BrowserViewState | null>(null);
  /** Non-null while the address input is being edited; otherwise it shows the live url. */
  const [draft, setDraft] = useState<string | null>(null);
  const [addressFocused, setAddressFocused] = useState(false);
  const [initialUrl, setInitialUrl] = useState<string | null>(null); // null until the row loads
  const hostRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Nullable on purpose: unit tests render the pane bare, and a missing store just means no
  // no-overlay registration (there is nothing floating in those tests either).
  const store = useAppStoreMaybe();

  /* A page open over the workspace hides every browser view — see `shouldShowView`. Read through the
     NULLABLE store like everything else here (the unit tests render this pane with no provider, and
     `useApp` would throw), and subscribed rather than polled so a change re-renders — which is what
     lets the effect below push the new verdict to main. */
  const pageOverlay = useSyncExternalStore(
    useCallback((cb: () => void) => store?.subscribe(cb) ?? (() => {}), [store]),
    useCallback(() => store?.getState().pageOverlay != null, [store]),
  );
  const overlayRef = useRef(pageOverlay);
  overlayRef.current = pageOverlay;
  /** The live bounds-sync, published by the effect below so a visibility change can poke it. */
  const syncRef = useRef<(() => void) | null>(null);

  const url = state?.url ?? initialUrl ?? "";
  const hasUrl = url !== "";
  const { actions, driving } = useAgentWatch(store, browserId);
  const downloads = useBlockedDownloads(browserId, item.spaceId);
  const passkey = usePasskeyNotice(browserId);
  const toast = useToast();
  const picker = useElementPicker(browserId, store, toast.say);
  const annotate = useAnnotate(browserId, item.spaceId, store, toast.say);
  const find = useFindInPage(browserId, url);
  const suggest = useSuggestions(item.spaceId, draft, addressFocused);
  const suggestId = `browser-suggest-${browserId}`;
  /* The list belongs to the field, so its rows hang from the field's own edges rather than the pane's.
     Measured, not written down: the controls left of the field are the chrome's business, and a
     number here would drift the day one of them changes. */
  const [suggestEdges, setSuggestEdges] = useState<{ left: number; right: number } | null>(null);
  const listOpen = suggest.rows.length > 0;
  useLayoutEffect(() => {
    if (!listOpen) return;
    const field = inputRef.current?.getBoundingClientRect();
    const pane = paneRef.current?.getBoundingClientRect();
    if (field && pane) setSuggestEdges({ left: Math.max(0, field.left - pane.left), right: Math.max(0, pane.right - field.right) });
  }, [listOpen]);
  const [menuOpen, setMenuOpen] = useState(false);
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
        shouldShowView({ paneVisible: visibleRef.current, pageOverlay: overlayRef.current,
          dragging: flags.dragging, settled: flags.settled, hasUrl: flags.hasUrl }));
      // W2's no-overlay registration: the rect the native view paints (or will paint — transient
      // hides like drags and the mount settle KEEP the rect registered, because the view returns to
      // exactly this rect and a surface placed "over" it during the blink would be covered the
      // moment it comes back). Cleared when the pane has no page or is in a hidden leaf.
      /* The rect the view paints, for the no-overlay machinery. A drag or the mount settle KEEP the
         rect (the view returns to it), but a page overlay does NOT: nothing is floating over the
         host while a full-host page is up, and leaving a rect registered would have sheets opened
         from that page dodging a view that is hidden. */
      store?.getState().setBrowserRect(item.id,
        visibleRef.current && !overlayRef.current && flags.hasUrl ? { x: r.x, y: r.y, width: r.width, height: r.height } : null);
    };
    let raf = 0;
    const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; sync(); }); };
    syncRef.current = schedule;

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

    cancelViewRelease(browserId); // a remount adopts the still-live view
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
      syncRef.current = null;
      cancelAnimationFrame(raf);
      clearTimeout(settleTimer);
      clearTimeout(persistTimer);
      window.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("dragend", onDragEnd);
      window.removeEventListener("drop", onDragEnd);
      window.removeEventListener("resize", schedule);
      // The no-overlay rect tracks where the view PAINTS, so its clear rides the same deferred
      // release: on a layout remount (leaf reparented by a split/unwrap) the adopted view never
      // stops painting, and clearing the rect eagerly would open a window — until the remount's
      // async re-adopt lands — where floating surfaces believe no view exists. A remount cancels
      // this timer and the rect never blinks.
      //
      // Release, not destroy: this pane going away says nothing about the browser being closed
      // (switching space or pane group unmounts every pane in the tree). The view stays alive and
      // hidden; the store destroys it when the user actually closes or deletes the item.
      scheduleViewRelease(browserId, () => {
        store?.getState().setBrowserRect(item.id, null); // nothing paints here any more
        void host.retain(browserId);
      });
    };
  }, [browserId, item.id, item.spaceId, store]);

  /**
   * Push a changed visibility verdict to main.
   *
   * The sync effect above deliberately does NOT depend on these — it owns the view's whole lifecycle
   * (create, adopt, release) and re-running it on a visibility flip would tear the view down and
   * rebuild it. But `sync` reads both through refs, so nothing told main when either changed: opening
   * Settings over a browser left the native view painting over the page, and a pane moved into a
   * hidden leaf would have done the same. One line, and it is the whole fix.
   */
  useEffect(() => { syncRef.current?.(); }, [visible, pageOverlay]);

  // An empty pane's natural target is the address bar (like a fresh browser tab).
  useEffect(() => {
    if (focused && !hasUrl && initialUrl !== null) inputRef.current?.focus();
  }, [focused, hasUrl, initialUrl]);

  /*
   * ⌘F, from either side of the glass. With the page holding the keyboard the keydown goes to the
   * view's own renderer, and main relays it (`onFindRequest`); with the keyboard anywhere in this pane's
   * chrome — the address field included, as in every browser — it is heard here. Only while this pane
   * is the focused one, and only from inside it: ⌘F typed into another pane's field is that pane's.
   */
  const findRef = useRef(find);
  findRef.current = find;
  const hasPageRef = useRef(hasUrl);
  hasPageRef.current = hasUrl;
  useEffect(() => getBrowserBridges().host.onFindRequest((m) => {
    if (m.browserId === browserId && hasPageRef.current) findRef.current.show();
  }), [browserId]);
  useEffect(() => {
    if (!focused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key.toLowerCase() !== "f" || !e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
      const t = e.target;
      const inside = t === document.body || (t instanceof Node && !!paneRef.current?.contains(t));
      if (!inside || !hasPageRef.current) return;
      e.preventDefault();
      findRef.current.show();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focused]);

  const nav = (action: "back" | "forward" | "reload" | "stop") => { void getBrowserBridges().host.nav(browserId, action); };
  /* Right-click either arrow for the trail behind it — the gesture every browser has. The menu is
     the OS's, popped by main: this pane bans dropdowns because the native view composites over
     renderer DOM, and an OS menu is the one surface that is not renderer DOM. Anchored to the
     button's bottom-left so it hangs off the control it belongs to rather than at the pointer. */
  const historyMenu = (dir: "back" | "forward") => (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    void getBrowserBridges().host.historyMenu(browserId, dir, { x: r.left, y: r.bottom });
  };
  const submit = async () => {
    const row = suggest.highlight >= 0 ? suggest.rows[suggest.highlight] : undefined;
    if (row) { await openSuggestion(row); return; }
    const input = draft ?? url;
    const loaded = await getBrowserBridges().host.navigate(browserId, input);
    if (loaded !== null) { setDraft(null); inputRef.current?.blur(); }
  };
  /** A page goes to its address; the search row searches the typed text even when it looks like one. */
  const openSuggestion = async (row: SuggestionRow) => {
    const { host } = getBrowserBridges();
    const loaded = row.kind === "page" ? await host.navigate(browserId, row.page.url) : await host.search(browserId, row.query);
    if (loaded !== null) { setDraft(null); inputRef.current?.blur(); }
  };

  /**
   * Take a screenshot: the view's own capture, written to the space's `screenshots/` folder by main,
   * then attached to a session's prompter — the same session a pick would go to (`sessionForPick`),
   * for the same reason: by the time the menu answers, the focused leaf is this browser's, and "the
   * prompter" has to be decided by where sessions sit, not by what was clicked last.
   */
  const takeScreenshot = async () => {
    const { host, server } = getBrowserBridges();
    const dir = await server.screenshotDir(item.spaceId).catch(() => null);
    if (!dir) { toast.say("This space has no folder to save a screenshot in.", "image"); return; }
    const shot = await host.screenshot(browserId, dir);
    if (!shot.ok) { toast.say(shot.error, "image"); return; }
    const st = store?.getState();
    const target = st ? sessionForPick(st.items, st.layout, st.focusedLeafId) : null;
    if (!st || !target) {
      toast.say(`Saved ${shot.name} to screenshots/. Open a session pane in this group to attach it.`, "image");
      return;
    }
    st.attachPicked(target.refId, [{ path: shot.path, mime: "image/png", name: shot.name, size: shot.size }]);
    toast.say(`Added ${shot.name} to ${target.title}.`, "image");
  };

  /** One chosen row of the ⋯ menu. `menu` is what the menu was built from, so a row acts on the
   *  entry it named even if the pane's own lists moved while the menu was up. */
  const runMenuChoice = async (choice: BrowserMenuChoice, menu: BrowserMenuState) => {
    const { host } = getBrowserBridges();
    switch (choice.kind) {
      case "find": find.show(); return;
      case "print": await host.print(browserId); return;
      case "zoom": await host.zoom(browserId, choice.step); return;
      case "device": await host.setDevice(browserId, choice.preset); return;
      case "screenshot": await takeScreenshot(); return;
      case "save-download": {
        const entry = menu.blocked.find((b) => b.id === choice.id);
        if (entry) await downloads.save(entry);
        return;
      }
      case "show-download": {
        const saved = menu.saved.find((d) => d.id === choice.id);
        // A reveal of a file that has gone does nothing in the Finder, so it says so here instead —
        // in the words the transcript's path menu uses for the same thing.
        if (saved && !(await host.reveal(saved.path))) toast.say(`Nothing is at ${saved.path}. It may have been moved or deleted.`, "alert");
        return;
      }
      case "history": await host.goToIndex(browserId, choice.index); return;
      case "clear-data": {
        const { cleared } = await host.clearData();
        if (!cleared) return;
        // The partition is main's; the pages it showed are the server's. Both, or the field would go on
        // suggesting the history of a browser that has just been told to forget it.
        await getBrowserBridges().server.clearHistory().catch(() => {});
        toast.say("Cleared browsing data. Every browser pane is signed out of its sites.", "check");
        return;
      }
      case "settings": store?.getState().openSettingsPage("signins"); return;
    }
  };

  /* The ⋯ menu. The OS's, popped by main at this button's bottom-left — the history menu's mechanism,
     with rows built here from facts main reads off the view as the menu opens. Window coordinates are
     DIPs, and the renderer's rect is CSS px, so a zoomed window would otherwise drop the menu off the
     button. */
  const openMenu = async (e: ReactMouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const zoom = window.realm?.zoomFactor?.() ?? 1;
    const { host } = getBrowserBridges();
    setMenuOpen(true);
    try {
      const menu = await host.menuState(browserId);
      const items = browserMenuItems({ ...menu, hasPage: hasUrl, current: state?.title?.trim() || url, device: state?.device ?? null });
      const choice = parseBrowserMenuChoice(await host.popupMenu(items, { x: r.left * zoom, y: r.bottom * zoom }));
      setMenuOpen(false);
      if (choice) await runMenuChoice(choice, menu);
    } finally {
      setMenuOpen(false);
    }
  };

  return (
    <div className="browser-pane" ref={paneRef}>
      <div className="browser-chrome">
        <button className="icon-btn" aria-label="Back" title="Back — right-click for the pages behind this one"
          disabled={!state?.canGoBack} onClick={() => nav("back")} onContextMenu={historyMenu("back")}>
          <Icon name="chevronLeft" size={14} />
        </button>
        <button className="icon-btn" aria-label="Forward" title="Forward — right-click for the pages ahead of this one"
          disabled={!state?.canGoForward} onClick={() => nav("forward")} onContextMenu={historyMenu("forward")}>
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
        {/* The picker kept armed: pins stay on the page until Send, and the page's own toolbar is
            where they are counted and sent — this button only says the mode is on, and ends it. */}
        <button className="icon-btn browser-annotate" aria-label="Annotate" aria-pressed={annotate.armed}
          title="Annotate: pin elements on the page, then send them together"
          disabled={!hasUrl} onClick={() => { void annotate.toggle(); }}>
          <Icon name="pin" size={14} />
        </button>
        <form className="browser-address" data-loading={state?.loading || undefined}
          onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <input ref={inputRef} aria-label="Address" placeholder="Enter a URL"
            role="combobox" aria-autocomplete="list" aria-expanded={suggest.rows.length > 0}
            aria-controls={suggest.rows.length > 0 ? suggestId : undefined}
            aria-activedescendant={suggest.highlight >= 0 ? `${suggestId}-${suggest.highlight}` : undefined}
            value={draft ?? url} spellCheck={false} autoCorrect="off" autoCapitalize="off"
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => { setAddressFocused(true); e.target.select(); }}
            onBlur={() => { setAddressFocused(false); setDraft(null); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setDraft(null); e.currentTarget.blur(); }
              else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && suggest.rows.length > 0) {
                e.preventDefault();
                suggest.move(e.key === "ArrowDown" ? 1 : -1);
              }
            }} />
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
        {/* Last in the row, where a browser keeps its menu. The menu is the OS's (see `openMenu`), so
            nothing in this pane's DOM ever opens over the view; the button is lit while it is up. */}
        <button className="icon-btn browser-more" aria-label="More" data-on={menuOpen || undefined}
          title="More: find, print, zoom, screenshot, downloads, history"
          onClick={(e) => { void openMenu(e); }}>
          <Icon name="more" size={14} />
        </button>
      </div>
      {/* Under the field it belongs to and ABOVE the view, pushing the page down while it is up —
          never a dropdown over the page, which the view would paint over (W2.3). Rows keep the
          field's focus on press, so a click picks the row instead of blurring the list away. */}
      {suggest.rows.length > 0 && (
        <div className="browser-suggest" role="listbox" id={suggestId} aria-label="Suggestions"
          style={suggestEdges ? { paddingLeft: suggestEdges.left, paddingRight: suggestEdges.right } : undefined}>
          {suggest.rows.map((row, i) => (
            <div key={row.kind === "page" ? row.page.url : "search"} id={`${suggestId}-${i}`} role="option"
              aria-selected={i === suggest.highlight} className="browser-suggest-row"
              onMouseDown={(e) => e.preventDefault()} onMouseMove={() => suggest.setHighlight(i)}
              onClick={() => { void openSuggestion(row); }}>
              {row.kind === "page" ? (
                <>
                  <Icon name="clock" size={12} />
                  <span className="browser-suggest-title">{row.page.title.trim() || shortUrl(row.page.url)}</span>
                  <span className="browser-suggest-url">{shortUrl(row.page.url)}</span>
                </>
              ) : (
                <>
                  <Icon name="search" size={12} />
                  <span className="browser-suggest-title">Search the web for “{row.query}”</span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {find.open && (
        <div className="browser-notice browser-find" role="search">
          <Icon name="search" size={12} />
          <input ref={find.inputRef} className="browser-find-input" aria-label="Find in page" placeholder="Find in page"
            value={find.query} spellCheck={false} autoCorrect="off" autoCapitalize="off"
            onChange={(e) => find.search(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); find.step(e.shiftKey ? "previous" : "next"); }
              else if (e.key === "Escape") { e.preventDefault(); find.close(); }
            }} />
          {/* Polite, so a count that changes on every keystroke is read when typing pauses. */}
          <span className="browser-find-count" aria-live="polite">
            {find.query === "" || find.result === null ? "" : find.result.matches === 0 ? "No matches" : `${find.result.active} of ${find.result.matches}`}
          </span>
          <button type="button" className="icon-btn" aria-label="Previous match" title="Previous match (⇧↩)"
            disabled={find.query === ""} onClick={() => find.step("previous")}>
            <Icon name="chevronUp" size={12} />
          </button>
          <button type="button" className="icon-btn" aria-label="Next match" title="Next match (↩)"
            disabled={find.query === ""} onClick={() => find.step("next")}>
            <Icon name="chevronDown" size={12} />
          </button>
          <button type="button" className="icon-btn" aria-label="Close find" title="Close (Esc)" onClick={find.close}>
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
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
              </>
            )}
          </span>
          {downloads.top && (
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
      {passkey.notice && (
        <div className="browser-notice" role="status">
          <Icon name="key" size={12} />
          <span className="browser-notice-text">{passkeyNoticeText(passkey.notice)}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={passkey.clear}>
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
      {toast.note && (
        <div className="browser-toast" role="status">
          <Icon name={toast.note.icon} size={12} />
          <span className="browser-toast-text">{toast.note.text}</span>
        </div>
      )}
      {/* At a device size main narrows the view to the device's box, centred here; the ground beside it
          is the pane's, so the box reads as a device rather than as a page with white margins. */}
      <div className="browser-view-host" ref={hostRef} data-device={state?.device ?? undefined}>
        {/* A blank tab is a new tab: the tools beside the address field, in place of an empty page.
            Only while there is no page — the native view is hidden until one loads, so this is the
            one thing that can be drawn in this rectangle at all. */}
        {!hasUrl && initialUrl !== null && <NewTabPage itemId={item.id} />}
      </div>
    </div>
  );
}
