import { Icon } from "@realm/ui";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { spaceBadge, useApp, useProfileSpaces } from "../../state/store";
import { Menu } from "../Menu";
import { SpaceIcon } from "../SpaceIcon";

const BADGE_LABEL = { running: "agent running", waiting_permission: "agent needs permission", error: "agent error" } as const;

/**
 * Bottom bar: the profile chip (left), one icon button per space IN THAT PROFILE (center, drag to
 * reorder), + new space (right).
 *
 * The strip used to hold every space in the home, which is a list with no ceiling in a 280px sidebar:
 * ~192px of usable width at 32px a space is six slots, and past that the spaces went behind a hidden
 * scrollbar with nothing on screen saying so. Profile is the separator because it is the one the data
 * model already has — every Space carries a profileId — so scoping costs no new concept and splits
 * along the boundary that already means something (work vs school vs personal).
 *
 * Everything past one profile lives in two places instead: the chip's menu (switch profile) and the
 * space overview (⌘⇧Space — every space, every profile, with names). The strip is a rail for the
 * profile you are in, not an index of everything you own.
 */
export function SpaceStrip() {
  const spaces = useApp((s) => s.spaces);
  const stripSpaces = useProfileSpaces();
  const activeSpaceId = useApp((s) => s.activeSpaceId);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const sessionSpace = useApp((s) => s.sessionSpace);
  const selectSpace = useApp((s) => s.selectSpace);
  const reorderSpaces = useApp((s) => s.reorderSpaces);
  const openSheet = useApp((s) => s.openSheet);
  const run = useApp((s) => s.run);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // Even scoped to one profile a strip can overflow; keep the active space reachable/visible on every
  // activation (safe-centered flex can clip either end, and the scrollbar is hidden).
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { activeRef.current?.scrollIntoView?.({ inline: "nearest", block: "nearest" }); }, [activeSpaceId]);

  const drop = (targetId: string) => {
    const from = dragId; setDragId(null); setOverId(null);
    if (!from || from === targetId) return;
    const within = stripSpaces.map((s) => s.id);
    const fromIdx = within.indexOf(from), toIdx = within.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    // Drop takes the target's slot: before it when dragging left, after it when dragging right.
    within.splice(fromIdx, 1); within.splice(toIdx, 0, from);
    // `reorderSpaces` takes the whole home's order, and the strip only ever reordered part of it.
    // Rewriting THIS profile's slots in place (rather than concatenating its spaces onto the front)
    // is what keeps a drag in one profile from silently resequencing every other one.
    const scoped = new Set(within);
    let n = 0;
    const ids = spaces.map((s) => (scoped.has(s.id) ? within[n++]! : s.id));
    run(() => reorderSpaces(ids));
  };
  const onDragOver = (id: string) => (e: DragEvent) => { if (dragId) { e.preventDefault(); if (overId !== id) setOverId(id); } };

  return (
    <div className="space-strip">
      <ProfileChip />
      <div className="strip-spaces" aria-label="Spaces">
        {stripSpaces.map((sp) => {
          const badge = spaceBadge(sessionStatus, sessionSpace, sp.id);
          return (
          <button key={sp.id} ref={sp.id === activeSpaceId ? activeRef : null} className="strip-space" aria-pressed={sp.id === activeSpaceId} aria-label={`Switch to space ${sp.name}`} title={sp.name}
            data-active={sp.id === activeSpaceId || undefined} data-drag-over={overId === sp.id || undefined}
            draggable onDragStart={(e) => { setDragId(sp.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", sp.id); }}
            onDragOver={onDragOver(sp.id)} onDragLeave={() => { if (overId === sp.id) setOverId(null); }}
            onDrop={(e) => { e.preventDefault(); drop(sp.id); }} onDragEnd={() => { setDragId(null); setOverId(null); }}
            onClick={() => run(() => selectSpace(sp.id))}>
            <SpaceIcon icon={sp.icon} size={16} />
            {badge && <span className="strip-badge" data-status={badge} role="status" aria-label={`${sp.name}: ${BADGE_LABEL[badge]}`} />}
          </button>
          );
        })}
      </div>
      <button className="icon-btn strip-side" aria-label="New space" title="New space" onClick={() => openSheet({ kind: "new-space" })}><Icon name="add" size={16} /></button>
    </div>
  );
}

/**
 * The left slot: which profile the strip is showing, and the two ways out of it — switch profile, or
 * open the overview. It replaced the settings gear, which was app-level chrome parked in a rail whose
 * whole subject is spaces; Settings is a destination row now, beside Library and Connections.
 *
 * One 30px square, the profile's own icon in the profile's own colour — NOT the name. Spelling it out
 * cost about two space slots, and the strip has no slots to give: the space header directly above
 * already carries a pill naming the profile, so a second copy bought nothing and pushed the sixth
 * space off the end. The name is still one hover (title) or one click (the menu, where the check
 * marks it) away.
 *
 * A profile with no spaces is listed but not selectable: `selectProfile` has nothing to land on, and
 * an offer that silently does nothing is worse than a disabled one that says why.
 */
function ProfileChip() {
  const profiles = useApp((s) => s.profiles);
  const spaces = useApp((s) => s.spaces);
  const activeProfileId = useApp((s) => s.activeProfileId());
  const selectProfile = useApp((s) => s.selectProfile);
  const setSpacesOpen = useApp((s) => s.setSpacesOpen);
  const run = useApp((s) => s.run);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const active = profiles.find((p) => p.id === activeProfileId);
  const count = (id: string) => spaces.filter((s) => s.profileId === id).length;
  return (
    <>
      <button ref={btnRef} className="strip-profile strip-side" aria-haspopup="menu" aria-expanded={open}
        aria-label={active ? `Profile: ${active.name}` : "Profiles"} title={active ? `${active.name} — switch profile` : "Profiles"}
        style={active ? { color: active.color } : undefined}
        disabled={profiles.length === 0} onClick={() => setOpen((o) => !o)}>
        <Icon name={active?.icon ?? "user"} size={16} />
      </button>
      {open && (
        <Menu align="left" placement="up" anchorRef={btnRef} label="Profiles" onClose={() => setOpen(false)} items={[
          ...profiles.map((p) => ({
            label: `${p.name}${count(p.id) ? "" : " (empty)"}`,
            checked: p.id === activeProfileId,
            disabled: count(p.id) === 0,
            onSelect: () => run(() => selectProfile(p.id)),
          })),
          { kind: "separator" as const },
          { label: "All spaces…", kbd: "⌘⇧Space", onSelect: () => setSpacesOpen(true) },
        ]} />
      )}
    </>
  );
}
