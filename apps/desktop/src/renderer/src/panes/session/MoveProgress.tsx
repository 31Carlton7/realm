import { MoveStepSchema, type MoveStep } from "@realm/contracts";
import { Icon } from "@realm/ui";
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

/** The transcript's row while the session is being moved, on one line: a done step is its check
 *  alone, and the steps still to come give way at the end. No Cancel at the last step: a move
 *  stopped while it commits would be left half-made. */
export function MoveProgress({ step, agent, onCancel }: { step: MoveStep; agent: string; onCancel?: () => void }) {
  const steps = MoveStepSchema.options;
  const at = steps.indexOf(step);
  return (
    <div className="msg-run move-progress" role="status" aria-label={`Moving: ${moveStepLabel(step, agent)}`}>
      <Spinner size={14} />
      <ol className="move-steps">
        {steps.map((s, i) => (
          i < at
            ? <li key={s} data-state="done" title={moveStepLabel(s, agent)}><Icon name="check" size={12} /><span className="visually-hidden">{moveStepLabel(s, agent)}</span></li>
            : <li key={s} data-state={i === at ? "now" : "next"}>{moveStepLabel(s, agent)}</li>
        ))}
      </ol>
      {onCancel && step !== "commit" && <button type="button" className="btn-quiet" onClick={onCancel}>Cancel</button>}
    </div>
  );
}
