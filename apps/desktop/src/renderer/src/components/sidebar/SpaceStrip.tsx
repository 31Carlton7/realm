import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState, type DragEvent, type RefObject } from "react";
import { spaceActivity, spaceBadge, useApp, useProfileSpaces } from "../../state/store";
import { createSpring } from "../../state/spring";
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
 *
 * Drag-to-reorder is the default order; Settings ▸ Sidebar's "Sort by activity" swaps in a computed
 * one instead (`spaceActivity`: a space with something waiting on you first, then whichever moved
 * most recently) without touching the dragged order underneath, and turns dragging off for as long
 * as it is on — a drop into a spot the next status change would re-sort away from is a drop that did
 * nothing.
 */
export function SpaceStrip() {
  const spaces = useApp((s) => s.spaces);
  const stripSpaces = useProfileSpaces();
  const activeSpaceId = useApp((s) => s.activeSpaceId);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const sessionSpace = useApp((s) => s.sessionSpace);
  const sessionUpdatedAt = useApp((s) => s.sessionUpdatedAt);
  const activityOrder = useApp((s) => s.sidebarActivityOrder);
  const selectSpace = useApp((s) => s.selectSpace);
  const reorderSpaces = useApp((s) => s.reorderSpaces);
  const openSheet = useApp((s) => s.openSheet);
  const run = useApp((s) => s.run);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  /* A SORTED COPY, never a rewrite of `spaces`/`sort_order`: the setting is a lens on the strip, the
     same way `sidebarView` is a lens on the column above it, and turning it back off has to land on
     the order you dragged, undisturbed, not on whatever activity had put it there last. */
  const ordered = useMemo(() => {
    if (!activityOrder) return stripSpaces;
    return [...stripSpaces].sort((a, b) =>
      spaceActivity(sessionStatus, sessionSpace, sessionUpdatedAt, b.id) - spaceActivity(sessionStatus, sessionSpace, sessionUpdatedAt, a.id));
  }, [stripSpaces, activityOrder, sessionStatus, sessionSpace, sessionUpdatedAt]);
  // Even scoped to one profile a strip can overflow; keep the active space reachable/visible on every
  // activation (safe-centered flex can clip either end, and the scrollbar is hidden).
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  useScrollTo(railRef, activeRef, activeSpaceId);

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
      <div className="strip-spaces" aria-label="Spaces" ref={railRef}>
        {ordered.map((sp) => {
          const badge = spaceBadge(sessionStatus, sessionSpace, sp.id);
          return (
          <button key={sp.id} ref={sp.id === activeSpaceId ? activeRef : null} className="strip-space" aria-pressed={sp.id === activeSpaceId} aria-label={`Switch to space ${sp.name}`}
            title={activityOrder ? `${sp.name} — sorted by activity; drag to reorder is off while this is on` : sp.name}
            data-active={sp.id === activeSpaceId || undefined} data-drag-over={overId === sp.id || undefined}
            // Dragging into an explicit position is pointless the moment the strip re-sorts itself on
            // the next status change — worse than pointless, since the drop would look like it did
            // nothing. The setting owns the order while it's on; the drag handle returns with it off.
            draggable={!activityOrder}
            onDragStart={(e) => { setDragId(sp.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", sp.id); }}
            onDragOver={onDragOver(sp.id)} onDragLeave={() => { if (overId === sp.id) setOverId(null); }}
            onDrop={(e) => { e.preventDefault(); drop(sp.id); }} onDragEnd={() => { setDragId(null); setOverId(null); }}
            onClick={() => run(() => selectSpace(sp.id))}>
            <SpaceIcon icon={sp.icon} size={16} />
            {badge && <span className="strip-badge" data-status={badge} role="status" aria-label={`${sp.name}: ${BADGE_LABEL[badge]}`} />}
          </button>
          );
        })}
      </div>
      <button className="icon-btn strip-side" aria-label="New space" title="New space" onClick={() => openSheet({ kind: "new-space" })}><Icon name="add" size={14} /></button>
    </div>
  );
}


/**
 * Bring the active space into view, on the same spring everything else in the sidebar moves on.
 *
 * It was `scrollIntoView`, which teleports: the row of spaces was in one place and then it was in
 * another, with nothing in between to say which way it went — and on a strip where every icon is the
 * same 30px square, a jump is genuinely disorienting because there is no landmark to track.
 *
 * Three things make it feel like the app rather than like a scroll API. It moves the LEAST it can
 * (`nearest`, plus a chip's width of air so the neighbour shows and the strip reads as continuing);
 * it does nothing at all when the space is already comfortably in view, because chrome that shifts
 * for no reason is worse than chrome that does not move; and the user wins — one touch of the
 * trackpad abandons the animation where it stands rather than fighting it back.
 */
function useScrollTo(rail: RefObject<HTMLDivElement | null>, active: RefObject<HTMLButtonElement | null>, key: string | null) {
  useEffect(() => {
    const box = rail.current, el = active.current;
    if (!box || !el || box.scrollWidth <= box.clientWidth) return;
    const margin = el.clientWidth || 30;
    const left = el.offsetLeft - margin;
    const right = el.offsetLeft + el.offsetWidth + margin;
    const target = Math.max(0, Math.min(
      box.scrollWidth - box.clientWidth,
      right > box.scrollLeft + box.clientWidth ? right - box.clientWidth : left < box.scrollLeft ? left : box.scrollLeft,
    ));
    if (Math.abs(target - box.scrollLeft) < 1) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { box.scrollLeft = target; return; }

    const s = createSpring(box.scrollLeft, { damping: 1, response: 0.32 });
    s.to(target);
    let frame = 0;
    let last = -1;
    const stop = () => { cancelAnimationFrame(frame); box.removeEventListener("wheel", stop); box.removeEventListener("pointerdown", stop); };
    const step = (ts: number) => {
      const moving = s.tick(last < 0 ? 16 : ts - last);
      last = ts;
      box.scrollLeft = s.value();
      if (moving) frame = requestAnimationFrame(step);
      else stop();
    };
    // Passive: this listener only ever cancels, and a non-passive wheel handler on a scroller is a
    // frame of scrolling held hostage on every event.
    box.addEventListener("wheel", stop, { passive: true });
    box.addEventListener("pointerdown", stop);
    frame = requestAnimationFrame(step);
    return stop;
  }, [rail, active, key]);
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
  const openDestinationPage = useApp((s) => s.openDestinationPage);
  const openProfilePage = useApp((s) => s.openProfilePage);
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
            // Each profile wears its own mark in its own colour, the way the space switcher lists
            // spaces — and because the two rows below carry glyphs, every row in this menu reserves
            // the slot regardless; an empty one beside a named thing that HAS an icon reads as a
            // missing image rather than as restraint.
            icon: <span style={{ color: p.color, display: "grid" }}><Icon name={p.icon ?? "user"} size={16} /></span>,
            checked: p.id === activeProfileId,
            disabled: count(p.id) === 0,
            onSelect: () => run(() => selectProfile(p.id)),
          })),
          { kind: "separator" as const },
          // The grid it opens, as its glyph: every row below asks for the slot, and the one row that
          // left it empty read as a missing image rather than as restraint.
          { label: "All spaces…", icon: <Icon name="layout" size={16} />, kbd: "⌘⇧Space", onSelect: () => setSpacesOpen(true) },
          { kind: "separator" as const },
          /* The two app-level pages you reach FROM here rather than from the space you are in: what
             this Mac is connected to, and how Realm itself is set up. Neither belongs to a space, so
             this chip — the one control in the column whose subject is the account rather than the
             work — is where they are asked for. Same pages, same overlay, same glyphs as the rows. */
          { label: "Connections", icon: <Icon name="connections-page" size={16} />, onSelect: () => openDestinationPage("connections-page") },
          /* The profile's own page. It used to be opened by a pill naming the profile in the space
             header, which is gone — the head row needed that width for the space's name — so the door
             is here, on the one control in the column whose subject is the profile. */
          { label: "Profile", icon: <Icon name="profile-page" size={16} />, onSelect: () => openProfilePage() },
          { label: "Settings", icon: <Icon name="settings" size={16} />, onSelect: () => openDestinationPage("settings-page") },
        ]} />
      )}
    </>
  );
}
