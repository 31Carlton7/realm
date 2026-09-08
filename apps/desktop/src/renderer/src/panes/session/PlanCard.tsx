import { Icon } from "@realm/ui";
import { useEffect, useRef, useState } from "react";
import type { PermissionDecision } from "../../state/store";
import { Markdown } from "./Markdown";
import { TodoList } from "./rich/ToolViews";
import type { PendingPermission, PlanStep } from "./transcript-model";

/**
 * A plan as one markdown document — what a copy lands on the clipboard and what a download writes.
 *
 * Composed rather than stored, because the two protocols send two different artifacts (see the
 * `plan` session event) and neither is derivable from the other: prose arrives as markdown, a
 * checklist as steps with status. A reader copying a plan wants both, in the order the card draws
 * them, and wants the checklist to still read as a checklist in whatever they paste it into — so
 * steps become task-list items with their status in the box.
 */
export function planMarkdown({ text, steps }: { text?: string; steps?: PlanStep[] }): string {
  const parts: string[] = [];
  if (steps && steps.length > 0) {
    parts.push(steps.map((s) => `- [${s.status === "completed" ? "x" : " "}] ${s.text}`).join("\n"));
  }
  if (text) parts.push(text.trim());
  return parts.join("\n\n");
}

/** Enough of a filename to find it again: the plan's own first line, or the day it was made. */
const planFileName = (title: string): string => {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return `${slug || "plan"}.md`;
};

/**
 * The plan the agent proposed, drawn as a plan.
 *
 * Two bodies rather than one, because the protocols send two different artifacts and neither can be
 * derived from the other (see the `plan` session event): prose renders as the markdown it is, a
 * checklist reuses `TodoList` — the same drawing TodoWrite already gets, and for the same reason,
 * since a plan with per-step status IS a to-do list. A plan carrying both draws both.
 *
 * The card is a PREVIEW. A plan runs to a page or more of markdown, and a session that produced two
 * of them used to push everything either side of them off the screen; the body is capped and the
 * rest is behind Expand, which opens the same plan as a sheet with room for it. Copy and download
 * are there too, because the thing a reader most often wants to do with a plan is take it somewhere
 * else — and both act on the WHOLE plan, never on the preview.
 */
export function PlanCard({ text, steps, onExpand, enter = false }: {
  text?: string; steps?: PlanStep[];
  /** Open the whole plan. Passed down from the pane rather than reached for from the store, because
   *  this card also renders in the read-only mounts (the fork preview, the suite), which have no
   *  store and no sheet host. Absent means the button is not drawn — never drawn dead. */
  onExpand?: () => void;
  enter?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  /* Whether the preview is actually cutting anything off. CSS cannot answer that — `max-height`
     clips without telling anyone — so the fade band would otherwise be drawn over the blank half of
     every short plan. Re-measured on every render because a streaming plan grows into the cap. */
  const preview = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const el = preview.current; if (!el) return;
    setClipped(el.scrollHeight > el.clientHeight + 1);
  });
  const markdown = planMarkdown({ text, steps });
  const title = firstLine(markdown);

  return (
    <div className="plan-card" role="group" aria-label="Plan" data-enter={enter || undefined}>
      <div className="plan-head">
        <Icon name="plan" size={14} /><span>Plan</span>
        <div className="plan-actions">
          <button type="button" className="icon-btn" aria-label={copied ? "Plan copied" : "Copy plan"}
            title={copied ? "Copied" : "Copy plan"}
            onClick={() => { void navigator.clipboard?.writeText(markdown); setCopied(true); }}>
            <Icon name={copied ? "check" : "copy"} size={14} />
          </button>
          <button type="button" className="icon-btn" aria-label="Download plan" title="Download plan"
            onClick={() => { void window.realm?.saveText?.({ name: planFileName(title), text: markdown }); }}>
            <Icon name="download" size={14} />
          </button>
          {onExpand && (
            <button type="button" className="icon-btn" aria-label="Expand plan" title="Expand plan" onClick={onExpand}>
              <Icon name="expand" size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="plan-preview" ref={preview} data-clipped={clipped || undefined}>
        {steps && steps.length > 0 && <TodoList todos={steps.map((s) => ({ content: s.text, status: s.status, activeForm: null }))} />}
        {text && <Markdown text={text} className="plan-body" />}
      </div>
    </div>
  );
}

const firstLine = (md: string): string =>
  md.split("\n").map((l) => l.replace(/^[-*#\s>]+|\[[ x]\]/g, "").trim()).find((l) => l !== "") ?? "plan";

/**
 * The decision on a plan, when the agent is waiting for one.
 *
 * `ExitPlanMode` reaches Realm on the permission channel like any other tool, and that channel is
 * load-bearing: answering it is how the session leaves Plan. What it is NOT is a permission —
 * "Allow / Allow always / Deny" on a plan asks the wrong question, and the generic card buried the
 * plan itself in a clipped one-line summary.
 *
 * So the plan is a block of its own (mapped off the same tool call, and it stays in the scrollback
 * after the decision), and this is only the answer to it: approve, or keep planning. There is no
 * "always" — a standing grant to leave Plan unasked is not a thing a user can mean.
 */
export const isPlanDecision = (p: PendingPermission): boolean => p.toolName === "ExitPlanMode";

export function PlanDecision({ onDecide, autoFocus = false, enter = false }: {
  onDecide: (d: PermissionDecision) => void; autoFocus?: boolean; enter?: boolean;
}) {
  return (
    <div className="plan-decision" role="group" aria-label="Plan approval" data-enter={enter || undefined}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onDecide("deny"); } }}>
      <span className="plan-decision-ask">Ready to build this?</span>
      <div className="plan-decision-actions">
        <button type="button" className="plan-approve" autoFocus={autoFocus} onClick={() => onDecide("allow")}>Implement this plan</button>
        <button type="button" className="plan-reject" onClick={() => onDecide("deny")}>Keep planning</button>
      </div>
    </div>
  );
}
