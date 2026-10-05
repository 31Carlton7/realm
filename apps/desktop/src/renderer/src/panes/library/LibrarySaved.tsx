import { Icon } from "@realm/ui";
import { useEffect, useMemo, useState } from "react";
import type { SavedTurn } from "@realm/contracts";
import { useApp } from "../../state/store";
import { opening, promptTitle } from "../session/scroll-track";
import { stampLabel, stampTitle, useNow } from "../session/timestamps";

/**
 * The Library's Saved section: every turn saved from a session's scroll track, across every space of
 * the profile, the newest saved first.
 *
 * The Library, rather than the sidebar's activity view, because this is a collection a person KEPT
 * and comes back to read, which is what the Library holds — its files already span the profile the
 * same way — where the activity view is the gateway's call log, a feed of things counted as they go
 * by. Each turn is a card: what was asked, how it was answered, and whose session it was. A click goes
 * to that prompt in its session, and the ribbon unsaves it, as the track's card does.
 */
export function LibrarySaved({ spaceId }: { spaceId: string }) {
  const profileId = useApp((s) => s.spaces.find((x) => x.id === spaceId)?.profileId ?? null);
  const spaces = useApp((s) => s.spaces);
  /* Re-read whenever any session's saved turns change — a bookmark pressed on a track in this window or
     another (`session.saved`), or a ribbon in this list — so the list is never a stale copy. */
  const rev = useApp((s) => s.savedTurnsRev);
  const listSavedTurns = useApp((s) => s.listSavedTurns);
  const saveTurn = useApp((s) => s.saveTurn);
  const revealPrompt = useApp((s) => s.revealPrompt);
  const run = useApp((s) => s.run);
  const now = useNow();
  const [list, setList] = useState<{ entries: SavedTurn[]; total: number } | null>(null);
  useEffect(() => {
    if (!profileId) return;
    let live = true;
    run(async () => {
      const read = await listSavedTurns(profileId);
      if (live) setList(read);
    });
    return () => { live = false; };
  }, [profileId, rev, listSavedTurns, run]);
  const spaceName = useMemo(() => new Map(spaces.map((x) => [x.id, x.name])), [spaces]);

  if (!list) return <p className="env-empty library-empty">Loading…</p>;
  if (list.entries.length === 0) {
    return (
      <p className="env-empty library-empty">
        Nothing saved yet. Point at a tick on the track down a session's left edge and press the bookmark on
        its card — or press S while the track has the keyboard.
      </p>
    );
  }
  return (
    <>
      {/* A cut list says so, rather than looking like the whole of it. */}
      {list.total > list.entries.length && <p className="env-empty saved-turns-cut">The {list.entries.length} saved most recently, of {list.total}.</p>}
      <ul className="saved-turns">
        {list.entries.map((e) => {
          const reply = e.reply === null ? null : opening(e.reply);
          const title = promptTitle({ text: e.text, attachments: e.attachments.map((path) => ({ path })), goal: e.goal });
          return (
            <li key={e.seq} className="saved-turn">
              <button type="button" className="saved-turn-open" title={`Open ${e.sessionTitle} at this prompt`}
                onClick={() => run(() => revealPrompt(e.sessionId, e.spaceId, e.seq))}>
                <span className="saved-turn-title">{title}</span>
                {reply && <span className="saved-turn-reply">{reply}</span>}
                <span className="saved-turn-where">
                  {e.sessionTitle}{spaceName.has(e.spaceId) ? ` · ${spaceName.get(e.spaceId)}` : ""}
                  {" · "}<time dateTime={new Date(e.ts).toISOString()} title={stampTitle(e.ts)}>{stampLabel(e.ts, now)}</time>
                </span>
              </button>
              <button type="button" className="saved-turn-save" aria-label={`Save turn: ${title}`} aria-pressed
                title="Unsave this turn" onClick={() => run(() => saveTurn(e.sessionId, e.seq, false))}>
                <Icon name="saved" size={14} />
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
