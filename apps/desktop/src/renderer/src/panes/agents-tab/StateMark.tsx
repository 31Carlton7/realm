import { Icon } from "@realm/ui";
import type { SubagentState } from "./subagent-state";

/** The state's mark: the session dot where something is live, the transcript's own glyphs where it
 *  has ended — so the tab and the tool rows above it say "done" and "failed" with the same shapes. */
export function StateMark({ state }: { state: SubagentState }) {
  switch (state) {
    case "working": return <span className="status-dot" data-status="running" aria-hidden="true" />;
    case "waiting": return <span className="status-dot" data-status="waiting_permission" aria-hidden="true" />;
    case "queued": return <span className="status-dot" data-status="idle" aria-hidden="true" />;
    case "done": return <Icon name="check" size={12} />;
    case "failed": case "timeout": return <Icon name="errorCircle" size={12} />;
    case "stopped": case "cancelled": return <Icon name="stop" size={12} />;
  }
}
