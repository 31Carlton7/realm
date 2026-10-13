import { z } from "zod";
import { newId, IdSchema } from "./ids";
import { allItems, closeItem, LayoutSchema, type Layout } from "./layout";

/**
 * A named split arrangement inside one space.
 *
 * Before this, a space had exactly one layout: an item was either OPEN (somewhere in that one tree) or
 * "sitting in the space" (existing, unopened). That binary is what groups replace — a space now holds
 * several arrangements, one of which is on screen, and an item that is open is open IN a group. The
 * SPACE list keeps its old meaning (items open in no group at all).
 *
 * `zoomedLeafId` is the group's own focus state: the named leaf takes the whole pane host while the
 * rest of the group stays exactly where it is. It is emphatically NOT a layout change — nothing is
 * removed from the group, the tree is untouched, and clearing it puts every pane back. Per-group
 * rather than per-space so switching groups and coming back finds the same pane still focused.
 */
export type PaneGroup = { id: string; name: string; layout: Layout; zoomedLeafId: string | null };
export type SpaceGroups = { groups: PaneGroup[]; activeGroupId: string };

export const PaneGroupSchema: z.ZodType<PaneGroup> = z.object({
  id: IdSchema, name: z.string().min(1), layout: LayoutSchema, zoomedLeafId: z.string().nullable(),
});

/** The name a space's first group carries — the one every pre-groups layout migrates into. */
export const DEFAULT_GROUP_NAME = "Main";

/**
 * Structural invariants a SpaceGroups must satisfy, enforced here because neither is expressible in the
 * object shape: there is always at least one group (a space with no arrangement at all has nowhere to
 * put a pane), and `activeGroupId` always names one of them (a dangling pointer would render nothing).
 * Both are repaired rather than rejected by `migrateGroups`, so persisted state can never wedge a space
 * — this schema is the assertion that the repair ran.
 */
export const SpaceGroupsSchema: z.ZodType<SpaceGroups> = z.preprocess(
  (input) => migrateGroups(input),
  z.object({ groups: z.array(PaneGroupSchema), activeGroupId: IdSchema }),
).superRefine((gs, ctx) => {
  const g = gs as SpaceGroups;
  if (g.groups.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["groups"], message: "a space must have at least one group" });
  }
  if (g.groups.length > 0 && !g.groups.some((x) => x.id === g.activeGroupId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["activeGroupId"], message: "activeGroupId must name one of the groups" });
  }
  const seen = new Set<string>();
  for (const x of g.groups) {
    if (seen.has(x.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["groups"], message: "duplicate group id" });
    seen.add(x.id);
  }
}) as z.ZodType<SpaceGroups>;

/**
 * One group holding `layout` (or an empty one), active. The shape every pre-groups space becomes.
 *
 * `id` exists so the server can pass the SPACE's own id and make this derivation DETERMINISTIC: a
 * space with no `groups_json` yet re-derives its group set on every read, and minting a fresh ULID
 * each time would hand two consecutive `spaces.list()` calls two different ids for the same group.
 * A space id is itself a valid `IdSchema` value and cannot collide with a `newId()` minted later.
 *
 * The derived EMPTY leaf takes that same id, for the same reason and with no risk: leaf ids and group
 * ids are separate namespaces (nothing ever compares one to the other), and `emptyLayout()`'s fresh
 * ULID would otherwise leave the read non-deterministic in exactly the case it is used most — a
 * brand-new space, which has neither groups nor a layout.
 */
export function groupsFromLayout(layout: Layout | null, id: string = newId()): SpaceGroups {
  const only: Layout = layout ?? { type: "leaf", id, itemId: null };
  return { groups: [{ id, name: DEFAULT_GROUP_NAME, layout: only, zoomedLeafId: null }], activeGroupId: id };
}

/**
 * Normalize anything persisted (or arriving from an older/newer peer) into a usable SpaceGroups.
 *
 * Runs inside SpaceGroupsSchema's preprocess, so every parse repairs rather than throws:
 *  - a bare `Layout` (the pre-groups shape) becomes a single "Main" group;
 *  - a group whose layout is unparseable is dropped, not trusted onto the screen;
 *  - an empty or missing group list is replaced by a fresh empty group;
 *  - a group id that is not a valid `IdSchema` value is REPLACED with a fresh one, and the active
 *    pointer is remapped with it. Repairing beats rejecting: the alternative is that one bad id makes
 *    the whole set fail validation, and the user silently loses every arrangement they built rather
 *    than one group's name;
 *  - an `activeGroupId` naming no group falls back to the first group;
 *  - items are deduped ACROSS groups (first group wins), the cross-group form of the uniqueness
 *    `layout.ts` already enforces within one tree — two groups both claiming a pane would make
 *    "which group is this item in" unanswerable.
 */
export function migrateGroups(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return groupsFromLayout(null);
  const n = input as Record<string, unknown>;
  // A bare layout node (pre-groups persisted shape) rather than a group set.
  if (n.type === "split" || n.type === "leaf") {
    const p = LayoutSchema.safeParse(input);
    return groupsFromLayout(p.success ? p.data : null);
  }
  const raw = Array.isArray(n.groups) ? n.groups : [];
  const seenItems = new Set<string>();
  const seenIds = new Set<string>();
  /** Old id → the id the repaired group actually carries, so `activeGroupId` follows a replacement. */
  const remap = new Map<string, string>();
  const groups: PaneGroup[] = [];
  for (const g of raw) {
    if (typeof g !== "object" || g === null) continue;
    const r = g as Record<string, unknown>;
    const parsed = LayoutSchema.safeParse(r.layout);
    if (!parsed.success) continue;
    // A malformed or duplicated id is repaired rather than allowed to fail the whole set downstream.
    const rawId = typeof r.id === "string" ? r.id : "";
    const id = rawId && IdSchema.safeParse(rawId).success && !seenIds.has(rawId) ? rawId : newId();
    seenIds.add(id);
    if (rawId) remap.set(rawId, id);
    // Drop every itemId already claimed by an earlier group, then re-parse: closeItem prunes the
    // vacated leaves so the tree stays structurally valid instead of filling with holes.
    let layout = parsed.data;
    for (const itemId of allItems(layout)) {
      if (seenItems.has(itemId)) layout = closeItem(layout, itemId);
      else seenItems.add(itemId);
    }
    groups.push({
      id,
      name: typeof r.name === "string" && r.name.trim() ? r.name : DEFAULT_GROUP_NAME,
      layout,
      // A zoom pointing at a leaf that no longer exists is simply not a zoom (the group renders split).
      zoomedLeafId: typeof r.zoomedLeafId === "string" && hasLeaf(layout, r.zoomedLeafId) ? r.zoomedLeafId : null,
    });
  }
  if (groups.length === 0) return groupsFromLayout(null);
  const wanted = typeof n.activeGroupId === "string" ? remap.get(n.activeGroupId) ?? n.activeGroupId : null;
  const activeGroupId = wanted && groups.some((g) => g.id === wanted) ? wanted : groups[0]!.id;
  return { groups, activeGroupId };
}

function hasLeaf(l: Layout, leafId: string): boolean {
  return l.type === "leaf" ? l.id === leafId : l.children.some((c) => hasLeaf(c, leafId));
}

/** The group on screen. Always defined for a valid SpaceGroups (see the schema's invariants). */
export function activeGroup(gs: SpaceGroups): PaneGroup {
  return gs.groups.find((g) => g.id === gs.activeGroupId) ?? gs.groups[0]!;
}

/** The active group's layout — what the pane host renders, and what `Space.layout` reports. */
export function activeLayout(gs: SpaceGroups): Layout {
  return activeGroup(gs).layout;
}

/** Every item open in ANY group. The complement of this within a space's items is the SPACE list. */
export function allGroupItems(gs: SpaceGroups): string[] {
  return gs.groups.flatMap((g) => allItems(g.layout));
}

/** Replace one group in place; every other group (and the active pointer) is returned unchanged.
 *  Returns the SAME object when `fn` hands back the group it was given — the store persists on
 *  identity change, so an edit that changes nothing (zooming what is already zoomed) must not look
 *  like a write. */
export function mapGroup(gs: SpaceGroups, groupId: string, fn: (g: PaneGroup) => PaneGroup): SpaceGroups {
  const at = gs.groups.findIndex((g) => g.id === groupId);
  if (at === -1) return gs;
  const next = fn(gs.groups[at]!);
  if (next === gs.groups[at]) return gs;
  const groups = [...gs.groups];
  groups[at] = next;
  return { ...gs, groups };
}

/** Write the active group's layout. The one seam every layout-editing store action goes through. */
export function setActiveLayout(gs: SpaceGroups, layout: Layout): SpaceGroups {
  return mapGroup(gs, activeGroup(gs).id, (g) => withLayout(g, layout));
}

/** Set a group's layout, ending a zoom whose leaf the edit just pruned (closing the zoomed pane, a
 *  preset, a drag) rather than leaving the host with nothing to render. Identity-preserving. */
function withLayout(g: PaneGroup, layout: Layout): PaneGroup {
  const zoomedLeafId = g.zoomedLeafId && hasLeaf(layout, g.zoomedLeafId) ? g.zoomedLeafId : null;
  return layout === g.layout && zoomedLeafId === g.zoomedLeafId ? g : { ...g, layout, zoomedLeafId };
}

/**
 * Focus (zoom) a leaf of the active group full-screen — the right-click "Focus" action. The group is
 * untouched: no pane is closed, moved or removed, the split tree is byte-identical, and clearing the
 * zoom puts the arrangement straight back. A leaf that isn't in the active group's tree is ignored.
 */
export function zoomLeaf(gs: SpaceGroups, leafId: string): SpaceGroups {
  const g = activeGroup(gs);
  if (!hasLeaf(g.layout, leafId) || g.zoomedLeafId === leafId) return gs;
  return mapGroup(gs, g.id, (x) => ({ ...x, zoomedLeafId: leafId }));
}
