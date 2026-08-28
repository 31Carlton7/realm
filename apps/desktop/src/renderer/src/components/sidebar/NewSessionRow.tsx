import { AGENT_META } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { FALLBACK_AGENT, useApp } from "../../state/store";

/**
 * The sidebar's "+" (W3). It replaces the old NewItemMenu: creating a session asks nothing, so there is
 * no menu to open and no sheet behind it — one click makes the session and lands in the hero prompter,
 * where the agent/model/permission chips carry every choice.
 *
 * Terminals kept their own routes (space menu → New terminal, ⌘T, palette), so nothing was orphaned by
 * dropping the menu; the browser-tab placeholder went with it rather than living on as a dead row.
 */
export function NewSessionRow() {
  const newSessionInstant = useApp((s) => s.newSessionInstant);
  const agent = useApp((s) => s.lastAgentKind ?? FALLBACK_AGENT);
  const run = useApp((s) => s.run);
  return (
    <div className="new-item">
      <div className="sb-divider" />
      <button className="item-row new-row" aria-label="New session" title={`New ${AGENT_META[agent].label} session (⌘N)`}
        onClick={() => run(() => newSessionInstant())}><Icon name="add" size={14} /><span>New session</span></button>
    </div>
  );
}
