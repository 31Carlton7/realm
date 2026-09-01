import type { ItemScope } from "@realm/contracts";
import type { ReactNode } from "react";
import { useApp } from "../../state/store";

/**
 * THE grouped-scope list (Plan 12 W4) — the one rendering of the scoping model's rule 2 ("lists render
 * in two labelled groups"), plus the migration's third group. Every surface that shows scoped items —
 * the Library page, the Connections page, the space page's Skills and Connections tabs — renders its
 * rows through this component. One definition, structurally enforced (see `scope-groups.test.tsx`'s
 * grep, the same discipline as W2's server-side one-place rule): a second copy of the grouping math is
 * exactly how two surfaces start disagreeing about where an item is defined.
 *
 * The groups, seen from the vantage space `spaceId`:
 * - **"This space"** — defined here (`{ kind: "space", spaceId }`).
 * - **"From <profile>"** — inherited (`{ kind: "profile" }`), one group PER profileId: the list RPCs
 *   only ever return the vantage space's own profile, but the grouping never assumes it — two
 *   profiles' items landing in one labelled group is a named W4 mutant.
 * - **"Everywhere"** — pre-scoping rows (`{ kind: "space", spaceId: null }`): visible in every space
 *   until someone moves them. The bundled `mac`/`browsing` skills live here on a fresh install.
 *
 * Rows are the caller's (`entry.row`, a fully-formed `<li>`): what a skill row and a server row SHOW
 * differs per system; where a row SITS must not.
 */
export type ScopedEntry = { key: string; scope: ItemScope; row: ReactNode };

type GroupId = "this-space" | `profile:${string}` | "everywhere";

/** Which group one scope belongs to. A space-scope with a non-null id is "this space": the list RPCs
 *  return only rows that APPLY to the listed space, so a non-null spaceId is by contract the vantage
 *  space's own — no id comparison is needed, or possible to get wrong. */
export function scopeGroupOf(scope: ItemScope): GroupId {
  if (scope.kind === "profile") return `profile:${scope.profileId}`;
  return scope.spaceId === null ? "everywhere" : "this-space";
}

export function ScopeGroups({ entries, listClassName = "settings-list" }: {
  entries: ScopedEntry[];
  /** The `<ul>` class, so each system keeps its own row styling (skills: settings-list; MCP: env-list). */
  listClassName?: string;
}) {
  const profiles = useApp((s) => s.profiles);

  const byGroup = new Map<GroupId, ScopedEntry[]>();
  for (const e of entries) {
    const gid = scopeGroupOf(e.scope);
    byGroup.set(gid, [...(byGroup.get(gid) ?? []), e]);
  }

  // Fixed order: what's defined here, then what's inherited (profiles in their user sort order,
  // unknowns after), then the pre-scoping remainder. Empty groups don't render — a header over
  // nothing would claim a scope holds items it doesn't.
  const profileIds = [...byGroup.keys()].filter((g) => g.startsWith("profile:")).map((g) => g.slice("profile:".length))
    .sort((a, b) => profiles.findIndex((p) => p.id === a) - profiles.findIndex((p) => p.id === b));
  const order: { id: GroupId; label: string }[] = [
    { id: "this-space", label: "This space" },
    ...profileIds.map((pid) => ({ id: `profile:${pid}` as GroupId, label: `From ${profiles.find((p) => p.id === pid)?.name ?? "profile"}` })),
    { id: "everywhere", label: "Everywhere" },
  ];

  return (
    <>
      {order.map(({ id, label }) => {
        const group = byGroup.get(id);
        if (!group || group.length === 0) return null;
        return (
          <section key={id} className="scope-group" aria-label={label}>
            <h3 className="scope-group-label">{label}</h3>
            <ul className={listClassName}>{group.map((e) => e.row)}</ul>
          </section>
        );
      })}
    </>
  );
}

/**
 * The promote/demote confirmation, shared for the same reason the groups are: the semantic sentence is
 * the contract ("other spaces in <profile> will see it; spaces that had it stay as they are" — the
 * moves are effective-set neutral, only REACH changes), and two copies of it would drift. The caller
 * fires the actual RPC in `onConfirm`, with the VANTAGE space id — never a profile id, which is
 * resolved server-side from the space.
 */
export function MoveScopeConfirm({ direction, name, profileName, onCancel, onConfirm }: {
  direction: "promote" | "demote"; name: string; profileName: string;
  onCancel: () => void; onConfirm: () => void;
}) {
  const copy = direction === "promote"
    ? `Move “${name}” to ${profileName}? Other spaces in ${profileName} will see it; spaces that had it stay as they are.`
    : `Keep “${name}” in this space only? Other spaces in ${profileName} will stop seeing it; this space keeps it as it is.`;
  return (
    <div className="scope-confirm">
      <span className="scope-confirm-copy">{copy}</span>
      <button type="button" className="btn-quiet" onClick={onCancel}>Cancel</button>
      <button type="button" className="btn-quiet" onClick={onConfirm}>{direction === "promote" ? "Move to profile" : "Move to this space"}</button>
    </div>
  );
}
