import { MoveStepSchema, type MoveStep } from "@realm/contracts";
import { Spinner } from "../../components/Spinner";

/** What each step of a move is called on screen, for the agent being moved. */
export function moveStepLabel(step: MoveStep, agent: string): string {
  switch (step) {
    case "preflight": return "Checking";
    case "freeze": return `Pausing ${agent}`;
    case "snapshot": return "Saving a checkpoint";
    case "place": return "Setting up the checkout";
    case "boot": return `Starting ${agent}`;
    case "commit": return "Finishing";
  }
}

/**
 * The transcript's row while the session is being moved: every step in order, the one under way in
 * ink beside the spinner. Cancel is offered until the last step, where the move can no longer be
 * stopped without leaving it half-made.
 */
export function MoveProgress({ step, agent, onCancel }: { step: MoveStep; agent: string; onCancel?: () => void }) {
  const steps = MoveStepSchema.options;
  const at = steps.indexOf(step);
  return (
    <div className="msg-run move-progress" role="status" aria-label={`Moving: ${moveStepLabel(step, agent)}`}>
      <Spinner size={12} />
      <ol className="move-steps">
        {steps.map((s, i) => (
          <li key={s} data-state={i < at ? "done" : i === at ? "now" : "next"}>{moveStepLabel(s, agent)}</li>
        ))}
      </ol>
      {onCancel && step !== "commit" && <button type="button" className="btn-quiet" onClick={onCancel}>Cancel</button>}
    </div>
  );
}
