import { Icon } from "@realm/ui";
import { useMemo } from "react";
import { useApp } from "../../state/store";
import { recentDays, type SessionRow } from "./model";
import { ListRowView } from "./SessionRows";

/**
 * The Recent lens: the profile's sessions by when they last moved, under day headings — Today,
 * Yesterday, a weekday, a date — each naming its space and wearing its state at the far end
 * (Plan 27). The same rows as the sections, read for "what have I been working on".
 */
export function RecentList({ rows, onChanged }: { rows: SessionRow[]; onChanged: () => void }) {
  const spaces = useApp((s) => s.spaces);
  /* `Date.now()` here and not in the grouper: the grouper is pure so its labels are testable against
     a fixed clock, and this is the one place the real clock is allowed in. */
  const days = useMemo(() => recentDays(rows, Date.now()), [rows]);
  const spaceName = (id: string) => spaces.find((sp) => sp.id === id)?.name ?? "";
  if (rows.length === 0) {
    return (
      <div className="sb-empty">
        <Icon name="session" size={20} />
        <p className="sb-empty-line">No sessions yet</p>
        <p className="sb-empty-sub">Every session you start, in every space of this profile, shows up here by the day you worked on it.</p>
      </div>
    );
  }
  return (
    <div className="sb-recent">
      {days.map((day) => (
        <div key={day.key} className="sb-day">
          <div className="group-label">{day.label}</div>
          <div className="item-list">
            {day.rows.map((r) => <ListRowView key={r.id} row={r} where={spaceName(r.spaceId)} onChanged={onChanged} />)}
          </div>
        </div>
      ))}
    </div>
  );
}
