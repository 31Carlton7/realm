import { Icon } from "@realm/ui";
import { useState } from "react";
import type { Schedule, Space } from "@realm/contracts";
import { Sheet } from "../../components/Sheet";
import { FALLBACK_AGENT, useApp } from "../../state/store";
import { ScheduleRunPicker, useRunCatalog } from "./ScheduleRunPicker";
import { constraintsOf, draftOf, draftValid, exprOf, firstRun, whenPhrase, type Draft } from "./schedule-model";
import { WhenRows } from "./ScheduleWhen";

/** What the modal opens on: a task to edit, or a draft to create from (blank, or a suggestion's). */
export type ModalOpen = { schedule: Schedule } | { draft: Draft };


/**
 * Schedule a task — Codex's modal, field for field: a name, the instructions, a card for WHEN (repeat
 * or not, how often, what time), and Advanced for HOW (a new session per run or one conversation
 * continued, archiving successes, the space, and the model it runs on). The model is the prompter's
 * own chip and picker, so its row also holds what Codex's Effort row did — the model's own levels —
 * and fast mode, beside the Full access every run starts in.
 *
 * The instructions are sent as written, because they are standing orders to an agent that will never
 * see this modal — and they may name other models for the work they hand out, which is the run's
 * business, not this form's. The Model row is the one the session itself runs on.
 *
 * The line under the card says when the first run would be, before anything is saved: for unattended
 * work it is the last honest chance to tell a right schedule from a plausible one, and Create stays
 * off until there IS a first run.
 */
export function ScheduleModal({ open, spaces, onClose, onSaved }: {
  open: ModalOpen; spaces: readonly Space[]; onClose: () => void; onSaved: (s: Schedule) => void;
}) {
  const editing = "schedule" in open ? open.schedule : null;
  const fallbackKind = useApp((s) => s.lastAgentKind ?? FALLBACK_AGENT);
  const createSchedule = useApp((s) => s.createSchedule);
  const updateSchedule = useApp((s) => s.updateSchedule);
  const run = useApp((s) => s.run);
  const [d, setD] = useState<Draft>(() => (editing ? draftOf(editing, fallbackKind) : (open as { draft: Draft }).draft));
  // The expression the edit opened on: while the draft still writes it, WHEN is untouched and the
  // task's own spelling goes back as it was.
  const [kept] = useState(() => (editing ? exprOf(draftOf(editing, fallbackKind)) : null));
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const patch = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const catalog = useRunCatalog(d.agentKind, d.model);

  const first = firstRun(d);
  const whenKept = kept !== null && exprOf(d) === kept;
  const valid = draftValid(d, Date.now(), kept);
  const submit = () => {
    if (!valid || saving) return;
    // The goal goes as typed — whitespace and all — because it is somebody's standing instructions.
    const body = {
      title: d.title.trim(), goal: d.goal, cron: editing && whenKept ? editing.cron : exprOf(d)!,
      constraints: constraintsOf(d, editing?.constraints ?? null, catalog.levels.levels.map((l) => l.id)),
      newSessionPerRun: d.newSessionPerRun, archiveSucceeded: d.archiveSucceeded,
    };
    setSaving(true);
    run(async () => {
      try {
        const saved = editing
          ? await updateSchedule({ id: editing.id, spaceId: d.spaceId, ...body })
          : await createSchedule({ spaceId: d.spaceId, enabled: true, ...body });
        onSaved(saved);
      } finally { setSaving(false); }
    });
  };

  const when = first !== null
    ? (d.repeat ? `First run ${whenPhrase(first)}.` : `Runs once, ${whenPhrase(first)}.`)
    : !d.repeat ? (whenKept ? "Its time has passed. Pick a new one to run it again." : "That time has already passed. Pick one ahead of now.")
    : "That expression will never run — check the five fields (minute, hour, day, month, weekday).";

  return (
    <Sheet title={editing ? "Edit task" : "Schedule a task"} onClose={onClose} width={520}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!valid || saving} onClick={submit}>{editing ? "Save" : "Create"}</button>
      </>}>
      <form className="sched-modal" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <input className="sched-modal-name" aria-label="Task name" placeholder="Task name" maxLength={200}
          value={d.title} onChange={(e) => patch({ title: e.target.value })} />
        <textarea className="sched-modal-goal" aria-label="Instructions" placeholder="Instructions…" rows={5} maxLength={20_000}
          value={d.goal} onChange={(e) => patch({ goal: e.target.value })} />

        <ul className="settings-list sched-modal-group">
          <li className="settings-row">
            <span className="settings-row-main"><span className="settings-row-name">Repeat task</span></span>
            <input type="checkbox" role="switch" className="switch" aria-label="Repeat task" checked={d.repeat}
              onChange={(e) => patch({ repeat: e.target.checked })} />
          </li>
          <WhenRows d={d} patch={patch} />
        </ul>
        <p className="sched-modal-when" data-invalid={(first === null && !whenKept) || undefined}>{when}</p>

        <button type="button" className="sched-modal-advanced" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}>
          Advanced <Icon name="chevronDown" size={12} />
        </button>
        {advanced && (
          <ul className="settings-list sched-modal-group">
            <li className="settings-row">
              <span className="settings-row-main">
                <span className="settings-row-name">Start each run in a new session</span>
                {/* Said only when it is off, because that is the case that behaves differently from
                    every other task: the conversation carries on, and a run still going holds the next one. */}
                {!d.newSessionPerRun && <span className="settings-row-desc">Each run continues the last run’s session</span>}
              </span>
              <input type="checkbox" role="switch" className="switch" aria-label="Start each run in a new session" checked={d.newSessionPerRun}
                onChange={(e) => patch({ newSessionPerRun: e.target.checked })} />
            </li>
            <li className="settings-row">
              <span className="settings-row-main">
                <span className="settings-row-name">Archive successful runs</span>
                <span className="settings-row-desc">Failed and interrupted runs stay visible</span>
              </span>
              <input type="checkbox" role="switch" className="switch" aria-label="Archive successful runs" checked={d.archiveSucceeded}
                onChange={(e) => patch({ archiveSucceeded: e.target.checked })} />
            </li>
            <li className="settings-row">
              <span className="settings-row-main"><span className="settings-row-name">Space</span></span>
              <select className="sched-select" aria-label="Space" value={d.spaceId} onChange={(e) => patch({ spaceId: e.target.value })}>
                {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </li>
            {/* Model and Effort are one row now: the chip names both, and its picker sets the level
                among the model's own, not a fixed five. */}
            <li className="settings-row sched-model-row">
              <span className="settings-row-main"><span className="settings-row-name">Model</span></span>
              <ScheduleRunPicker draft={d} catalog={catalog} onChange={patch} />
            </li>
          </ul>
        )}
      </form>
    </Sheet>
  );
}
