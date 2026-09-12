import { Icon, THEMES, themeModes } from "@realm/ui";
import { useCallback, useRef, useState } from "react";
import { useApp } from "../../state/store";
import { Menu } from "../Menu";
import { SpaceIcon } from "../SpaceIcon";
import { useResolvedMode, type ThemePref } from "../../theme/useTheme";

const MODES: { pref: ThemePref; label: string }[] = [{ pref: "system", label: "System" }, { pref: "light", label: "Light" }, { pref: "dark", label: "Dark" }];

/**
 * The column's heading: which space you are in, whose profile it belongs to, and its menu.
 *
 * It reads the ACTIVE space itself rather than taking one, because it heads the sidebar now instead
 * of riding inside each page of the swiper — there is one of these, for wherever you currently are.
 * Null before boot, and only then: every space has a profile and there is always an active space
 * once there is a space at all.
 */
export function SpaceHeader() {
  const space = useApp((s) => s.activeSpace());
  const spaces = useApp((s) => s.spaces);
  const selectSpace = useApp((s) => s.selectSpace);
  const profile = useApp((s) => s.profiles.find((p) => p.id === space?.profileId));
  const themePref = useApp((s) => s.themePref);
  const setThemePref = useApp((s) => s.setThemePref);
  const themeNames = useApp((s) => s.themeNames);
  const setThemeName = useApp((s) => s.setThemeName);
  const swipeInvert = useApp((s) => s.swipeInvert);
  const setSwipeInvert = useApp((s) => s.setSwipeInvert);
  const openSpacePage = useApp((s) => s.openSpacePage);
  const openProfilePage = useApp((s) => s.openProfilePage);
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  const newTerminal = useApp((s) => s.newTerminal);
  const newSessionInWorktree = useApp((s) => s.newSessionInWorktree);
  const run = useApp((s) => s.run);
  const mode = useResolvedMode(themePref);
  const [menu, setMenu] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const switchRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenu(false), []);
  const closeSwitcher = useCallback(() => setSwitcher(false), []);
  /* Every hook is above this line: an early return with hooks under it renders a different number
     of them once a space arrives, which React answers by throwing. */
  if (!space) return null;
  // A space is a PAGE (Plan 12 W3): every path that used to open the settings sheet lands there.
  const openPage = () => openSpacePage(space.id);
  return (
    <div className="space-header">
      <h2><button type="button" className="space-title" title="Open space" onClick={openPage}>
        <SpaceIcon icon={space.icon} size={18} /><span className="space-name">{space.name}</span>
      </button>
      {/* Its OWN control, not the title's chevron: the title opens the space page and has since Plan
          12, and quietly turning that click into a switcher would move a door somebody already knows
          where to find. Beside the name rather than out with the ⋯ actions, because it belongs to the
          name — it is what the name can be changed to. */}
      <button ref={switchRef} type="button" className="space-switch" aria-label="Switch space"
        aria-haspopup="menu" aria-expanded={switcher} title="Switch space"
        onClick={() => setSwitcher((o) => !o)}><Icon name="chevronDown" size={12} /></button></h2>
      {switcher && (
        <Menu align="left" anchorRef={switchRef} label="Spaces" onClose={closeSwitcher} items={spaces.map((sp) => ({
          label: sp.name,
          // Each space wears its own icon, which is the thing people actually recognise a space by —
          // `MenuItem.icon` reserves one slot for every row as soon as any row asks, so the names
          // stay on one left edge.
          icon: <SpaceIcon icon={sp.icon} size={16} />,
          // A check on the one you are in rather than omitting it: a switcher that hides the current
          // space is a list you cannot find yourself in.
          checked: sp.id === space.id,
          // Already here is not a no-op worth a reload — `selectSpace` refetches a space's whole
          // item list, and doing that to land where you already are is a flash for nothing.
          onSelect: () => { if (sp.id !== space.id) run(() => selectSpace(sp.id)); },
        }))} />
      )}
      <div className="space-header-actions">
        {/* The pill NAMES the profile, so it opens the profile page (Plan 14 W2) — it used to be a
            second door to the space page, which the title button beside it already is. */}
        {profile && <button className="pill" title="Open profile" onClick={() => openProfilePage()}>{profile.name}</button>}
        {/* Search, as a glyph. It was a full-width button reading "Search… ⌘K" under this row: a
            control the height of a field, standing in for a palette that is one keystroke away and
            that most people reach by that keystroke. The glyph keeps the click for anyone who wants
            it and gives the column back a row of its height. The shortcut moves to the tooltip,
            where a hint that never changes belongs. */}
        <button className="icon-btn" aria-label="Search" title="Search (⌘K)" onClick={() => setPaletteOpen(true)}><Icon name="search" size={14} /></button>
        <button ref={btnRef} className="icon-btn" aria-label="Space menu" aria-haspopup="menu" aria-expanded={menu}
          title="More" onClick={() => setMenu((o) => !o)}><Icon name="more" size={14} /></button>
        {menu && (
          <Menu align="right" anchorRef={btnRef} label="Space menu" onClose={closeMenu} items={[
              { label: "Open space", onSelect: openPage },
              { label: "New terminal", onSelect: () => run(() => newTerminal()) },
              // Not on "+"/⌘N: those stay the no-questions path (W3). A worktree is a
              // deliberate choice — it makes a branch — so it lives behind the menu.
              { label: "New session in a worktree", onSelect: () => run(() => newSessionInWorktree()) },
              { kind: "separator" },
              ...MODES.map((t) => ({ label: `Theme: ${t.label}`, checked: themePref === t.pref, onSelect: () => run(() => setThemePref(t.pref)) })),
              { kind: "separator" as const },
              // The face on screen, like ⌘K: this menu sits beside the window it repaints.
              ...THEMES.filter((t) => themeModes(t.name).includes(mode)).map((t) => ({ label: `Palette: ${t.label}`, checked: themeNames[mode] === t.name, onSelect: () => run(() => setThemeName(mode, t.name)) })),
              { kind: "separator" as const },
              { label: "Invert swipe direction", checked: swipeInvert, onSelect: () => run(() => setSwipeInvert(!swipeInvert)) },
          ]} />
        )}
      </div>
    </div>
  );
}
