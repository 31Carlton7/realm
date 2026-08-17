import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { StoreApi } from "zustand";
import { useApp, type AppState } from "../state/store";
import type { ThemePref } from "../theme/useTheme";

type Entry = { id: string; label: string; hint?: string; icon: ReactNode; run: () => void; disabled?: boolean };

/** ⌘K toggles the palette. Bind once at the app root. */
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

const THEMES: ThemePref[] = ["system", "light", "dark"];

/** Search across spaces, the active space's items, and a few actions. Case-insensitive substring match. */
export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  if (!open) return null;
  return <PaletteBody />;
}

function PaletteBody() {
  const spaces = useApp((s) => s.spaces);
  const activeSpaceId = useApp((s) => s.activeSpaceId);
  const items = useApp((s) => s.items);
  const themePref = useApp((s) => s.themePref);
  const selectSpace = useApp((s) => s.selectSpace);
  const activateTab = useApp((s) => s.activateTab);
  const newTerminal = useApp((s) => s.newTerminal);
  const setThemePref = useApp((s) => s.setThemePref);
  const openSheet = useApp((s) => s.openSheet);
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  const run = useApp((s) => s.run);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => setPaletteOpen(false);

  const entries = useMemo<Entry[]>(() => [
    ...spaces.map<Entry>((sp) => ({ id: `space:${sp.id}`, label: `Switch to ${sp.name}`, hint: sp.id === activeSpaceId ? "current" : "space", icon: <Icon name={sp.icon} size={15} />, run: () => run(() => selectSpace(sp.id)) })),
    ...items.map<Entry>((it) => ({ id: `item:${it.id}`, label: `Open ${it.title}`, hint: it.kind, icon: <Icon name={it.kind} size={15} />, run: () => run(() => activateTab(it.id)) })),
    { id: "act:new-terminal", label: "New terminal", hint: "action", icon: <Icon name="terminal" size={15} />, run: () => run(() => newTerminal()) },
    { id: "act:new-session", label: "New session…", hint: "soon", icon: <Icon name="session" size={15} />, run: () => {}, disabled: true },
    { id: "act:new-space", label: "New space…", hint: "action", icon: <Icon name="add" size={15} />, run: () => openSheet({ kind: "new-space" }) },
    ...(activeSpaceId ? [{ id: "act:space-settings", label: "Space settings…", hint: "action", icon: <Icon name="settings" size={15} />, run: () => openSheet({ kind: "space-settings", spaceId: activeSpaceId }) }] : []),
    ...THEMES.map<Entry>((t) => ({ id: `theme:${t}`, label: `Theme: ${t[0]!.toUpperCase()}${t.slice(1)}`, hint: themePref === t ? "current" : "theme", icon: <Icon name={t === "dark" ? "moon" : "sun"} size={15} />, run: () => run(() => setThemePref(t)) })),
  ], [spaces, items, activeSpaceId, themePref, selectSpace, activateTab, newTerminal, setThemePref, openSheet, run]);

  const q = query.trim().toLowerCase();
  const filtered = q ? entries.filter((e) => e.label.toLowerCase().includes(q)) : entries;
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
          <input autoFocus role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list"
            aria-activedescendant={filtered[sel] ? `palette-opt-${sel}` : undefined}
            placeholder="Ask or search…" value={query} onChange={(e) => { setQuery(e.target.value); setIndex(0); }} onKeyDown={onKeyDown} />
          <kbd>esc</kbd>
        </div>
        <div id="palette-list" ref={listRef} role="listbox" className="palette-list">
          {filtered.length === 0 && <div className="palette-empty muted">No matches</div>}
          {filtered.map((e, i) => (
            <div key={e.id} id={`palette-opt-${i}`} role="option" aria-selected={i === sel} aria-disabled={e.disabled || undefined} data-index={i}
              className={"palette-opt" + (i === sel ? " selected" : "") + (e.disabled ? " disabled" : "")}
              onMouseEnter={() => setIndex(i)} onMouseDown={(ev) => ev.preventDefault()} onClick={() => pick(e)}>
              <span className="palette-icon">{e.icon}</span><span className="palette-label">{e.label}</span>
              {e.hint && <span className="palette-hint">{e.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
