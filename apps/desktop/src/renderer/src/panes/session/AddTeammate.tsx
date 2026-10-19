import { TEAMMATE_BRIEF_MAX, type AgentKind, type Session } from "@realm/contracts";
import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPopover } from "../../components/use-anchored-popover";
import { useApp } from "../../state/store";
import { useRunCatalog } from "../schedules/ScheduleRunPicker";
import { ModelPicker } from "./ModelPicker";

/**
 * "+ → Add teammate…": an agent started beside this session to help its agent, as its sub-agent.
 *
 * Three things to say and one to press. What runs it is the prompter's own picker over the same rows,
 * opening on the session's own model; what it should help with is one line, and may be left empty;
 * and where it works is the session's folder unless the checkout is a git repository, where it can
 * have a worktree of its own instead. Return in the line adds it.
 */
export function AddTeammate({ session, anchorRef, canWorktree, onClose }: {
  session: Session;
  anchorRef: RefObject<HTMLElement | null>;
  /** The session runs in a git checkout, so a worktree can be made beside it. */
  canWorktree: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const { pos, closing, close } = useAnchoredPopover({ ref, anchorRef, placement: "up", onClose, returnFocusRef: anchorRef, exit: true });
  const [pick, setPick] = useState<{ kind: AgentKind; model: string | null }>({ kind: session.agentKind, model: session.model });
  const [brief, setBrief] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [busy, setBusy] = useState(false);
  const catalog = useRunCatalog(pick.kind, pick.model);
  const addTeammate = useApp((s) => s.addTeammate);
  const toggleModelFavorite = useApp((s) => s.toggleModelFavorite);
  const eggs = useApp((s) => s.easterEggs);
  const run = useApp((s) => s.run);
  useEffect(() => { if (pos) field.current?.focus(); }, [pos !== null]);

  const add = () => {
    if (busy) return;
    setBusy(true);
    run(async () => {
      try {
        await addTeammate({ sessionId: session.id, agentKind: pick.kind, ...(pick.model ? { model: pick.model } : {}),
          ...(brief.trim() ? { brief: brief.trim() } : {}), newWorktree: canWorktree && worktree });
        close();
      } finally { setBusy(false); }
    });
  };
  return createPortal(
    <div ref={ref} className="teammate-pop" role="dialog" aria-label="Add a teammate"
      style={{ position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? "visible" : "hidden", transformOrigin: pos?.origin ?? "bottom left" }}
      data-closing={closing || undefined} inert={closing}>
      <h2 className="teammate-pop-title">Add a teammate</h2>
      <div className="teammate-pop-row">
        <span>Runs on</span>
        {/* The prompter's picker, opened from in here: part of this popover while it is up. */}
        <ModelPicker kind={pick.kind} model={pick.model} rows={catalog.rows} info={catalog.info} eggs={eggs}
          onToggleFavorite={(key) => run(() => toggleModelFavorite(key))} onPick={(kind, model) => setPick({ kind, model })} />
      </div>
      <label className="field">
        <span className="visually-hidden">What it should help with</span>
        <input ref={field} type="text" placeholder="Help with…" maxLength={TEAMMATE_BRIEF_MAX} value={brief} onChange={(e) => setBrief(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); add(); } }} />
      </label>
      {canWorktree && (
        <div className="teammate-pop-row">
          <span>Works in</span>
          <fieldset className="seg">
            <legend className="visually-hidden">Where it works</legend>
            <label className="seg-opt" data-selected={!worktree || undefined}>
              <input type="radio" name={`teammate-where-${session.id}`} checked={!worktree} onChange={() => setWorktree(false)} />
              This folder
            </label>
            <label className="seg-opt" data-selected={worktree || undefined}>
              <input type="radio" name={`teammate-where-${session.id}`} checked={worktree} onChange={() => setWorktree(true)} />
              Its own worktree
            </label>
          </fieldset>
        </div>
      )}
      <p className="teammate-pop-note">This session's agent is told it joined, and gets its report.</p>
      <div className="teammate-pop-actions">
        <button type="button" className="btn" onClick={close}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy} onClick={add}>Add teammate</button>
      </div>
    </div>,
    document.body,
  );
}
