import { Icon } from "@realm/ui";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentKind } from "@realm/contracts";
import { useApp } from "../../state/store";
import { ActivityCardView } from "./ActivityCard";
import { recentDays, spaceUsualAgent, type SessionRow } from "./model";

/**
 * The Recent lens, headed Activity: the profile's sessions by when they last moved, under day
 * headings — Today, Yesterday, a weekday, a date — each a card naming its space and how long ago it
 * moved, and wearing its state (Plan 27; cards, the owner 10-12). The same sessions as the sections,
 * read for "what have I been working on".
 */
export function RecentList({ rows, onChanged }: { rows: SessionRow[]; onChanged: () => void }) {
  const spaces = useApp((s) => s.spaces);
  /* The clock is read here and not in the grouper: the grouper is pure so its labels are testable
     against a fixed clock, and this is the one place the real clock is allowed in. It ticks each
     minute, so "5m" does not stay 5m while the list sits open. */
  const now = useMinute();
  const days = useMemo(() => recentDays(rows, now), [rows, now]);
  const usual = useMemo(() => {
    const bySpace = new Map<string, SessionRow[]>();
    for (const r of rows) {
      const held = bySpace.get(r.spaceId);
      if (held) held.push(r); else bySpace.set(r.spaceId, [r]);
    }
    return new Map<string, AgentKind | null>([...bySpace].map(([id, list]) => [id, spaceUsualAgent(list)]));
  }, [rows]);
  /* The session handed the keyboard has its card brought into view. Mostly that is one just made — by
     the header's button, ⌘N or the palette — which is the newest card, at the very top, while the list
     may be scrolled days down: left there, the card you were on went dark and nothing in the list said
     where the new one went. A session opened from a list elsewhere is handed it too, and is found the
     same way; one opened from its own card is already in view, and nothing moves. */
  const list = useRef<HTMLDivElement>(null);
  const handed = useApp((s) => s.keyboardFor);
  useLayoutEffect(() => {
    if (handed) list.current?.querySelector(`.sb-card[data-session="${handed.sessionId}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [handed]);
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
    <div className="sb-recent" ref={list}>
      {days.map((day) => (
        <div key={day.key} className="sb-day">
          <div className="group-label">{day.label}</div>
          <div className="item-list sb-cards">
            {day.rows.map((r) => (
              <ActivityCardView key={r.id} row={r} space={spaces.find((sp) => sp.id === r.spaceId)} usual={usual.get(r.spaceId) ?? null}
                now={now} onChanged={onChanged} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** `Date.now()`, again each minute: what a list of "5m"s needs to stay true while it is open. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
