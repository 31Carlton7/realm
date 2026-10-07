import type { AskAnswers } from "@realm/contracts";
import type { PermissionDecision } from "../../state/store";
import { PermissionCard } from "./PermissionCard";
import { PlanDecision, isPlanDecision } from "./PlanCard";
import { QuestionCard, askCardFor } from "./QuestionCard";
import type { PendingPermission } from "./transcript-model";

/**
 * One request an agent is blocked on, drawn as what it is.
 *
 * Everything arrives on the permission channel, and three different things travel on it: a question
 * (any agent's, or an MCP server's — its fields, and an answer of your own where one is offered), a
 * plan waiting to be approved (`ExitPlanMode`), and a permission proper (Allow / Allow always / Deny).
 * Which card a request gets is decided HERE, once, so every surface that answers in place — the
 * transcript, the sidebar's Needs you, Notifications — asks the same question in the same shape, with
 * the same keys.
 *
 * A question is told apart by its card (`askCardFor`), which Realm wrote, and never by the tool's
 * name alone or by the shape of its arguments: those are the agent's, and a permission that could be
 * made to look like a question would be one whose "answer" is an Allow.
 */
export function PendingRequest({ permission, onDecide, autoFocus = false, enter = false, ownsEscape = true }: {
  permission: PendingPermission;
  /** `answers` only from a question: question id → what was chosen or typed. */
  onDecide: (d: PermissionDecision, answers?: AskAnswers) => void;
  autoFocus?: boolean;
  enter?: boolean;
  /** False on a surface whose Escape means "leave" — see the cards' own `ownsEscape`. */
  ownsEscape?: boolean;
}) {
  const card = askCardFor(permission);
  if (card) {
    return <QuestionCard card={card} autoFocus={autoFocus} enter={enter} ownsEscape={ownsEscape}
      onAnswer={(answers) => onDecide("allow", answers)} onSkip={() => onDecide("deny")} />;
  }
  // A plan is not a permission. The plan itself is a block in the transcript already (mapped off the
  // same tool call), so this is only the answer to it.
  if (isPlanDecision(permission)) return <PlanDecision autoFocus={autoFocus} enter={enter} ownsEscape={ownsEscape} onDecide={(d) => onDecide(d)} />;
  return <PermissionCard permission={permission} autoFocus={autoFocus} enter={enter} ownsEscape={ownsEscape} onDecide={(d) => onDecide(d)} />;
}
