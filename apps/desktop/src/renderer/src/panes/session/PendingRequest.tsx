import type { PermissionDecision } from "../../state/store";
import { PermissionCard } from "./PermissionCard";
import { PlanDecision, isPlanDecision } from "./PlanCard";
import { QuestionCard, questionCardFor } from "./QuestionCard";
import type { PendingPermission } from "./transcript-model";

/**
 * One request an agent is blocked on, drawn as what it is.
 *
 * Everything arrives on the permission channel, and three different things travel on it: a question
 * (`AskUserQuestion` — its options and a field for an answer of your own), a plan waiting to be
 * approved (`ExitPlanMode`), and a permission proper (Allow / Allow always / Deny). Which card a
 * request gets is decided HERE, once, so every surface that answers in place — the transcript and
 * the Agents page — asks the same question in the same shape, with the same keys.
 */
export function PendingRequest({ permission, onDecide, autoFocus = false, enter = false }: {
  permission: PendingPermission;
  /** `answers` only from a question: question text → the label chosen or typed. */
  onDecide: (d: PermissionDecision, answers?: Record<string, string>) => void;
  autoFocus?: boolean;
  enter?: boolean;
}) {
  const questions = questionCardFor(permission);
  if (questions) {
    return <QuestionCard questions={questions} autoFocus={autoFocus} enter={enter}
      onAnswer={(answers) => onDecide("allow", answers)} onSkip={() => onDecide("deny")} />;
  }
  // A plan is not a permission. The plan itself is a block in the transcript already (mapped off the
  // same tool call), so this is only the answer to it.
  if (isPlanDecision(permission)) return <PlanDecision autoFocus={autoFocus} enter={enter} onDecide={(d) => onDecide(d)} />;
  return <PermissionCard permission={permission} autoFocus={autoFocus} enter={enter} onDecide={(d) => onDecide(d)} />;
}
