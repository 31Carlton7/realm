import { useMemo } from "react";
import { DEFAULT_LAYOUT, OfficeView, type OfficeAgent } from "@realm/pixel-office";
import type { Session, SessionStatus } from "@realm/contracts";
import { useApp } from "../../state/store";
import { OfficePrompter } from "./OfficePrompter";

/** The statuses the office draws. History has no place in a room: a session that finished is not
 *  a character sitting at an empty desk, it is a person who went home. */
const AT_WORK = new Set<SessionStatus>(["waiting_permission", "running", "error"]);

/**
 * Realm's live agents, as people working in a room.
 *
 * The engine is vendored from Pixel Agents (`packages/pixel-office`, see its VENDOR.md); everything
 * here is the join to Realm — which sessions are in the room, what each is holding, and which world
 * they are in.
 *
 * The tool each character is holding is the same `sessionActivity` line the wall prints in words,
 * read off the same broadcast. That is deliberate and it is what keeps this honest: the office is a
 * second rendering of something already legible, never the only place a fact appears. A reader who
 * cannot tell a typing sprite from a reading one has lost nothing — the wall says it in a sentence.
 */
export function AgentOffice({ sessions, status, visible, onPick }: {
  sessions: readonly Session[];
  status: Record<string, SessionStatus>;
  visible: boolean;
  onPick: (session: Session) => void;
}) {
  const activity = useApp((s) => s.sessionActivity);
  const world = useApp((s) => s.officeWorld);

  const agents = useMemo<OfficeAgent[]>(() => sessions.flatMap((s) => {
    const st = status[s.id] ?? s.status;
    if (!AT_WORK.has(st)) return [];
    return [{
      id: s.id,
      status: st as OfficeAgent["status"],
      /* The tool name, not the summary line: the office animates on WHICH tool, and a path or a
         command means nothing to it. `activityOf` keeps the two apart for exactly this. */
      tool: activity[s.id]?.tool ?? null,
      folder: s.cwd,
    }];
  }), [sessions, status, activity]);

  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  return (
    <div className="agent-office">
      <OfficePrompter current={world} seats={agents.length} />
      <OfficeView
        className="agent-office-canvas"
        agents={agents}
        layout={world?.layout ?? DEFAULT_LAYOUT}
        visible={visible}
        onPick={(id) => { const s = byId.get(id); if (s) onPick(s); }}
      />
    </div>
  );
}
