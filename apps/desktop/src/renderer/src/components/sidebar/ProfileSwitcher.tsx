import { Icon } from "@realm/ui";
import { useRef, useState } from "react";
import { useApp } from "../../state/store";
import { Menu } from "../Menu";
import { profileWaiting } from "./model";
import { useSidebarState } from "./use-sidebar-model";

/**
 * The profile, at the head of the sidebar: its mark and name, opening the menu of profiles (Plan 27).
 *
 * Switching profile is rare and deliberate — Personal, Work, School — so it lives in one place, the
 * way Codex, Linear and Slack put it. The menu says what waits in each OTHER profile ("Work · 2 need
 * you"), so nothing waits unseen because it is in a profile you are not looking at.
 *
 * A profile with no spaces is listed but not selectable: `selectProfile` has nothing to land on, and
 * an offer that silently does nothing is worse than a disabled one that says why.
 */
export function ProfileSwitcher() {
  const state = useSidebarState();
  const activeProfileId = useApp((s) => s.activeProfileId());
  const selectProfile = useApp((s) => s.selectProfile);
  const openProfilePage = useApp((s) => s.openProfilePage);
  const openSheet = useApp((s) => s.openSheet);
  const setSpacesOpen = useApp((s) => s.setSpacesOpen);
  const run = useApp((s) => s.run);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const { profiles, spaces } = state;
  const active = profiles.find((p) => p.id === activeProfileId);
  const spaceCount = (id: string) => spaces.filter((sp) => sp.profileId === id).length;
  const label = (id: string, name: string): string => {
    if (spaceCount(id) === 0) return `${name} (no spaces)`;
    if (id === activeProfileId) return name;
    const n = profileWaiting(state, id);
    return n === 0 ? name : `${name} · ${n} ${n === 1 ? "needs" : "need"} you`;
  };
  return (
    <>
      <button ref={anchor} type="button" className="sb-profile" aria-haspopup="menu" aria-expanded={open}
        aria-label={active ? `Profile: ${active.name}` : "Profiles"} title="Switch profile"
        disabled={profiles.length === 0} onClick={() => setOpen((o) => !o)}>
        <span className="sb-profile-mark" style={active ? { color: active.color } : undefined}>
          <Icon name={active?.icon ?? "user"} size={16} />
        </span>
        <span className="sb-profile-name">{active?.name ?? "Profiles"}</span>
        <Icon name="chevronDown" size={12} className="sb-profile-caret" />
      </button>
      {open && (
        <Menu align="left" anchorRef={anchor} label="Profiles" onClose={() => setOpen(false)} items={[
          ...profiles.map((p) => ({
            label: label(p.id, p.name),
            // Each profile wears its own mark in its own colour, and every row reserves the slot.
            icon: <span className="sb-profile-mark" style={{ color: p.color }}><Icon name={p.icon || "user"} size={16} /></span>,
            checked: p.id === activeProfileId,
            disabled: spaceCount(p.id) === 0,
            onSelect: () => run(() => selectProfile(p.id)),
          })),
          { kind: "separator" as const },
          { label: "All spaces…", icon: <Icon name="layout" size={16} />, kbd: "⌘⇧Space", onSelect: () => setSpacesOpen(true) },
          { kind: "separator" as const },
          { label: "Profile settings…", icon: <Icon name="profile-page" size={16} />, onSelect: () => openProfilePage() },
          // Plan 27: the profiles helper's own sheet once it lands — today a profile is made in New space.
          { label: "New profile…", icon: <Icon name="add" size={16} />, onSelect: () => openSheet({ kind: "new-space" }) },
        ]} />
      )}
    </>
  );
}
