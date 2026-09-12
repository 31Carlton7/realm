import { Icon } from "@realm/ui";
import { useEffect, useMemo, useState } from "react";
import { AGENT_META, basenameOf, type Session } from "@realm/contracts";
import { useApp } from "../../state/store";
import { relTime } from "../CommandPalette";
import { groupSessionsByDay } from "./chat-feed";

/**
 * Every chat, everywhere, newest first and cut into days.
 *
 * The sidebar's other lens is the SPACE — the items open in the one you are standing in. This is the
 * opposite question, and the one you ask when you come back to the machine: what have I been working
 * on. So it crosses spaces deliberately, which is the whole reason it cannot be the space list with
 * headings bolted on.
 *
 * Each row carries the facts that tell two chats with the same title apart — the space, the folder,
 * and the branch — because "Fix the login form" is a title three different pieces of work will have.
 * Everything on that line is read from what the session already knows, with one exception noted
 * below; nothing here fetches per row, because a sidebar that issues a request per visible row is a
 * sidebar that stalls when you scroll it.
 *
 * The branch is the exception and it is shown ONLY when this window already holds the environment.
 * Environments are loaded for the space you are in, so a chat from another space usually has none
 * here — and the honest answer to "which branch is that one on" is to say nothing rather than to
 * guess, or to fire a request per row to find out. When you switch to that space its rows gain their
 * branch, which is a better behaviour than it sounds: the rows you can act on are the ones that
 * describe themselves most fully.
 */
export function ChatFeed() {
  const sessionsById = useApp((s) => s.sessions);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const spaces = useApp((s) => s.spaces);
  const environments = useApp((s) => s.environments);
  const activeSpaceId = useApp((s) => s.activeSpaceId);
  const activeProfileId = useApp((s) => s.activeProfileId());
  const listAllSessions = useApp((s) => s.listAllSessions);
  const revealSession = useApp((s) => s.revealSession);
  const run = useApp((s) => s.run);

  /* Fetched by the lens rather than handed down: one mount is one read, wherever the mount came
     from — the same rule the gateway feed that used to stand here followed. */
  const [all, setAll] = useState<Session[] | null>(null);
  useEffect(() => {
    let live = true;
    run(async () => { const rows = await listAllSessions(activeProfileId); if (live) setAll(rows); });
    return () => { live = false; };
  }, [listAllSessions, run, activeProfileId]);

  /* The store's copy wins where it has one. `listAll` is a snapshot taken at mount; the store row is
     what live events have been updating since, so a chat that finished a turn while this list was
     open shows as finished rather than as it was when the list was read. */
  const rows = useMemo(
    () => (all ?? []).map((s) => sessionsById[s.id] ?? s),
    [all, sessionsById],
  );
  /* `Date.now()` at render, not in the grouper: the grouper is pure so the labels are testable
     against a fixed clock, and this is the one place the real clock is allowed in. */
  const days = useMemo(() => groupSessionsByDay(rows, Date.now()), [rows]);

  const spaceName = (id: string) => spaces.find((s) => s.id === id)?.name ?? "";

  if (all === null) return <div className="space-body sb-activity" />;
  if (rows.length === 0) {
    return (
      <div className="space-body sb-activity sb-activity-blank">
        <div className="sb-activity-empty">
          <Icon name="session" size={20} />
          <p className="sb-activity-empty-line">No chats yet</p>
          <p className="sb-activity-empty-sub">Every conversation you start, in every space, shows up here by the day you worked on it.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-body sb-activity">
      {days.map((day) => (
        <div key={day.key}>
          <div className="group-label sb-chat-day">{day.label}</div>
          <ul className="item-list">
            {day.sessions.map((s) => {
              const status = sessionStatus[s.id] ?? s.status;
              /* A space's own folder is named after the space, so for most rows these two chips would
                 say the same word twice. The folder earns its place only when it differs — a linked
                 project or a worktree — which is exactly when it is telling you something. */
              const folderName = basenameOf(s.cwd);
              const branch = environments[s.environmentId]?.branch ?? null;
              const space = spaceName(s.spaceId);
              const folder = folderName.toLowerCase() === space.toLowerCase() ? "" : folderName;
              return (
                <li className="item" key={s.id}>
                  <button type="button" className="item-row sb-chat-row"
                    data-status={status} data-elsewhere={s.spaceId !== activeSpaceId || undefined}
                    title={`${s.title} — ${space} · ${s.cwd}`}
                    onClick={() => run(() => revealSession(s.id, s.spaceId))}>
                    <Icon name={AGENT_META[s.agentKind].icon} size={14} colored className="sb-chat-mark" />
                    <span className="sb-chat-main">
                      <span className="item-title">{s.title}</span>
                      <span className="sb-chat-sub">
                        {space && <span className="sb-chat-chip">{space}</span>}
                        {folder && <span className="sb-chat-chip sb-chat-mono">{folder}</span>}
                        {branch && <span className="sb-chat-chip sb-chat-mono">{branch}</span>}
                      </span>
                    </span>
                    <span className="sb-chat-when">{relTime(s.updatedAt)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
