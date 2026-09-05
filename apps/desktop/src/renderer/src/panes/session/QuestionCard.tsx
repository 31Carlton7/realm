import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { PendingPermission } from "./transcript-model";

export type Question = { question: string; header: string; options: { label: string; description?: string }[]; multiSelect: boolean };

/** AskUserQuestion arrives on the permission channel like any other tool, but it is not a permission —
 *  it is a question, and rendering it as Allow/Allow always/Deny buries the actual choices inside a JSON
 *  blob. `parseQuestions` is the gate: only a payload that really is question-shaped gets the question
 *  card, anything else falls back to the ordinary PermissionCard rather than rendering a broken one. */
export function parseQuestions(toolName: string, input: Record<string, unknown>): Question[] | null {
  if (toolName !== "AskUserQuestion") return null;
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Question[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") return null;
    const { question, header, options, multiSelect } = q as Record<string, unknown>;
    if (typeof question !== "string" || !Array.isArray(options) || options.length === 0) return null;
    const opts: Question["options"] = [];
    for (const o of options) {
      if (!o || typeof o !== "object") return null;
      const { label, description } = o as Record<string, unknown>;
      if (typeof label !== "string") return null;
      opts.push({ label, ...(typeof description === "string" && description ? { description } : {}) });
    }
    out.push({ question, header: typeof header === "string" ? header : "", options: opts, multiSelect: multiSelect === true });
  }
  return out;
}

/** A question the agent asked, rendered as the choice it actually is: the question, its options as a
 *  numbered list, and a free-text row — the escape hatch the tool's own schema promises ("There should
 *  be no 'Other' option, that will be provided automatically"), so the card, not the model, supplies it.
 *  One question at a time, with `n of m` paging when the agent asked several.
 *
 *  Keyboard: 1–9 pick an option outright, ↑/↓ move, Enter takes the highlighted row, Esc skips the whole
 *  request (a deny — the agent asked and got no answer, which is different from any answer it offered).
 *  Multi-select rows toggle instead of advancing, so the footer carries an explicit Continue. */
export function QuestionCard({ questions, onAnswer, onSkip, autoFocus = false, enter = false }: {
  questions: Question[];
  /** question text -> chosen label; multi-select comma-joined, matching the tool's own answer contract. */
  onAnswer: (answers: Record<string, string>) => void;
  onSkip: () => void;
  autoFocus?: boolean;
  enter?: boolean;
}) {
  const [page, setPage] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [othering, setOthering] = useState(false);
  const [otherText, setOtherText] = useState("");
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const otherInput = useRef<HTMLInputElement>(null);

  const q = questions[page]!;
  const rowCount = q.options.length + 1; // options + the free-text row
  useEffect(() => { if (autoFocus) rows.current[0]?.focus(); }, [autoFocus]);
  // Every question starts clean: a new page's selection must not inherit the previous page's row.
  useEffect(() => { setSelected(0); setPicked([]); setOthering(false); setOtherText(""); }, [page]);
  useEffect(() => { if (othering) otherInput.current?.focus(); }, [othering]);

  /** Record this question's answer and move on — or finish, handing every answer back at once. */
  const commit = (value: string) => {
    const next = { ...answers, [q.question]: value };
    setAnswers(next);
    if (page + 1 < questions.length) setPage(page + 1);
    else onAnswer(next);
  };
  /** Skip this question (no answer recorded for it); skipping the last one submits what we do have,
   *  and skipping when nothing has been answered at all is a plain deny. */
  const skipQuestion = () => {
    if (page + 1 < questions.length) { setPage(page + 1); return; }
    if (Object.keys(answers).length === 0) { onSkip(); return; }
    onAnswer(answers);
  };

  const choose = (i: number) => {
    const label = q.options[i]!.label;
    if (!q.multiSelect) { commit(label); return; }
    setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]));
  };
  const select = (i: number) => {
    const next = (i + rowCount) % rowCount;
    setSelected(next);
    rows.current[next]?.focus();
  };
  const takeSelected = () => {
    if (selected === q.options.length) { setOthering(true); return; }
    choose(selected);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (othering) {
      // While the free-text row is open it owns the keyboard: Esc backs out to the options rather than
      // skipping the request, so a mistyped "Something else" is not a dead end.
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOthering(false); rows.current[q.options.length]?.focus(); }
      else if (e.key === "Enter" && otherText.trim()) { e.preventDefault(); commit(otherText.trim()); }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onSkip(); }
    else if (e.key === "Enter") {
      const control = e.target instanceof HTMLElement ? e.target.closest("button") : null;
      if (control instanceof HTMLButtonElement) { e.preventDefault(); control.click(); return; }
      e.preventDefault();
      if (q.multiSelect) { if (picked.length) commit(picked.join(", ")); }
      else takeSelected();
    } else if (e.key === "ArrowDown") { e.preventDefault(); select(selected + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); select(selected - 1); }
    else if (e.key >= "1" && e.key <= String(Math.min(9, q.options.length)) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); choose(Number(e.key) - 1);
    }
  };

  return (
    <div className="question-card" role="group" aria-label={q.header || "Question"} data-enter={enter || undefined} onKeyDown={onKeyDown}>
      <div className="question-head">
        <h3 className="question-title">{q.question}</h3>
        {questions.length > 1 && (
          <div className="question-pager">
            <button className="icon-btn" aria-label="Previous question" disabled={page === 0} onClick={() => setPage(page - 1)}><Icon name="chevronLeft" size={14} /></button>
            <span>{page + 1} of {questions.length}</span>
            <button className="icon-btn" aria-label="Next question" disabled={page + 1 >= questions.length} onClick={() => setPage(page + 1)}><Icon name="chevronRight" size={14} /></button>
          </div>
        )}
        <button className="icon-btn question-close" aria-label="Skip question" onClick={onSkip}><Icon name="close" size={14} /></button>
      </div>

      <div className="question-options">
        {q.options.map((o, i) => (
          <button key={o.label} ref={(el) => { rows.current[i] = el; }} className="question-option"
            aria-label={o.label} aria-pressed={q.multiSelect ? picked.includes(o.label) : undefined}
            data-selected={i === selected || undefined} data-picked={picked.includes(o.label) || undefined}
            onFocus={() => setSelected(i)} onClick={() => choose(i)}>
            <kbd className="question-num">{i + 1}</kbd>
            <span className="question-option-body">
              <span className="question-option-label">{o.label}</span>
              {o.description && <span className="question-option-desc">{o.description}</span>}
            </span>
            {q.multiSelect && picked.includes(o.label) && <Icon name="check" size={14} />}
          </button>
        ))}

        {othering ? (
          <div className="question-option question-other-edit">
            <kbd className="question-num"><Icon name="edit" size={12} /></kbd>
            <input ref={otherInput} className="question-other-input" value={otherText} placeholder="Type your answer…"
              aria-label="Your answer" onChange={(e) => setOtherText(e.target.value)} />
            <button className="btn primary question-other-submit" disabled={!otherText.trim()} onClick={() => commit(otherText.trim())}>Answer</button>
          </div>
        ) : (
          <button ref={(el) => { rows.current[q.options.length] = el; }} className="question-option question-other"
            aria-label="Something else" data-selected={selected === q.options.length || undefined}
            onFocus={() => setSelected(q.options.length)} onClick={() => setOthering(true)}>
            <kbd className="question-num"><Icon name="edit" size={12} /></kbd>
            <span className="question-option-body"><span className="question-option-label">Something else</span></span>
            <span className="question-skip" role="button" tabIndex={-1}
              onClick={(e) => { e.stopPropagation(); skipQuestion(); }}>Skip</span>
          </button>
        )}
      </div>

      <div className="question-footer">
        <div className="question-hints">
          <span><kbd>↑↓</kbd> Navigate</span><span><kbd>↵</kbd> Select</span><span><kbd>esc</kbd> Skip</span>
        </div>
        {q.multiSelect && (
          <button className="btn primary question-continue" disabled={!picked.length} onClick={() => commit(picked.join(", "))}>
            Continue <kbd>↩</kbd>
          </button>
        )}
      </div>
    </div>
  );
}

/** Convenience wrapper for the transcript: takes the raw pending permission and decides whether this is
 *  a question at all. Returns null when it is not, so the caller can render the permission card. */
export function questionCardFor(permission: PendingPermission): Question[] | null {
  return parseQuestions(permission.toolName, permission.input);
}
