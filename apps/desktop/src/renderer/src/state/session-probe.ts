import { useMemo } from "react";
import type { ClaudeDir, Profile, Session, Space } from "@realm/contracts";
import { unknownClaude, useApp, type AgentProbe } from "./store";

export { unknownClaude };

/** What the rules below read off a session: which one it is, the space it is in, and whether it
 *  holds a conversation yet. That is little enough for a prompter with no session behind it to
 *  hand in a stand-in for the one its first question would start, as the media viewer's does: a
 *  session of that space that holds no conversation, under an id no row is ever held for.
 *
 *  The viewer hands in a second stand-in, for a session that exists and that the window holds no
 *  row of: one it knows only by the space it is in, as it does another profile's. That one goes
 *  under the session's own id, so its own row is read from the moment the store holds one, and it
 *  claims a conversation, which is the cautious reading of a session nothing is known about: it is
 *  never taken to start under the active profile's folder. */
export type ProbedSession = Pick<Session, "id" | "spaceId" | "providerSessionId">;

/** `rows` with Claude's row replaced by `claude`, in place so the list keeps the server's order,
 *  and added at the end of a list that has none. */
function withClaude(rows: AgentProbe[], claude: AgentProbe): AgentProbe[] {
  return rows.some((r) => r.kind === "claude") ? rows.map((r) => (r.kind === "claude" ? claude : r)) : [...rows, claude];
}

/** Whether a session would start under the folder the active profile names, which is the folder
 *  `agentProbe` answers for. It would when it holds no conversation yet and its space is one of
 *  that profile's. A session that holds a conversation never does, whatever its profile, since a
 *  conversation stays in the folder it began under. */
function startsUnderActiveProfile(session: ProbedSession, activeProfileId: string | null, spaces: readonly Pick<Space, "id" | "profileId">[]): boolean {
  return session.providerSessionId === null && spaces.some((sp) => sp.id === session.spaceId && sp.profileId === activeProfileId);
}

/** Whether the server has said that Claude runs under the default folder and no other
 *  (`ClaudeDir.anyNamed`). Every session is then on the one sign-in `agentProbe` answers for. It
 *  takes an answer to know, and one answer that says a folder is in use is enough to not know:
 *  the answers are read a profile at a time, and the cautious one is the one to believe.
 *
 *  Only the answers of profiles the window holds are counted. The store keeps the answer of a
 *  profile that has been deleted, and no read replaces it, since a deleted profile is not read
 *  again. Counted, the answer of a deleted profile that named the last folder in use would go on
 *  saying a folder is in use, with none named anywhere. */
function onlyDefaultFolder(claudeDirs: Record<string, Pick<ClaudeDir, "anyNamed">>, profiles: readonly Pick<Profile, "id">[]): boolean {
  const answers = profiles.flatMap((p) => claudeDirs[p.id] ?? []);
  return answers.length > 0 && answers.every((answer) => !answer.anyNamed);
}

/** `agentProbe` with Claude's row made the one a session reads, by the rules `sessionProbeRows`
 *  sets out. `oneFolder` is `onlyDefaultFolder`'s answer and `followsProfile` is
 *  `startsUnderActiveProfile`'s. A list with no Claude row to take the sign-in off is handed back
 *  as it is. */
function claudeRowFor(agentProbe: AgentProbe[], own: AgentProbe | undefined, oneFolder: boolean, followsProfile: boolean): AgentProbe[] {
  if (oneFolder && typeof own?.home !== "string") return agentProbe;
  if (own) return withClaude(agentProbe, own);
  if (followsProfile) return agentProbe;
  const shown = agentProbe.find((r) => r.kind === "claude");
  return shown ? withClaude(agentProbe, unknownClaude(shown)) : agentProbe;
}

/**
 * The probe rows one session's pane reads: `agentProbe`, with Claude's row made the one that is
 * true of that session.
 *
 * `agentProbe` answers for the Claude config folder the active profile names, and a session is not
 * always under that folder. A conversation stays in the folder it began under, so one that began
 * before its profile's folder was changed, or in a space that has since moved to another profile,
 * runs on another sign-in. What the four rules prevent is one account's chip, or one account's
 * "signed out" card, drawn over a conversation that another account holds and pays for. In order:
 *
 * 1. While the server says no folder but the default one is in use (`onlyDefaultFolder`), every
 *    session is on the sign-in the list answers for, so it reads the list as it is. Its own row is
 *    set aside, being about the same folder: the list is the one the rest of the window keeps
 *    current. This is what keeps a Mac where no profile names a folder as it was, with no pane
 *    waiting on an answer to draw the account it has always drawn. The one own row not set aside
 *    is one that names a folder, which says the server's word is out of date.
 * 2. The session's own row, where the store holds one (`sessionClaude`).
 * 3. A session that holds no conversation yet, in a space of the active profile, starts under that
 *    profile's folder, so it reads the list as it is.
 * 4. Any other session runs under a folder this window has not heard about, so Claude's row says
 *    only what is true of every folder (`unknownClaude`). A session that holds a conversation is
 *    here even in the active profile, and so is a session of another profile, which a peek and the
 *    quick chat can both show.
 *
 * No session, as under a prompter that has none behind it yet, answers `agentProbe`.
 */
export function sessionProbeRows(o: {
  agentProbe: AgentProbe[];
  sessionClaude: Record<string, AgentProbe>;
  claudeDirs: Record<string, Pick<ClaudeDir, "anyNamed">>;
  profiles: readonly Pick<Profile, "id">[];
  session: ProbedSession | null | undefined;
  activeProfileId: string | null;
  spaces: readonly Pick<Space, "id" | "profileId">[];
}): AgentProbe[] {
  const { agentProbe, session } = o;
  if (!session) return agentProbe;
  return claudeRowFor(agentProbe, o.sessionClaude[session.id], onlyDefaultFolder(o.claudeDirs, o.profiles), startsUnderActiveProfile(session, o.activeProfileId, o.spaces));
}

/**
 * `sessionProbeRows` over the store, for a pane that draws a session's prompter. It asks for
 * nothing. The pane asks (`probeSessionClaude`) when it is shown.
 *
 * A pane hands the answer to memoised children, so it is the same list until something the rules
 * read has moved. That is why it selects the four things the rules come down to (the list, this
 * session's own row, whether only the default folder is in use, and whether the session follows
 * the active profile) and not the session's row or the lists those sit in. The store makes a new session row for every status change and every event
 * written, and a list rebuilt on each of those would re-render the model picker all through a
 * streaming turn. Another pane's row landing, or a space renamed, changes nothing here either.
 */
export function useSessionProbe(session: ProbedSession | null | undefined): AgentProbe[] {
  const agentProbe = useApp((s) => s.agentProbe);
  const own = useApp((s) => (session ? s.sessionClaude[session.id] : undefined));
  const oneFolder = useApp((s) => onlyDefaultFolder(s.claudeDirs, s.profiles));
  const followsProfile = useApp((s) => !session || startsUnderActiveProfile(session, s.activeProfileId, s.spaces));
  return useMemo(() => claudeRowFor(agentProbe, own, oneFolder, followsProfile), [agentProbe, own, oneFolder, followsProfile]);
}
