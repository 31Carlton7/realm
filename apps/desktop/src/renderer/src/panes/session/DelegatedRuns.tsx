import { Icon } from "@realm/ui";
import { useRef } from "react";
import { bareToolName, type Session } from "@realm/contracts";
import { useApp } from "../../state/store";
import { useDissolve } from "../../components/ScrollFades";
import { CHILD_ORIGINS, ORIGIN_META, SESSION_STATUS_LABEL } from "../session-labels";
import { isHarnessLaunch, SUBAGENT_TOOLS, type ToolBlock } from "./tool-group";
import type { SubagentState } from "../agents-tab/subagent-state";
import type { Block } from "./transcript-model";

/**
 * Whether this call still has an agent working behind it — the two ways that can be true, because
 * the harness runs sub-agents in two modes and they look nothing alike on the wire.
 *
 * **Blocking**: the call stays open for the agent's whole life, so an unfinished call IS a running
 * agent. Recognised by tool name, which is all there is to go on before a result exists.
 *
 * **Background**: the call returns in about a second — "Async agent launched successfully" — and the
 * agent then runs for minutes. The result being present says nothing about whether it is done. This
 * is the case that showed nothing at all: ten background agents were ten completed tool calls as far
 * as this list could tell. `background` is set by the adapter, off the harness's own launch text and
 * completion notification, and it is the only honest signal for the mode.
 */
export function stillWorking(b: Extract<Block, { kind: "tool" }>, live = true): boolean {
  if (b.background !== undefined) return b.background === "running";
  return SUBAGENT_TOOLS.has(b.name) && b.result === null && live;
}

/** One of the session's own in-harness sub-agents, in any state — the inline strip's and the Agents
 *  tab's row for it. `endedAt` is null while it works. */
export type HarnessAgent = { id: string; label: string; startedAt: number; endedAt: number | null; state: SubagentState };

/**
 * Where a harness sub-agent stands. The harness reports no more than started, stopped and the
 * launching call's result, so it is one of four: still `working` (see `stillWorking`); `failed` where
 * the call came back an error; `done` where it came back or the background agent stopped; and
 * `stopped` for a blocking call whose session is no longer live — the turn was cut off under it and
 * no result will ever land, so calling it working would keep a clock running forever.
 */
export function harnessState(b: ToolBlock, live = true): SubagentState {
  if (b.background !== undefined) return b.background === "running" ? "working" : "done";
  if (b.result) return b.result.isError ? "failed" : "done";
  return live ? "working" : "stopped";
}

/**
 * Sub-agents the HARNESS ran for this session, read off the transcript — every one, finished or not.
 *
 * These are a different animal to a delegated run and the difference is why they were invisible:
 * `agent_run` creates a real Realm session, with a row, a pane and a place in the layout. Claude's
 * own `Task`/`Agent` tools create none of that — the subagent lives and dies inside the CLI process,
 * and the only trace it leaves on the wire is its launching call. See `stillWorking` for the two very
 * different shapes that trace takes.
 *
 * `live` is whether the session itself is mid-turn: a blocking call outlives nothing.
 */
export function harnessAgents(blocks: readonly Block[], live = true): HarnessAgent[] {
  return blocks
    // A call made UNDER another Task is that Task's business, not a second row here.
    .filter((b): b is ToolBlock => b.kind === "tool" && isHarnessLaunch(b))
    .map((b) => {
      const state = harnessState(b, live);
      return {
        id: b.toolUseId,
        // `name` is what a Workflow calls itself; `description` is Task's. Falling through both before
        // the prompt, because a prompt's first eighty characters are usually boilerplate.
        label: labelOf(b.input).slice(0, 80),
        // The START, not an elapsed span frozen at the moment this list was last rebuilt. A background
        // agent produces no transcript events while it runs, so the list is rebuilt once and then not
        // again for ten minutes — a precomputed duration would sit at "0s" for the entire run, next to
        // a header clock that ticks. Each surface's one clock subtracts this instead.
        startedAt: b.ts,
        endedAt: state === "working" ? null : b.endedAt ?? null,
        state,
      };
    });
}

/** The ones still working. */
export function harnessSubagents(blocks: readonly Block[], live = true): { id: string; label: string; startedAt: number }[] {
  return harnessAgents(blocks, live).filter((h) => h.state === "working").map(({ id, label, startedAt }) => ({ id, label, startedAt }));
}

/** What to call an in-flight sub-agent run. A Workflow names itself in its script's `meta`, which is
 *  the only place its name exists — so it is dug out rather than left as "Sub-agent". */
export function labelOf(input: Record<string, unknown>): string {
  const direct = input.description ?? input.name;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const script = typeof input.script === "string" ? input.script : "";
  const named = script.match(/name:\s*['"`]([^'"`]+)['"`]/)?.[1];
  if (named) return named;
  const prompt = input.prompt;
  return typeof prompt === "string" && prompt.trim() ? prompt.trim() : "Sub-agent";
}

/** The delegation calls whose RESULT names the sessions they started or collected, by the name every
 *  harness ends it with (`bareToolName`). The input names none: the child did not exist yet. */
const DELEGATION_CALLS = new Set(["agent_run", "agent_start", "agent_wait", "browser_agent_run", "agent_review"]);
const SESSION_ID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;

/**
 * The ids a delegation call's result names, first mention first — the server's own trail after each
 * report (`Child session: {…}`, `agent_start`'s handle, each `agent_wait` heading, the browser agent's
 * and the reviewer's). Candidates, not children: `ChildSessions` keeps only the ones this window knows
 * as a delegated session, so an id that happens to sit inside a child's REPORT is never made a link.
 */
export function delegatedChildIds(b: ToolBlock): string[] {
  if (!b.result || !DELEGATION_CALLS.has(bareToolName(b.name))) return [];
  return [...new Set(b.result.content.match(SESSION_ID) ?? [])];
}

/** Preview a delegated child as a tab of its lead's side pane — the point of going to look is to see
 *  the child beside the session that spawned it, and `openItem` would evict the pane the click came
 *  from. The keyboard stays with the lead, whose prompter the user is in. A lead that is not on
 *  screen leaves nothing to be beside, so the child opens beside the focused pane; a child this
 *  window holds no item for (another space) is revealed. One way in, for the control and for the
 *  call's own rows, because it is one object. */
export function useOpenChild(): (childId: string) => void {
  const items = useApp((s) => s.items);
  const sessions = useApp((s) => s.sessions);
  const openInSidePane = useApp((s) => s.openInSidePane);
  const openItemBeside = useApp((s) => s.openItemBeside);
  const revealSession = useApp((s) => s.revealSession);
  const run = useApp((s) => s.run);
  return (childId) => {
    const it = items.find((i) => i.kind === "session" && i.refId === childId);
    const lead = sessions[childId]?.dispatchedBy?.sessionId ?? null;
    run(async () => {
      if (!it) { await revealSession(childId, null); return; }
      if (lead && await openInSidePane(lead, it.id)) return;
      await openItemBeside(it.id);
    });
  };
}

/**
 * The delegated sessions a call started or reported, hanging off the call itself.
 *
 * The dock above the prompter lists a child only while it RUNS, and Realm takes a finished child's
 * pane back out of the layout — so without this, the moment a child was done its transcript was one
 * sidebar search away from the report it produced. The call is where that report lands, so the way
 * back lives on it: the dock's own row and the dock's own jump, on the trace rail a sub-agent's calls
 * hang from, because it is the same object reached from a second place.
 */
export function ChildSessions({ ids }: { ids: readonly string[] }) {
  const sessions = useApp((s) => s.sessions);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const openAgentsTab = useApp((s) => s.openAgentsTab);
  const run = useApp((s) => s.run);
  const openChild = useOpenChild();
  // A child is looked at in its lead's Agents tab, the one way every sub-agent opens. One whose lead
  // is not on record has no tab to open in, and is previewed as the session it is.
  const open = (c: Session) => {
    const lead = c.dispatchedBy?.sessionId;
    if (lead) run(() => openAgentsTab(lead, { childId: c.id })); else openChild(c.id);
  };
  const list = useRef<HTMLUListElement>(null);
  useDissolve(list);
  const children = ids.map((id) => sessions[id])
    .filter((c): c is Session => c?.dispatchedBy != null && CHILD_ORIGINS.has(c.dispatchedBy.kind));
  if (children.length === 0) return null;
  return (
    <ul className="delegation-list" ref={list} aria-label="Delegated sessions">
      {children.map((c) => {
        const meta = ORIGIN_META[c.dispatchedBy!.kind];
        const status = sessionStatus[c.id] ?? c.status;
        return (
          <li key={c.id}>
            <button type="button" className="delegation-item" title={meta.label}
              aria-label={`${c.title} — ${meta.label}`} onClick={() => open(c)}>
              <Icon name={meta.icon} size={14} />
              <span className="delegation-title">{c.title}</span>
              <span className="status-dot item-status" data-status={status} title={SESSION_STATUS_LABEL[status]} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
