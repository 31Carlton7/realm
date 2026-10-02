import { dayKey, formatTokens, type UsageRecords, type UsageStreakRun } from "@realm/contracts";
import { useEffect, useState } from "react";
import { Avatar } from "../../components/Avatar";
import { PageScroll } from "../../components/ScrollFades";
import { useApp } from "../../state/store";
import type { PaneProps } from "../registry";
import { formatEffort } from "../session/ModelPicker";
import { formatDuration } from "../session/tool-group";
import { ActivityCalendar, readableDay, shortDay } from "../settings/usage/ActivityCalendar";
import { StatTile, TopList } from "../settings/usage/UsagePanel";

const days = (n: number) => `${n.toLocaleString()} ${n === 1 ? "day" : "days"}`;

/** "Aug 2–19, 2026", "Aug 30 – Sep 2, 2026", "Dec 30, 2025 – Jan 2, 2026": as short as the two ends
 *  allow, and one date when the run was a single day. */
export function dayRangeLabel(from: string, to: string): string {
  if (from === to) return readableDay(from);
  const year = to.slice(0, 4);
  if (from.slice(0, 4) !== year) return `${readableDay(from)} – ${readableDay(to)}`;
  if (from.slice(0, 7) === to.slice(0, 7)) return `${shortDay(from)}–${Number(to.slice(8))}, ${year}`;
  return `${shortDay(from)} – ${shortDay(to)}, ${year}`;
}

/** The current streak's line: when it began, or that today has not counted yet. */
function currentNote(run: UsageStreakRun, today: string): string {
  if (run.days === 0 || run.from === null) return "No messages yesterday or today";
  if (run.to !== today) return "Through yesterday";
  return run.days === 1 ? "Today" : `Since ${readableDay(run.from)}`;
}

/**
 * A page about you: your name and picture, the figures every session you ran adds up to, the days
 * you used Realm, and what you reached for most.
 *
 * Not the Profile page. That one is a scope — a profile's skills, connections and memory — and this
 * is the person, across every profile and every space. It reads from nothing the overlay's vantage
 * space would narrow.
 *
 * A figure that cannot be stated is not drawn. Tokens come only from engines that report them, so a
 * person who has only ever run an engine that reports none sees no token figures and one sentence
 * saying why, rather than a zero that would claim they used nothing.
 */
export function YouPage(_props: PaneProps) {
  const userName = useApp((s) => s.userName);
  const avatarPath = useApp((s) => s.avatarPath);
  const chooseAvatar = useApp((s) => s.chooseAvatar);
  const removeAvatar = useApp((s) => s.removeAvatar);
  const usageRecords = useApp((s) => s.usageRecords);
  const run = useApp((s) => s.run);
  const [records, setRecords] = useState<UsageRecords | null>(null);
  useEffect(() => {
    let live = true;
    void run(async () => { const r = await usageRecords(); if (live) setRecords(r); });
    return () => { live = false; };
  }, [usageRecords, run]);

  return (
    <div className="page you-page">
      <header className="page-head">
        <Avatar size={56} />
        <div className="page-title"><h1>{userName.trim() || "You"}</h1></div>
        <div className="you-actions">
          <button type="button" className="btn" onClick={() => run(chooseAvatar)}
            title="Realm keeps its own copy in its home folder and never reads the original again">
            {avatarPath ? "Change picture…" : "Choose a picture…"}
          </button>
          {avatarPath && <button type="button" className="btn btn-quiet" onClick={() => run(removeAvatar)}>Remove picture</button>}
        </div>
      </header>
      <div className="page-body">
        <PageScroll>
          <div className="form usage-panel">
            {records === null ? <p className="env-empty">Reading…</p> : <Figures records={records} />}
            <ActivityCalendar />
            {records !== null && <MostUsed records={records} />}
          </div>
        </PageScroll>
      </div>
    </div>
  );
}

function Figures({ records }: { records: UsageRecords }) {
  const [today] = useState(() => dayKey(Date.now()));
  const { tokens, peakDay, longestTurn, streak, unmeasuredSessions } = records;
  const total = tokens.input + tokens.output;
  return (
    <>
      {streak.longest.days === 0 && (
        <p className="page-lede">Nothing to count yet. This page fills in as you send messages, in any space.</p>
      )}
      <section className="usage-tiles you-figures" aria-label="Your figures">
        {total > 0 && (
          <StatTile label="Lifetime tokens" value={formatTokens(total)}
            delta={`${formatTokens(tokens.input)} in · ${formatTokens(tokens.output)} out`}
            title={unmeasuredSessions > 0
              ? `Reported by the engines that report usage. ${unmeasuredSessions.toLocaleString()} ${unmeasuredSessions === 1 ? "session" : "sessions"} on engines that report none are not in this figure.`
              : undefined} />
        )}
        {peakDay && <StatTile label="Peak day" value={formatTokens(peakDay.tokens)} delta={readableDay(peakDay.day)} />}
        {longestTurn && (
          <StatTile label="Longest turn" value={formatDuration(longestTurn.ms)}
            title="The longest an agent worked on one message, not counting time spent waiting on you"
            delta={<span className="you-figure-sub" title={longestTurn.title}>{longestTurn.title}</span>} />
        )}
        <StatTile label="Current streak" value={days(streak.current.days)} delta={currentNote(streak.current, today)}
          title="Days in a row with at least one message sent" />
        <StatTile label="Longest streak" value={days(streak.longest.days)}
          delta={streak.longest.from && streak.longest.to ? dayRangeLabel(streak.longest.from, streak.longest.to) : "None yet"} />
      </section>
      {total === 0 && unmeasuredSessions > 0 && (
        <section className="usage-caveats" aria-label="Why there are no token figures">
          <p>The engines your sessions ran on report no token usage, so there are no token figures to show.</p>
        </section>
      )}
    </>
  );
}

function MostUsed({ records }: { records: UsageRecords }) {
  const count = (n: number) => n.toLocaleString();
  return (
    <section className="usage-card" aria-label="Most used">
      <header className="usage-card-head">
        <h3>Most used</h3>
        <span className="usage-card-sub">Models and efforts by messages sent, skills by loads, tools by calls</span>
      </header>
      <div className="usage-activity-lists you-most">
        <TopList title="Models" empty="No messages sent yet."
          rows={records.models.map((m) => ({ key: m.key, label: m.label, value: count(m.messages), note: null }))} />
        <TopList title="Efforts" empty={records.models.length > 0 ? "Every session ran at its engine's default." : "No messages sent yet."}
          rows={records.efforts.map((e) => ({ key: e.effort, label: formatEffort(e.effort), value: count(e.messages), note: null }))} />
        <TopList title="Skills" empty="No agent has loaded a skill yet."
          rows={records.skills.map((k) => ({ key: k.name, label: k.name, value: count(k.uses), note: null }))} />
        <TopList title="Tools" empty="No tool calls yet."
          rows={records.tools.map((t) => ({ key: t.name, label: t.name, value: count(t.calls), note: null }))} />
      </div>
    </section>
  );
}
