import { Icon } from "@realm/ui";
import { AGENT_META, PRESETS, SELECTABLE_AGENT_KINDS, emptyLayout, itemIdOfLeaf, allItems as openItemIds, type Item, type PresetName } from "@realm/contracts";
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { StoreApi } from "zustand";
import { useApp, type AppState } from "../state/store";
import type { ThemePref } from "../theme/useTheme";
import { ItemGlyph } from "./sidebar/ItemList";

type Entry = { id: string; label: string; hint?: ReactNode; icon: ReactNode; run: () => void; section: string; disabled?: boolean };

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
  const newSession = useApp((s) => s.newSession);
  const newSessionInstant = useApp((s) => s.newSessionInstant);
  const splitFocused = useApp((s) => s.splitFocused);
  const closeFromLayout = useApp((s) => s.closeFromLayout);
  const requestRename = useApp((s) => s.requestRename);
  const interruptSession = useApp((s) => s.interruptSession);
  const jumpToPermission = useApp((s) => s.jumpToPermission);
  const applyPreset = useApp((s) => s.applyPreset);
  const setThemePref = useApp((s) => s.setThemePref);
  const openSheet = useApp((s) => s.openSheet);
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  const refreshAllItems = useApp((s) => s.refreshAllItems);
  const run = useApp((s) => s.run);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => setPaletteOpen(false);

  // Cross-space listings come from items.listAll; refresh on every open so ages/titles are current.
  useEffect(() => { run(() => refreshAllItems()); }, [refreshAllItems, run]);

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
      ...spaces.map((sp) => act(`space-${sp.id}`, `Switch to ${sp.name}`, sp.icon, () => run(() => selectSpace(sp.id)), sp.id === activeSpaceId ? "current" : undefined)),
      act("new-terminal", "New terminal", "terminal", () => run(() => newTerminal()), <kbd>⌘T</kbd>),
      // No ellipsis and no sheet (W3): both this and the per-agent one-shots below go straight through
      // newSession — the only difference is whether the agent is named or inherited from last use.
      act("new-session", "New session", "session", () => run(() => newSessionInstant()), <kbd>⌘N</kbd>),
      ...SELECTABLE_AGENT_KINDS.map((a) => act(`new-${a}`, `New ${AGENT_META[a].label} session`, AGENT_META[a].icon, () => run(() => newSession({ agentKind: a })))),
      act("new-space", "New space…", "add", () => openSheet({ kind: "new-space" })),
      ...(activeSpaceId ? [act("space-settings", "Space settings…", "settings", () => openSheet({ kind: "space-settings", spaceId: activeSpaceId }))] : []),
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
  }, [spaces, activeSpaceId, items, allItems, layout, focusedLeafId, sessions, sessionStatus, themePref,
      selectSpace, openItem, newTerminal, newSession, newSessionInstant, splitFocused, closeFromLayout, requestRename,
      interruptSession, jumpToPermission, applyPreset, setThemePref, openSheet, run]);

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
  const sel = Math.min(index, Math.max(0, filtered.length - 1));

  useEffect(() => { listRef.current?.querySelector<HTMLElement>(`[data-index="${sel}"]`)?.scrollIntoView?.({ block: "nearest" }); }, [sel]);

  const pick = (e: Entry | undefined) => { if (!e || e.disabled) return; e.run(); close(); };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIndex(Math.min(filtered.length - 1, sel + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIndex(Math.max(0, sel - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(filtered[sel]); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  };

  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input autoFocus role="combobox" aria-label="Command palette" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list"
            aria-activedescendant={filtered[sel] ? `palette-opt-${sel}` : undefined}
            placeholder="Search…" value={query} onChange={(e) => { setQuery(e.target.value); setIndex(0); }} onKeyDown={onKeyDown} />
          <kbd>esc</kbd>
        </div>
        <div id="palette-list" ref={listRef} role="listbox" className="palette-list">
          {filtered.length === 0 && <div className="palette-empty muted">No matches</div>}
          {filtered.map((e, i) => (
            <Fragment key={e.id}>
              {!q && (i === 0 || filtered[i - 1]!.section !== e.section) && (
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
        </div>
      </div>
    </div>
  );
}
