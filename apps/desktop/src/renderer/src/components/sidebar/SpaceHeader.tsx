import { Icon } from "@realm/ui";
import { useCallback, useRef, useState } from "react";
import type { Space } from "@realm/contracts";
import { useApp } from "../../state/store";
import { Menu } from "../Menu";
import type { ThemePref } from "../../theme/useTheme";

const THEMES: { pref: ThemePref; label: string }[] = [{ pref: "system", label: "System" }, { pref: "light", label: "Light" }, { pref: "dark", label: "Dark" }];

export function SpaceHeader({ space }: { space: Space }) {
  const profile = useApp((s) => s.profiles.find((p) => p.id === space.profileId));
  const themePref = useApp((s) => s.themePref);
  const setThemePref = useApp((s) => s.setThemePref);
  const swipeInvert = useApp((s) => s.swipeInvert);
  const setSwipeInvert = useApp((s) => s.setSwipeInvert);
  const openSheet = useApp((s) => s.openSheet);
  const newTerminal = useApp((s) => s.newTerminal);
  const newSessionInWorktree = useApp((s) => s.newSessionInWorktree);
  const run = useApp((s) => s.run);
  const [menu, setMenu] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenu(false), []);
  const openSettings = () => openSheet({ kind: "space-settings", spaceId: space.id });
  return (
    <div className="space-header">
      <h2><Icon name={space.icon} size={16} /><span className="space-name">{space.name}</span></h2>
      <div className="space-header-actions">
        {profile && <button className="pill" title="Space settings" onClick={openSettings}>{profile.name}</button>}
        <button ref={btnRef} className="icon-btn" aria-label="Space menu" aria-haspopup="menu" aria-expanded={menu}
          title="More" onClick={() => setMenu((o) => !o)}><Icon name="more" size={15} /></button>
        {menu && (
          <Menu align="right" anchorRef={btnRef} label="Space menu" onClose={closeMenu} items={[
              { label: "Space settings…", onSelect: openSettings },
              { label: "New terminal", onSelect: () => run(() => newTerminal()) },
              // Not on "+"/⌘N: those stay the no-questions path (W3). A worktree is a
              // deliberate choice — it makes a branch — so it lives behind the menu.
              { label: "New session in a worktree", onSelect: () => run(() => newSessionInWorktree()) },
              { kind: "separator" },
              ...THEMES.map((t) => ({ label: `Theme: ${t.label}`, checked: themePref === t.pref, onSelect: () => run(() => setThemePref(t.pref)) })),
              { kind: "separator" as const },
              { label: "Invert swipe direction", checked: swipeInvert, onSelect: () => run(() => setSwipeInvert(!swipeInvert)) },
          ]} />
        )}
      </div>
    </div>
  );
}
