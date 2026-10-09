import type { AgentKind, Session } from "@realm/contracts";
import type { SessionOptions } from "../../state/store";

/**
 * How a session that does not exist yet will run: the agent and model, and the level, fast mode and
 * permission the picker's card and the permission chip set. A prompter with no session behind it yet
 * — Code review's question box, the media viewer's — holds one of these, and the first send hands it
 * to the session it starts.
 *
 * The prompter draws the same card for a draft as for a session, so the card has to answer the same
 * way. It once held only the agent and model: the bolt and the track were drawn, took the press, and
 * dropped it, and a person could pick models all day but never change how one ran.
 */
export type DraftRun = {
  agentKind: AgentKind;
  model: string | null;
  /** `null` is the model's own default, as on a session. */
  effort: string | null;
  fastMode: boolean;
  /** `null` is the person's configured default, which the server resolves at create. */
  permissionMode: string | null;
};

export function draftRun(agentKind: AgentKind): DraftRun {
  return { agentKind, model: null, effort: null, fastMode: false, permissionMode: null };
}

/** `o` applied to a draft the way `sessions.setOptions` applies it to a session's row. */
export function withOptions(d: DraftRun, o: SessionOptions): DraftRun {
  return {
    ...d,
    ...(o.model !== undefined ? { model: o.model } : {}),
    ...(o.effort !== undefined ? { effort: o.effort } : {}),
    ...(o.fastMode !== undefined ? { fastMode: o.fastMode } : {}),
    ...(o.permissionMode !== undefined ? { permissionMode: o.permissionMode } : {}),
  };
}

/** The draft as the session the prompter is handed, so its chips read what the first send will start. */
export function draftSession(d: DraftRun, at: { id: string; spaceId: string; projectId: string | null; cwd: string }): Session {
  return {
    id: at.id, spaceId: at.spaceId, projectId: at.projectId, agentKind: d.agentKind, model: d.model, effort: d.effort,
    permissionMode: d.permissionMode ?? "default", fastMode: d.fastMode, environmentId: "", cwd: at.cwd, status: "idle",
    providerSessionId: null, title: "", lastEventSeq: 0, seenSeq: 0, terminalItemId: null, dispatchedBy: null, activityAt: 0, createdAt: 0, updatedAt: 0,
  };
}
