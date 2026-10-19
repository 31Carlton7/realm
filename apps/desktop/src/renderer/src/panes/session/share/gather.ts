import { AGENT_META, type AgentKind, type DelegatedChild, type Session, type SessionEvent } from "@realm/contracts";
import { modelLabel } from "../../agents-tab/subagent-state";
import { delegatedChildIds } from "../DelegatedRuns";
import { isDelegationLine } from "../tool-group";
import { questionOf, reduceAll, type Transcript } from "../transcript-model";
import { sharedImagePaths, type SharedChild, type SharedPermission, type SharedSession } from "./page";

type Probe = readonly { kind: AgentKind; models?: readonly { id: string; label: string }[] | null }[];

/** What gathering a shared page needs from the app — the server's log, the delegation list, the disk —
 *  passed in, so the gathering itself is testable without either. */
export type GatherDeps = {
  session: Session;
  title: string;
  space: string | null;
  probe: Probe;
  now: number;
  /** A session's whole log, oldest first. */
  readLog(sessionId: string): Promise<SessionEvent[]>;
  /** The sub-agents Realm ran for the session (`listDelegatedChildren`). */
  children(): Promise<DelegatedChild[]>;
  /** A path as an agent wrote it, made absolute against `base`; null when nothing is there. */
  resolve(path: string, base: string | null): Promise<string | null>;
  /** A picture re-encoded for the page (main's `share:image`); null when it is not one. */
  image(absPath: string): Promise<string | null>;
};

/** "Claude · Opus 5.5": the harness and the model, as the picker names them. */
export const agentLine = (kind: AgentKind, model: string | null, probe: Probe): string =>
  `${AGENT_META[kind].label} · ${modelLabel(kind, model, probe)}`;

/**
 * The transcript, and the permission prompts it no longer holds. The transcript model keeps only the
 * prompts still open — an answered one has done its job in the pane — so the page reads them back out
 * of the log with what was decided. A question is a card of its own in the transcript already, and is
 * not repeated here.
 */
export function readShareLog(events: readonly SessionEvent[]): { transcript: Transcript; permissions: SharedPermission[] } {
  const asked = new Map<string, SharedPermission>();
  for (const e of events) {
    if (e.type === "permission_request" && !questionOf(e.payload)) {
      asked.set(e.payload.requestId, { requestId: e.payload.requestId, toolName: e.payload.toolName, input: e.payload.input, title: e.payload.title, decision: null, ts: e.ts });
    }
    if (e.type === "permission_response") {
      const p = asked.get(e.payload.requestId);
      if (p) p.decision = e.payload.decision;
    }
  }
  return { transcript: reduceAll([...events]), permissions: [...asked.values()] };
}

/**
 * Everything a shared page is built from, read fresh: the session's log in full (not the stretch the
 * pane has paged in), each of Realm's sub-agents' logs under the call that started it, and every
 * picture the page could show, re-encoded by main. What is LEFT OUT is the page's decision, made per
 * the person's choices when it is built — this gathers all of it once, so flipping a switch in the
 * sheet costs a rebuild, not another read.
 */
export async function gatherShare(deps: GatherDeps): Promise<SharedSession> {
  const own = readShareLog(await deps.readLog(deps.session.id));
  const listed = await deps.children().catch(() => []);
  const children: Record<string, SharedChild[]> = {};
  const claimed = new Set<string>();
  const cwds = new Map<Transcript, string | null>([[own.transcript, deps.session.cwd]]);
  for (const b of own.transcript.blocks) {
    if (b.kind !== "tool" || !isDelegationLine(b)) continue;
    const ids = delegatedChildIds(b);
    const goal = typeof b.input["goal"] === "string" ? b.input["goal"] : null;
    // By the id its result names; a call that never answered with one, by the task it handed over —
    // the one thing the call and the child share before the call returns (DelegationLine's rule).
    const kids = listed.filter((c) => !claimed.has(c.session.id) && (ids.includes(c.session.id) || (ids.length === 0 && goal !== null && c.goal === goal)));
    if (kids.length === 0) continue;
    children[b.toolUseId] = await Promise.all(kids.map(async (c) => {
      claimed.add(c.session.id);
      const log = readShareLog(await deps.readLog(c.session.id).catch(() => []));
      cwds.set(log.transcript, c.session.cwd);
      return { title: c.session.title, agent: agentLine(c.session.agentKind, c.session.model, deps.probe), ...log };
    }));
  }

  const images: Record<string, string> = {};
  for (const [transcript, cwd] of cwds) {
    for (const path of sharedImagePaths(transcript)) {
      if (path in images) continue;
      const abs = path.startsWith("/") ? path : await deps.resolve(path, cwd);
      const data = abs ? await deps.image(abs).catch(() => null) : null;
      if (data) images[path] = data;
    }
  }

  return {
    title: deps.title,
    space: deps.space,
    agent: agentLine(deps.session.agentKind, own.transcript.init?.model ?? deps.session.model, deps.probe),
    transcript: own.transcript,
    permissions: own.permissions,
    images,
    children,
    now: deps.now,
  };
}
