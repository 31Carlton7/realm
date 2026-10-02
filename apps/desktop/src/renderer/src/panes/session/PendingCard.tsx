import type { PermissionDecision } from "../../state/store";
import { PermissionCard } from "./PermissionCard";
import { PlanDecision, isPlanDecision } from "./PlanCard";
import { QuestionCard, questionCardFor } from "./QuestionCard";
import type { PendingPermission } from "./transcript-model";

/**
 * One open request on the permission channel, as the card it really is — the transcript's, and the
 * "need you" list's, so a request answered from either is the same request drawn the same way.
 *
 * Only what really is a permission keeps the Allow / Allow always / Deny gate. A question is its
 * options; a plan is not a permission either — the plan itself is a block of the transcript (mapped
 * off the same tool call), so this is only the answer to it.
 */
export function PendingCard({ permission, onDecide, onAnswer, autoFocus = false, enter = false }: {
  permission: PendingPermission;
  onDecide: (decision: PermissionDecision) => void;
  /** A question's answers — an allow, carrying what was picked. */
  onAnswer: (answers: Record<string, string>) => void;
  autoFocus?: boolean;
  enter?: boolean;
}) {
  const questions = questionCardFor(permission);
  if (questions) return <QuestionCard questions={questions} autoFocus={autoFocus} enter={enter}
    onAnswer={onAnswer} onSkip={() => onDecide("deny")} />;
  if (isPlanDecision(permission)) return <PlanDecision autoFocus={autoFocus} enter={enter} onDecide={onDecide} />;
  return <PermissionCard permission={permission} autoFocus={autoFocus} enter={enter} onDecide={onDecide} />;
}
