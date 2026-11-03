import { normalizeHandle, teammateByHandle, teammateWords, type Teammate } from "@realm/contracts";
import { Icon, TeammateIcon } from "@realm/ui";
import { createContext, useContext } from "react";
import { Spinner } from "../../components/Spinner";
import { useApp } from "../../state/store";
import type { ToolBlock } from "./tool-group";

/** The space's teammates, and the newest message to each in this transcript (`newestTeammateCalls`).
 *  Null `newest` reads every call as the newest, for a mount that does not know the rest. */
export const TeammateCallsContext = createContext<{ teammates: readonly Teammate[]; newest: ReadonlySet<string> | null }>({ teammates: [], newest: null });

type TeammateCallState = "working" | "needs-you" | "done";

const STATE_LABEL: Record<TeammateCallState, string> = { working: "Working", "needs-you": "Needs you", done: "Done" };

/** Where a message to a teammate stands. The newest one to it says what the teammate is doing now,
 *  from the same state the sidebar's row reads; one still waiting on its answer is working whatever
 *  that says, and any other has been answered or overtaken. */
function teammateCallState(block: ToolBlock, teammate: Teammate | null, newest: boolean): TeammateCallState {
  if (block.result === null) return teammate?.state === "needs-you" ? "needs-you" : "working";
  if (!teammate || !newest || teammate.state === "idle") return "done";
  return teammate.state;
}

/**
 * A `team_message`, as the sender's transcript shows it: the teammate it went to — its icon, its name,
 * its handle — what it was asked, and what it is doing about it, with a click to its chat. The raw
 * call and its "Sent to @x" are not drawn; the teammate's own chat is where its answer is.
 */
export function TeammateCallLine({ block, enter = false }: { block: ToolBlock; enter?: boolean }) {
  const { teammates, newest } = useContext(TeammateCallsContext);
  const openTeammate = useApp((s) => s.openTeammate);
  const run = useApp((s) => s.run);
  const to = typeof block.input.to === "string" ? block.input.to : "";
  const teammate = teammateByHandle(teammates, to);
  const state = teammateCallState(block, teammate, newest?.has(block.toolUseId) ?? true);
  const handle = teammate?.handle ?? normalizeHandle(to);
  const message = teammateWords(typeof block.input.message === "string" ? block.input.message : "");
  const name = teammate?.name ?? `@${handle}`;
  return (
    <div className="tool-card delegation-line teammate-call" data-tool-use-id={block.toolUseId} data-state={state} data-enter={enter || undefined}>
      <button type="button" className="tool-row" disabled={!teammate}
        title={teammate ? "Open its chat" : undefined}
        aria-label={`${name}, ${STATE_LABEL[state]}: ${message}`}
        onClick={() => { if (teammate) run(() => openTeammate(teammate.id)); }}>
        <span className="tool-status" aria-hidden="true"><CallMark state={state} /></span>
        {teammate && <TeammateIcon icon={teammate.icon} size={16} lead={teammate.lead} />}
        <span className="tool-name">{name}</span>
        {teammate && <span className="teammate-call-handle">@{handle}</span>}
        <span className="delegation-line-task" title={message}>{message}</span>
        <span className="delegation-line-time">{STATE_LABEL[state]}</span>
      </button>
    </div>
  );
}

function CallMark({ state }: { state: TeammateCallState }) {
  switch (state) {
    case "working": return <Spinner size={16} />;
    case "needs-you": return <span className="status-dot" data-status="waiting_permission" />;
    case "done": return <Icon name="check" size={14} />;
  }
}
