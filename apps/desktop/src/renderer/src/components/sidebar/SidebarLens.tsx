import { useApp } from "../../state/store";

const LENSES = [
  { id: "spaces", label: "Spaces", hint: "Each space of this profile, with its sessions" },
  { id: "recent", label: "Recent", hint: "Every session of this profile, by when it last moved" },
] as const;

/**
 * Spaces | Recent: the two readings of the sidebar's list (Plan 27). The same sessions either way —
 * under the space each works in, or by time, each naming its space — so it is a lens rather than a
 * place, and which one is on is remembered across launches (`sidebarLens`).
 */
export function SidebarLens() {
  const lens = useApp((s) => s.sidebarLens);
  const setSidebarLens = useApp((s) => s.setSidebarLens);
  const run = useApp((s) => s.run);
  return (
    <fieldset className="seg sb-lens">
      <legend className="visually-hidden">List</legend>
      {LENSES.map((l) => (
        <label key={l.id} className="seg-opt" data-selected={lens === l.id || undefined} title={l.hint}>
          <input type="radio" name="sidebar-lens" value={l.id} checked={lens === l.id}
            onChange={() => run(() => setSidebarLens(l.id))} />
          {l.label}
        </label>
      ))}
    </fieldset>
  );
}
