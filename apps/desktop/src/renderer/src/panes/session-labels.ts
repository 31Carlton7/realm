import type { DispatchKind } from "@realm/contracts";

/** Origin glyph + words per dispatch kind (Plan 13 W2). The agent kinds carry a parent-session link
 *  in the row; `user-dispatch` has no parent by definition.
 *
 *  Shared by the Tasks lens and the delegating session's own dock, so a delegated child is named the
 *  same way whether the user meets it in a list of everything or beside the agent that spawned it. */
export const ORIGIN_META: Record<DispatchKind, { icon: string; label: string }> = {
  "user-dispatch": { icon: "send", label: "Dispatched (⌘⇧↵)" },
  agent_run: { icon: "bot", label: "Delegated via agent_run" },
  browser_agent_run: { icon: "browser", label: "Browser agent" },
  review: { icon: "diff", label: "Reviewer" },
  fork: { icon: "branch", label: "Forked from a checkpoint" },
  import: { icon: "download", label: "Imported from an agent CLI" },
  run: { icon: "bot", label: "Durable run" },
};

export const SESSION_STATUS_LABEL = { idle: "idle", running: "running", waiting_permission: "needs permission", error: "error", ended: "ended" } as const;
