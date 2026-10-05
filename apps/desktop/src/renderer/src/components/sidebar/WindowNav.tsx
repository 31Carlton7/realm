import { Icon } from "@realm/ui";
import { useApp } from "../../state/store";
import { useChord } from "./use-sidebar-model";

/**
 * Go back and Go forward through the window's trail (⌃- and ⌃⇧- by default) — every place the keyboard
 * has been, the same steps the Go menu takes. Greyed at either end rather than hidden, so the pair
 * never moves.
 *
 * ONE pair, in the window's head row beside the traffic lights (WindowLead), in the same place
 * whether or not there is a sidebar — Codex's top-left. Each pane's bar carried a second pair
 * for its own trail, and two sets of arrows a few inches apart, walking different histories, was a
 * choice nobody could see the difference between. The pane's trail is still walked from the keyboard
 * (⌘[ and ⌘]).
 */
export function WindowNav() {
  const canBack = useApp((s) => s.canStepWindow(-1));
  const canForward = useApp((s) => s.canStepWindow(1));
  const stepWindow = useApp((s) => s.stepWindow);
  const run = useApp((s) => s.run);
  const back = useChord("window.back");
  const forward = useChord("window.forward");
  return (
    <div className="rail-nav">
      <button type="button" className="rail-nav-btn" aria-label="Go back" title={back ? `Go back (${back})` : "Go back"}
        disabled={!canBack} onClick={() => run(() => stepWindow(-1))}><Icon name="chevronLeft" size={14} /></button>
      <button type="button" className="rail-nav-btn" aria-label="Go forward" title={forward ? `Go forward (${forward})` : "Go forward"}
        disabled={!canForward} onClick={() => run(() => stepWindow(1))}><Icon name="chevronRight" size={14} /></button>
    </div>
  );
}
