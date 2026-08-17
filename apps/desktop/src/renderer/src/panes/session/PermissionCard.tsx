import { Icon } from "@realm/ui";
import type { PermissionDecision } from "../../state/store";
import type { PendingPermission } from "./transcript-model";
import { clip, prettyJson, toolIcon, toolSummary } from "./tool-summary";

/** The agent wants to run a tool: Allow (once) / Allow always / Deny. */
export function PermissionCard({ permission, onDecide }: { permission: PendingPermission; onDecide: (d: PermissionDecision) => void }) {
  const summary = clip(toolSummary(permission.toolName, permission.input), 200);
  return (
    <div className="permission-card" role="group" aria-label="Permission request">
      <div className="permission-head"><Icon name="alert" size={15} /><span>{permission.title}</span></div>
      <div className="permission-tool"><Icon name={toolIcon(permission.toolName)} size={14} /><span className="tool-name">{permission.toolName}</span>{summary && <code>{summary}</code>}</div>
      <details className="permission-details"><summary>Input</summary><pre>{prettyJson(permission.input)}</pre></details>
      <div className="permission-actions">
        <button className="btn" onClick={() => onDecide("deny")}>Deny</button>
        <button className="btn" onClick={() => onDecide("allow_always")}>Allow always</button>
        <button className="btn primary" onClick={() => onDecide("allow")}>Allow</button>
      </div>
    </div>
  );
}
