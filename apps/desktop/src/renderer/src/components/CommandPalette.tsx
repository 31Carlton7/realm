import { Icon } from "@realm/ui";
import { AGENT_META, PRESETS, SELECTABLE_AGENT_KINDS, emptyLayout, itemIdOfLeaf, allItems as openItemIds, type Item, type PresetName, type SearchResults, type SearchSnippet } from "@realm/contracts";
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { StoreApi } from "zustand";
import { centerOverComplement } from "../state/no-overlay";
import { useApp, useBrowserRects, type AppState } from "../state/store";
import type { ThemePref } from "../theme/useTheme";
import { ItemGlyph } from "./sidebar/ItemList";
import { SpaceIcon } from "./SpaceIcon";

type Entry = { id: string; label: string; hint?: ReactNode; icon: ReactNode; run: () => void; section: string; disabled?: boolean;
  /** A deep-search row (Plan 16 W2): rendered below the instant rows, under its group header even
   *  while a query is typed (instant rows go flat with a query; these stay grouped). */
  deep?: boolean };

/** How long a keystroke rests before `search.query` goes out. The instant rows never wait on this —
 *  deep results only ever APPEND below them when the answer lands. */
export const SEARCH_DEBOUNCE_MS = 120;
/** One character matches everything and helps no one; deep search starts at two. */
export const SEARCH_MIN_QUERY = 2;

function Snippet({ parts }: { parts: SearchSnippet }) {
  return <span className="palette-snippet">{parts.map((p, i) => p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>)}</span>;
}

/** ⌘K toggles the palette. Bound separately from useGlobalHotkeys: it must fire while the palette
 *  itself is open (and its input focused), which the global guard forbids. */
export function usePaletteHotkey(store: StoreApi<AppState>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const s = store.getState();
        if (s.sheet) return; // a modal sheet owns the keyboard
        s.setPaletteOpen(!s.paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);
}

/**
 * Case-insensitive subsequence match with word-start / consecutive / prefix boosts (U-H6).
 * Null = no match. Higher scores sort first: "nt" scores "New terminal" (two word-starts) far above
 * "Open Terminal…" (one). Greedy left-to-right, so it is an approximation of the best alignment —
 * plenty for a palette.
 */
export function matchScore(query: string, text: string): number | null {
  const q = query.toLowerCase(), t = text.toLowerCase();
  if (!q) return 0;
  let score = 0, ti = -1, prev = -2;
  for (const ch of q) {
    ti = t.indexOf(ch, ti + 1);
    if (ti === -1) return null;
    if (ti === 0 || !/[a-z0-9]/.test(t[ti - 1]!)) score += 3; // word start
    else if (ti === prev + 1) score += 2;                      // consecutive run
    prev = ti;
  }
  if (t.startsWith(q)) score += 3;                             // whole-query prefix boost
  return score;
}

/** Compact relative age: "now", "5m", "2h", "3d", "2mo", "1y". */
export function relTime(ts: number, now = Date.now()): string {
  const m = Math.floor(Math.max(0, now - ts) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

const THEMES: ThemePref[] = ["system", "light", "dark"];

/** The palette's CSS width (styles.css `.palette`); the no-overlay path needs the number. */
const PALETTE_WIDTH = 560;

/** Layout presets moved here from the retired topbar LayoutMenu (spec amendment §A1). */
const PRESET_LABELS: Record<PresetName, string> = { one: "1-up", "two-col": "2 columns", "three-col": "3 columns", "grid-2x2": "2×2 grid", "grid-3x3": "3×3 grid" };

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  if (!open) return null;
  return <PaletteBody />;
}

/** Search across every space's items (recency-sorted, disambiguated), plus actions and themes. */
function PaletteBody() {
  const spaces = useApp((s) => s.spaces);
  const activeSpaceId = useApp((s) => s.activeSpaceId);
  const items = useApp((s) => s.items);
  const allItems = useApp((s) => s.allItems);
  const layout = useApp((s) => s.layout);
  const focusedLeafId = useApp((s) => s.focusedLeafId);
  const sessions = useApp((s) => s.sessions);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const themePref = useApp((s) => s.themePref);
  const selectSpace = useApp((s) => s.selectSpace);
  const openItem = useApp((s) => s.openItem);
  const newTerminal = useApp((s) => s.newTerminal);
  const newBrowser = useApp((s) => s.newBrowser);
  const openDocuments = useApp((s) => s.openDocuments);
  const newSession = useApp((s) => s.newSession);
  const newSessionInstant = useApp((s) => s.newSessionInstant);
  const newSessionInWorktree = useApp((s) => s.newSessionInWorktree);
  const dispatchDraft = useApp((s) => s.dispatchDraft);
  const drafts = useApp((s) => s.drafts);
  const splitFocused = useApp((s) => s.splitFocused);
  const closeFromLayout = useApp((s) => s.closeFromLayout);
  const requestRename = useApp((s) => s.requestRename);
  const interruptSession = useApp((s) => s.interruptSession);
  const jumpToPermission = useApp((s) => s.jumpToPermission);
  const applyPreset = useApp((s) => s.applyPreset);
  const setThemePref = useApp((s) => s.setThemePref);
  const openSheet = useApp((s) => s.openSheet);
  const openSpacePage = useApp((s) => s.openSpacePage);
  const openDestinationPage = useApp((s) => s.openDestinationPage);
  const openProfilePage = useApp((s) => s.openProfilePage);
  const openActivity = useApp((s) => s.openActivity);
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  const refreshAllItems = useApp((s) => s.refreshAllItems);
  const searchDeep = useApp((s) => s.searchDeep);
  const run = useApp((s) => s.run);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => setPaletteOpen(false);
  // W2 (no-overlay): with a browser pane open, center over the widest non-browser column instead
  // of the window — the native view would paint over a window-centered palette. Computed inline
  // and applied as plain positioning (the palette is on the do-NOT-animate list; nothing tweens).
  const browserRects = useBrowserRects();
  const spot = centerOverComplement({ width: window.innerWidth, height: window.innerHeight }, browserRects, PALETTE_WIDTH);
  const paletteStyle = spot ? { position: "absolute" as const, left: spot.left, top: "12vh", width: spot.width } : undefined;

  // Cross-space listings come from items.listAll; refresh on every open so ages/titles are current.
  useEffect(() => { run(() => refreshAllItems()); }, [refreshAllItems, run]);

  // Deep search (Plan 16 W2): debounced and stale-guarded. THE instant-palette doctrine, restated
  // where it could be broken: nothing above this effect awaits it — the instant rows are computed
  // synchronously from state, and these results only ever append BELOW them when the answer lands.
  const [deep, setDeep] = useState<{ forQuery: string; results: SearchResults } | null>(null);
  const [searching, setSearching] = useState(false);
  const searchSeq = useRef(0);
  const deepQuery = query.trim();
  useEffect(() => {
    const seq = ++searchSeq.current;
    if (deepQuery.length < SEARCH_MIN_QUERY) { setDeep(null); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(() => {
      searchDeep(deepQuery)
        .then((results) => {
          if (searchSeq.current !== seq) return; // a newer keystroke owns the pane now
          setDeep(results ? { forQuery: deepQuery, results } : null);
          setSearching(false);
        })
        .catch(() => { if (searchSeq.current === seq) { setDeep(null); setSearching(false); } });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [deepQuery, searchDeep]);

  const entries = useMemo<Entry[]>(() => {
    const l = layout ?? emptyLayout();
    const openIds = openItemIds(l);
    const byId = new Map(items.map((i) => [i.id, i]));
    const spaceName = (id: string) => spaces.find((sp) => sp.id === id)?.name ?? "";
    const focusedItemId = itemIdOfLeaf(l, focusedLeafId);
    const focusedItem = focusedItemId ? byId.get(focusedItemId) ?? null : null;
    const focusedSession = focusedItem?.kind === "session" ? focusedItem.refId : null;
    const focusedRunning = !!focusedSession && (sessionStatus[focusedSession] ?? sessions[focusedSession]?.status) === "running";
    const byRecency = (a: Item, b: Item) => b.updatedAt - a.updatedAt;

    const itemEntry = (it: Item, section: string, hint: ReactNode): Entry => ({
      id: `item:${it.id}`, label: it.title, hint, icon: <Icon name={it.kind} size={15} />, section,
      run: () => run(async () => {
        if (it.spaceId !== activeSpaceId) await selectSpace(it.spaceId);
        await openItem(it.id);
      }),
    });

    // Open panes of the active space, in layout order — the quadrant glyph tells duplicates apart (V-F4).
    const open = openIds.map((id) => byId.get(id)).filter((it): it is Item => !!it)
      .map((it) => itemEntry(it, "Open", <ItemGlyph layout={l} itemId={it.id} />));
    // The active space's remaining items, newest first.
    const activeRest = items.filter((it) => !openIds.includes(it.id)).sort(byRecency)
      .map((it) => itemEntry(it, spaceName(it.spaceId), <span>{relTime(it.updatedAt)}</span>));
    // Other spaces' items, grouped per space (strip order), newest first within each.
    const others = spaces.filter((sp) => sp.id !== activeSpaceId).flatMap((sp) =>
      allItems.filter((it) => it.spaceId === sp.id).sort(byRecency)
        .map((it) => itemEntry(it, sp.name, <span>{sp.name} · {relTime(it.updatedAt)}</span>)));

    const anyWaiting = Object.values(sessionStatus).includes("waiting_permission");
    const act = (id: string, label: string, icon: string, run_: () => void, hint?: ReactNode): Entry =>
      ({ id: `act:${id}`, label, icon: <Icon name={icon} size={15} />, run: run_, section: "Actions", hint });
    const actions: Entry[] = [
      // A pending permission anywhere leads the actions — it is the hottest thing in the app (U-H4).
      ...(anyWaiting ? [act("respond-permission", "Respond to pending permission", "alert", () => run(() => jumpToPermission()))] : []),
      // Built directly rather than via `act()`: a space's icon can be an emoji or a saved asset
      // (`parseSpaceIcon`), not just a Hugeicons name, so it needs `SpaceIcon`'s resolver — the same
      // reason the `item:` entries above bypass `act()` for `ItemGlyph`.
      ...spaces.map((sp): Entry => ({
        id: `act:space-${sp.id}`, label: `Switch to ${sp.name}`, icon: <SpaceIcon icon={sp.icon} size={15} />,
        run: () => run(() => selectSpace(sp.id)), section: "Actions", hint: sp.id === activeSpaceId ? "current" : undefined,
      })),
      act("new-terminal", "New terminal", "terminal", () => run(() => newTerminal()), <kbd>⌘T</kbd>),
      act("new-browser", "New browser", "browser", () => run(() => newBrowser())),
      // "Documents", not "New documents": one workspace per environment (the server dedupes), so this
      // is an open-or-focus, and calling it "New" would promise a second pane it will never create.
      act("open-documents", "Documents", "documents", () => run(() => openDocuments())),
      // No ellipsis and no sheet (W3): both this and the per-agent one-shots below go straight through
      // newSession — the only difference is whether the agent is named or inherited from last use.
      act("new-session", "New session", "session", () => run(() => newSessionInstant()), <kbd>⌘N</kbd>),
      act("new-session-worktree", "New session in a worktree", "branch", () => run(() => newSessionInWorktree())),
      // Dispatch (Plan 13 W2): the honest simple palette shape — it dispatches the FOCUSED session's
      // current draft, and with no draft to dispatch it is disabled and says what would arm it,
      // rather than pretending to a "focus the composer with a hint" flow the palette cannot honor
      // (picking an entry closes the palette; a hint nobody sees is not a hint).
      ...(focusedSession ? [{
        id: "act:dispatch", section: "Actions", icon: <Icon name="send" size={15} />,
        label: "Dispatch task", hint: (drafts[focusedSession] ?? "").trim() ? <kbd>⌘⇧↵</kbd> : "type a draft first",
        disabled: !(drafts[focusedSession] ?? "").trim(),
        run: () => run(() => dispatchDraft(focusedSession)),
      } as Entry] : []),
      ...SELECTABLE_AGENT_KINDS.map((a) => act(`new-${a}`, `New ${AGENT_META[a].label} session`, AGENT_META[a].icon, () => run(() => newSession({ agentKind: a })))),
      act("new-space", "New space…", "add", () => openSheet({ kind: "new-space" })),
      // A space is a PAGE (Plan 12 W3): this routes to the space-page pane, not a sheet.
      ...(activeSpaceId ? [act("open-space", "Open space", "settings", () => run(() => openSpacePage(activeSpaceId)))] : []),
      // The active space's PROFILE page (Plan 14 W2) — same gate: the page needs a layout to live in.
      ...(activeSpaceId ? [act("open-profile", "Open profile", "profile-page", () => run(() => openProfilePage()))] : []),
      // The sidebar destinations (W4) — gated like "Open space": the page needs a layout to live in.
      ...(activeSpaceId ? [
        act("open-library", "Open library", "library-page", () => run(() => openDestinationPage("library-page"))),
        act("open-connections", "Open connections", "connections-page", () => run(() => openDestinationPage("connections-page"))),
        act("open-notifications", "Open notifications", "notifications-page", () => run(() => openDestinationPage("notifications-page"))),
        act("open-settings", "Open settings", "settings-page", () => run(() => openDestinationPage("settings-page"))),
      ] : []),
      // Global (every space's calls, W7) — unlike the space page above, it never needs an activeSpaceId.
      act("mcp-activity", "MCP Activity", "tool", () => run(() => openActivity())),
      act("split-right", "Split right", "layout", () => run(() => splitFocused("row")), <kbd>⌘\</kbd>),
      act("split-down", "Split down", "layout", () => run(() => splitFocused("col")), <kbd>⌘⇧\</kbd>),
      ...(focusedItem ? [
        act("close-pane", "Close pane", "close", () => run(() => closeFromLayout(focusedItem.id)), <kbd>⌘W</kbd>),
        act("rename", `Rename “${focusedItem.title}”`, "edit", () => requestRename(focusedItem.id)),
      ] : []),
      ...(focusedRunning ? [act("interrupt", "Interrupt running session", "stop", () => run(() => interruptSession(focusedSession!)), <kbd>esc</kbd>)] : []),
      ...(activeSpaceId ? PRESETS.map((p) => act(`layout-${p}`, `Layout: ${PRESET_LABELS[p]}`, "layout", () => run(() => applyPreset(p)))) : []),
    ];

    const themes = THEMES.map<Entry>((t) => ({
      id: `theme:${t}`, label: `Theme: ${t[0]!.toUpperCase()}${t.slice(1)}`, hint: themePref === t ? "current" : undefined,
      icon: <Icon name={t === "dark" ? "moon" : "sun"} size={15} />, section: "Theme", run: () => run(() => setThemePref(t)),
    }));

    return [...open, ...activeRest, ...others, ...actions, ...themes];
  }, [spaces, activeSpaceId, items, allItems, layout, focusedLeafId, sessions, sessionStatus, themePref, drafts, dispatchDraft,
      selectSpace, openItem, newTerminal, newBrowser, openDocuments, newSession, newSessionInstant, newSessionInWorktree, splitFocused, closeFromLayout, requestRename,
      interruptSession, jumpToPermission, applyPreset, setThemePref, openSheet, openSpacePage, openDestinationPage, openProfilePage, openActivity, run]);

  // Empty query: everything, grouped under faint section headers. With a query: a flat list ranked
  // by match score (ties keep the sectioned order, so recency still breaks ties).
  const q = query.trim();
  const filtered = useMemo(() => {
    if (!q) return entries;
    return entries
      .map((e, i) => ({ e, i, score: matchScore(q, e.label) }))
      .filter((x): x is { e: Entry; i: number; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((x) => x.e);
  }, [entries, q]);

  // Deep rows (Plan 16 W2), grouped Sessions / Skills / Memory / Items and appended after the
  // instant rows. Item hits already matched instantly (subsequence matching subsumes word matching)
  // are dropped rather than shown twice.
  const deepEntries = useMemo<Entry[]>(() => {
    if (!q || !deep || deep.forQuery !== q) return [];
    const shown = new Set(filtered.map((e) => e.id));
    const r = deep.results;
    const out: Entry[] = [];
    for (const h of r.sessions) {
      out.push({
        id: `deep-session:${h.sessionId}:${h.seq}`, deep: true, section: "Sessions",
        label: h.title, icon: <Icon name="session" size={15} />, hint: <Snippet parts={h.snippet} />,
        // Jump = open the session (scroll-to-event is not cheap today: transcript block keys are
        // index-based, not seq-based — the hit's `seq` is on the wire for the day it becomes so).
        run: () => run(async () => {
          const it = allItems.find((x) => x.kind === "session" && x.refId === h.sessionId)
            ?? items.find((x) => x.kind === "session" && x.refId === h.sessionId);
          if (h.spaceId !== activeSpaceId) await selectSpace(h.spaceId);
          if (it) await openItem(it.id);
        }),
      });
    }
    for (const h of r.skills) {
      out.push({
        id: `deep-skill:${h.id}`, deep: true, section: "Skills", label: h.name,
        icon: <Icon name="library-page" size={15} />, hint: <Snippet parts={h.snippet} />,
        run: () => run(() => openDestinationPage("library-page")),
      });
    }
    for (const h of r.memory) {
      out.push({
        id: `deep-memory:${h.scope}:${h.spaceId ?? h.profileId}`, deep: true, section: "Memory", label: h.title,
        icon: <Icon name="context" size={15} />, hint: <Snippet parts={h.snippet} />,
        run: () => run(async () => {
          if (h.scope === "profile") { await openProfilePage("memory"); return; }
          if (!h.spaceId) return;
          if (h.spaceId !== activeSpaceId) await selectSpace(h.spaceId);
          await openSpacePage(h.spaceId, "memory");
        }),
      });
    }
    for (const h of r.items) {
      if (shown.has(`item:${h.itemId}`)) continue; // already an instant row above
      out.push({
        id: `deep-item:${h.itemId}`, deep: true, section: "Items", label: h.title,
        icon: <Icon name={h.itemKind} size={15} />, hint: <Snippet parts={h.snippet} />,
        run: () => run(async () => {
          if (h.spaceId !== activeSpaceId) await selectSpace(h.spaceId);
          await openItem(h.itemId);
        }),
      });
    }
    return out;
  }, [q, deep, filtered, allItems, items, activeSpaceId, selectSpace, openItem, openDestinationPage, openProfilePage, openSpacePage, run]);

  const combined = q ? [...filtered, ...deepEntries] : filtered;
  const sel = Math.min(index, Math.max(0, combined.length - 1));

  useEffect(() => { listRef.current?.querySelector<HTMLElement>(`[data-index="${sel}"]`)?.scrollIntoView?.({ block: "nearest" }); }, [sel]);

  const pick = (e: Entry | undefined) => { if (!e || e.disabled) return; e.run(); close(); };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIndex(Math.min(combined.length - 1, sel + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIndex(Math.max(0, sel - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(combined[sel]); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  };

  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="palette" role="dialog" aria-label="Command palette" style={paletteStyle}>
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input autoFocus role="combobox" aria-label="Command palette" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list"
            aria-activedescendant={combined[sel] ? `palette-opt-${sel}` : undefined}
            placeholder="Search…" value={query} onChange={(e) => { setQuery(e.target.value); setIndex(0); }} onKeyDown={onKeyDown} />
          <kbd>esc</kbd>
        </div>
        <div id="palette-list" ref={listRef} role="listbox" className="palette-list">
          {/* Honest quiet states: while a deep query is in flight an empty list says so; only a
              settled empty answer says "No matches". Instant rows render regardless, immediately. */}
          {combined.length === 0 && (searching
            ? <div className="palette-empty muted">Searching…</div>
            : <div className="palette-empty muted">No matches</div>)}
          {combined.map((e, i) => (
            <Fragment key={e.id}>
              {(!q || e.deep) && (i === 0 || combined[i - 1]!.section !== e.section) && (
                <div className="palette-sec" role="presentation">{e.section}</div>
              )}
              <div id={`palette-opt-${i}`} role="option" aria-selected={i === sel} aria-disabled={e.disabled || undefined} data-index={i}
                className={"palette-opt" + (i === sel ? " selected" : "") + (e.disabled ? " disabled" : "")}
                onMouseEnter={() => setIndex(i)} onMouseDown={(ev) => ev.preventDefault()} onClick={() => pick(e)}>
                <span className="palette-icon">{e.icon}</span><span className="palette-label">{e.label}</span>
                {e.hint && <span className="palette-hint">{e.hint}</span>}
              </div>
            </Fragment>
          ))}
          {searching && combined.length > 0 && <div className="palette-empty muted">Searching…</div>}
        </div>
      </div>
    </div>
  );
}
