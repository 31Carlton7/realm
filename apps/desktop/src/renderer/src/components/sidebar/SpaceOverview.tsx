import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { StoreApi } from "zustand";
import { spaceBadge, useApp, type AppState } from "../../state/store";
import { SpaceIcon } from "../SpaceIcon";

/** The grid is a fixed three columns (see `.spaces-grid`), so ↑/↓ can step by a known stride instead
 *  of measuring a layout jsdom does not have. Change one and change the other. */
const COLUMNS = 3;

const BADGE_LABEL = { running: "agent running", waiting_permission: "agent needs permission", error: "agent error" } as const;

/**
 * ⌘⇧Space, and the profile chip's "All spaces…". Kept out of hotkeys.ts's BINDINGS for the same
 * reason ⌘K is: it must toggle while the overview is open, which that guard forbids. A modal sheet
 * still wins — it owns the keyboard outright.
 */
export function useSpacesHotkey(store: StoreApi<AppState>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !e.shiftKey || !(e.metaKey || e.ctrlKey) || e.altKey) return;
      e.preventDefault();
      const s = store.getState();
      if (s.sheet) return;
      s.setSpacesOpen(!s.spacesOpen);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);
}

export function SpaceOverview() {
  const open = useApp((s) => s.spacesOpen);
  if (!open) return null;
  return <OverviewBody />;
}

/**
 * Every space in the home at once, sectioned by profile, WITH ITS NAME.
 *
 * This is the half of the design the strip deliberately gave up. A rail of 16px glyphs is a good
 * switcher for the handful you are living in and a bad index of everything you own — you cannot read
 * it, and past six it does not even fit. So the strip keeps the handful and this keeps the rest:
 * names, profile headings, live agent badges, and a filter for when even the grid is a list.
 *
 * Picking a space from another profile switches profile implicitly — `selectSpace` is the whole act,
 * and `lastSpaceByProfile` records it, so the chip's "back to where I was" is true afterwards.
 */
function OverviewBody() {
  const profiles = useApp((s) => s.profiles);
  const spaces = useApp((s) => s.spaces);
  const activeSpaceId = useApp((s) => s.activeSpaceId);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const sessionSpace = useApp((s) => s.sessionSpace);
  const selectSpace = useApp((s) => s.selectSpace);
  const setSpacesOpen = useApp((s) => s.setSpacesOpen);
  const openSheet = useApp((s) => s.openSheet);
  const run = useApp((s) => s.run);
  const [query, setQuery] = useState("");
  // null = "wherever the active space is" — the resting state, and what the overview opens on. Only
  // an arrow key or a hover pins it to a number, so a filter that removes the active space cannot
  // strand a stale index.
  const [cursor, setCursor] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const q = query.trim().toLowerCase();
  // Sections follow the profile list's own order; a profile with nothing left after the filter drops
  // out entirely rather than showing an empty heading.
  const sections = useMemo(() => {
    const match = (name: string) => !q || name.toLowerCase().includes(q);
    return profiles
      .map((p) => ({ profile: p, spaces: spaces.filter((s) => s.profileId === p.id && (match(s.name) || match(p.name))) }))
      .filter((sec) => sec.spaces.length > 0);
  }, [profiles, spaces, q]);
  // The flat reading order the arrow keys walk — the same order the sections render in.
  const flat = useMemo(() => sections.flatMap((sec) => sec.spaces.map((s) => s.id)), [sections]);

  const index = Math.min(
    Math.max(0, flat.length - 1),
    Math.max(0, cursor ?? flat.indexOf(activeSpaceId ?? "")),
  );

  const close = () => setSpacesOpen(false);
  const choose = (id: string) => { close(); run(() => selectSpace(id)); };
  const move = (delta: number) => { if (flat.length > 0) setCursor(Math.min(flat.length - 1, Math.max(0, index + delta))); };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); move(-1); }
    else if (e.key === "ArrowDown") { e.preventDefault(); move(COLUMNS); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-COLUMNS); }
    else if (e.key === "Enter") { e.preventDefault(); const id = flat[index]; if (id) choose(id); }
  };

  return (
    <div className="spaces-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="spaces-overview" role="dialog" aria-modal="true" aria-label="All spaces" onKeyDown={onKeyDown}>
        <div className="spaces-search">
          <Icon name="search" size={15} />
          <input ref={inputRef} value={query} onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
            placeholder="Filter spaces" aria-label="Filter spaces" spellCheck={false} />
          <kbd>esc</kbd>
        </div>
        <div className="spaces-list">
          {sections.map((sec) => (
            <section key={sec.profile.id} className="spaces-section">
              <h3 className="spaces-section-head">
                <span className="spaces-section-dot" style={{ background: sec.profile.color }} aria-hidden="true" />
                <span>{sec.profile.name}</span>
                <span className="spaces-section-count">{sec.spaces.length}</span>
              </h3>
              <div className="spaces-grid">
                {sec.spaces.map((sp) => {
                  const badge = spaceBadge(sessionStatus, sessionSpace, sp.id);
                  return (
                    <button key={sp.id} className="space-card" aria-label={`Switch to space ${sp.name}`}
                      aria-current={sp.id === activeSpaceId || undefined}
                      data-current={sp.id === activeSpaceId || undefined}
                      data-cursor={flat[index] === sp.id || undefined}
                      onMouseEnter={() => setCursor(flat.indexOf(sp.id))}
                      onClick={() => choose(sp.id)}>
                      <span className="space-card-icon" style={{ color: sp.color }}><SpaceIcon icon={sp.icon} size={20} /></span>
                      <span className="space-card-name">{sp.name}</span>
                      {badge && <span className="strip-badge space-card-badge" data-status={badge} role="status" aria-label={`${sp.name}: ${BADGE_LABEL[badge]}`} />}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          {flat.length === 0 && <div className="spaces-empty muted">No space matches “{query.trim()}”</div>}
        </div>
        <div className="spaces-foot">
          <button className="ghost-chip" onClick={() => openSheet({ kind: "new-space" })}>
            <Icon name="add" size={13} /><span>New space</span>
          </button>
          <span className="spaces-foot-hint muted">↑↓←→ to move · ↵ to switch</span>
        </div>
      </div>
    </div>
  );
}
