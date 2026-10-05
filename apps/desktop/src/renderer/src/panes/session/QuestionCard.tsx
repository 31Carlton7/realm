import { AGENT_META, HIDDEN_ANSWER, type AgentKind, type AskAnswers, type AskCard, type AskOption, type AskQuestion, type Asker, type DelegableModel, type ProjectFileHit } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useThumbnail } from "../../components/use-thumbnail";
import { useAppStoreMaybe } from "../../state/store";
import { ModelChooser, OWN } from "../agents-tab/ModelChooser";
import { questionOf, type PendingPermission } from "./transcript-model";

/** Who is asking, as the card says it: "Codex asks", "Linear's MCP server asks". The name is the
 *  one the user knows — an agent's own, a server's as they named it in Connections. */
export function askerLine(a: Asker, past = false): string {
  const verb = past ? "asked" : "asks";
  const who = a.kind === "server" ? `${a.name}'s MCP server` : a.name;
  return a.via ? `${who} ${verb}, through ${a.via}` : `${who} ${verb}`;
}

/** An agent wears its own mark; a server, the plug every Connection wears. */
export function askerIcon(a: Asker): string {
  return a.kind === "server" ? "plug" : a.agent ? AGENT_META[a.agent].icon : "bot";
}

/**
 * The question a pending request is, or null when it is not one.
 *
 * Routed on the CARD — Realm's own record, written by an adapter or the server, never by an agent's
 * arguments — and validated (`questionOf`), so a malformed one falls back to the ordinary permission
 * card rather than drawing a card with no row to answer on. A card Realm already declined is not a
 * question anyone is waiting on.
 */
export function askCardFor(p: Pick<PendingPermission, "toolName" | "input" | "ask">): AskCard | null {
  const card = questionOf(p);
  return card && card.refused === undefined ? card : null;
}

/**
 * A question an agent (or a server) asked, drawn as Realm's own card — whichever protocol it came in
 * on. One question at a time, with `n of m` paging when there are several, and each kind of question
 * with the field it needs:
 *
 *  - **choice / multi / confirm / branch** — the options as a numbered list (pictures as tiles), a
 *    field for an answer of your own where the asker offered one. 1–9 pick outright, ↑/↓ move, Enter
 *    takes the highlighted row; several picks toggle and Continue sends them.
 *  - **text / time** — the field itself, masked for a secret, with where the answer goes said beside it.
 *  - **model** — a row per step, each wearing Realm's model chip, defaulted to the session's model.
 *  - **file** — the workspace, searched as ⌘P searches it.
 *  - **link** — the page's whole address, its host set apart, opened by the system browser on a click.
 *
 * Esc skips the whole request (declines a form): the asker asked and got no answer, which is different
 * from any answer it offered. `ownsEscape` false hands Escape to the surface instead.
 *
 * Everything the asker sent is drawn as plain text. Nothing here renders markup, follows a link or
 * loads a picture from anywhere but main's thumbnailer, which reads a path Realm already checked.
 */
export function QuestionCard({ card, onAnswer, onSkip, autoFocus = false, enter = false, ownsEscape = true }: {
  card: AskCard;
  /** Question id -> what was chosen or typed; several as a list. */
  onAnswer: (answers: AskAnswers) => void;
  onSkip: () => void;
  autoFocus?: boolean;
  enter?: boolean;
  /** False where the surface around the card owns Escape (the Agents page, the need-you list), so
   *  Escape leaves it instead: the card then neither answers on Escape nor offers it as a key. */
  ownsEscape?: boolean;
}) {
  const [page, setPage] = useState(0);
  const [answers, setAnswers] = useState<AskAnswers>({});
  const [focusBody, setFocusBody] = useState(autoFocus);
  const root = useRef<HTMLDivElement>(null);
  const q = card.questions[page]!;
  const count = card.questions.length;
  const dismiss = card.mode === "question" ? "Skip" : "Decline";

  /** Change page, carrying the keyboard along when it was in the card. */
  const go = (next: number) => {
    setFocusBody(root.current?.contains(document.activeElement) ?? false);
    setPage(next);
  };
  /** Record this question's answer and move on — or finish, handing every answer back at once. */
  const commit = (value: string | string[]) => {
    const next = { ...answers, [q.id]: value };
    setAnswers(next);
    if (page + 1 < count) go(page + 1);
    else onAnswer(next);
  };
  /** Skip this question (no answer kept for it, even one given before paging back); skipping the
   *  last one submits what we do have, and skipping when nothing has been answered is a plain skip. */
  const skipQuestion = () => {
    const rest = Object.fromEntries(Object.entries(answers).filter(([id]) => id !== q.id));
    setAnswers(rest);
    if (page + 1 < count) { go(page + 1); return; }
    if (Object.keys(rest).length === 0) { onSkip(); return; }
    onAnswer(rest);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape" && ownsEscape) { e.preventDefault(); e.stopPropagation(); onSkip(); }
  };

  return (
    /* data-no-agent, for PermissionCard's reason: an answer here is the user's, and an agent driving
       this window through `app_act` could otherwise answer a question another session put to them. */
    <div ref={root} className="question-card" role="group" aria-label={q.header || "Question"} data-no-agent="question" data-enter={enter || undefined} onKeyDown={onKeyDown}>
      <div className="question-head">
        <span className="question-from">
          <Icon name={askerIcon(card.asker)} size={14} colored />
          <span className="question-from-name">{askerLine(card.asker)}</span>
          {q.header && <span className="question-tag">{q.header}</span>}
        </span>
        {count > 1 && (
          <div className="question-pager">
            <button className="icon-btn" aria-label="Previous question" disabled={page === 0} onClick={() => go(page - 1)}><Icon name="chevronLeft" size={14} /></button>
            <span>{page + 1} of {count}</span>
            <button className="icon-btn" aria-label="Next question" disabled={page + 1 >= count} onClick={() => go(page + 1)}><Icon name="chevronRight" size={14} /></button>
          </div>
        )}
        <button className="icon-btn question-close" aria-label={count > 1 ? `${dismiss} all` : dismiss}
          title={card.mode === "question" ? "Skip — answer none of these" : `Decline — tell ${card.asker.name} no`} onClick={onSkip}><Icon name="close" size={14} /></button>
      </div>
      {card.message && <p className="question-message">{card.message}</p>}
      <h3 className="question-title">{q.prompt}</h3>
      {q.detail && <p className="question-detail">{q.detail}</p>}
      <QuestionBody key={page} q={q} card={card} initial={answers[q.id]} focus={focusBody}
        commit={commit} skip={q.required === true ? null : skipQuestion} dismiss={dismiss} ownsEscape={ownsEscape} />
    </div>
  );
}

type BodyProps = {
  q: AskQuestion; card: AskCard;
  /** This question's answer from an earlier visit to the page, if it has one. */
  initial: string | string[] | undefined;
  /** Take the keyboard on mount. */
  focus: boolean;
  commit: (value: string | string[]) => void;
  /** Skip this one question; null when it is required. */
  skip: (() => void) | null;
  dismiss: string;
  ownsEscape: boolean;
};

function QuestionBody(p: BodyProps) {
  switch (p.q.kind) {
    case "choice": case "multi": case "confirm": case "branch": return <ChoiceBody {...p} />;
    case "text": case "time": return <TextBody {...p} />;
    case "model": return <ModelBody {...p} />;
    case "file": return <FileBody {...p} />;
    case "link": return <LinkBody {...p} />;
  }
}

const CONFIRM: AskOption[] = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }];
/** A list longer than this gets a filter above it: a checkout with forty branches is a search. */
const FILTER_AT = 8;

/** The footer every body shares: the keys on the left, Skip and the primary action on the right. */
function Footer({ keys, dismiss, ownsEscape, skip, children }: { keys: [string, string][]; dismiss: string; ownsEscape: boolean; skip: (() => void) | null; children?: ReactNode }) {
  return (
    <div className="question-footer">
      <div className="question-hints">
        {keys.map(([k, what]) => <span key={k}><kbd>{k}</kbd> {what}</span>)}
        {ownsEscape && <span><kbd>esc</kbd> {dismiss}</span>}
      </div>
      <div className="question-actions">
        {skip && <button type="button" className="question-skip" onClick={skip}>Skip</button>}
        {children}
      </div>
    </div>
  );
}

/** The value a question starts on: its earlier answer, else the asker's default. */
const startOf = (p: BodyProps): string[] => {
  const v = p.initial ?? p.q.default;
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
};

function ChoiceBody(p: BodyProps) {
  const { q } = p;
  const multi = q.kind === "multi";
  const all = q.kind === "confirm" ? CONFIRM : q.options ?? [];
  const [filter, setFilter] = useState("");
  const options = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? all.filter((o) => o.label.toLowerCase().includes(f)) : all;
  }, [all, filter]);
  const start = startOf(p);
  const [picked, setPicked] = useState<string[]>(() => (multi ? start.filter((v) => all.some((o) => o.value === v)) : []));
  const [selected, setSelected] = useState(() => Math.max(0, all.findIndex((o) => o.value === start[0])));
  const [othering, setOthering] = useState(false);
  const [otherText, setOtherText] = useState(() => (!multi && start[0] !== undefined && !all.some((o) => o.value === start[0]) ? start[0] : ""));
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const otherInput = useRef<HTMLInputElement>(null);
  const other = q.allowOther === true;
  const rowCount = options.length + Number(other);
  const tiles = all.some((o) => o.image);
  const filtered = all.length > FILTER_AT;

  useEffect(() => { if (p.focus) rows.current[Math.min(selected, rowCount - 1)]?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- on mount only
  useEffect(() => { if (othering) otherInput.current?.focus(); }, [othering]);

  const choose = (i: number) => {
    const value = options[i]?.value; if (value === undefined) return;
    if (!multi) { p.commit(value); return; }
    setPicked((x) => (x.includes(value) ? x.filter((v) => v !== value) : [...x, value]));
  };
  const select = (i: number) => {
    if (rowCount === 0) return;
    const next = (i + rowCount) % rowCount;
    setSelected(next);
    rows.current[next]?.focus();
  };
  const submitOther = () => {
    const t = otherText.trim(); if (!t) return;
    p.commit(multi ? [...picked, t] : t);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (othering) {
      // While the free-text row is open it owns the keyboard: Esc backs out to the options rather than
      // skipping the request, so a mistyped "Something else" is not a dead end.
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOthering(false); rows.current[options.length]?.focus(); }
      else if (e.key === "Enter" && otherText.trim()) { e.preventDefault(); submitOther(); }
      return;
    }
    const inFilter = e.target instanceof HTMLInputElement;
    if (e.key === "Enter") {
      const control = e.target instanceof HTMLElement ? e.target.closest("button") : null;
      if (control instanceof HTMLButtonElement) { e.preventDefault(); control.click(); return; }
      e.preventDefault();
      if (multi) { if (picked.length) p.commit(picked); }
      else if (selected === options.length && other) setOthering(true);
      else choose(selected);
    } else if (e.key === "ArrowDown") { e.preventDefault(); select(selected + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); select(selected - 1); }
    // Bare digits only: ⌘1–9 is the app's switch-space binding. Never while a filter is being typed in.
    else if (!inFilter && e.key >= "1" && e.key <= String(Math.min(9, options.length)) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); choose(Number(e.key) - 1);
    }
  };

  return (
    <div className="question-body" onKeyDown={onKeyDown}>
      {filtered && (
        <div className="question-filter">
          <Icon name="search" size={14} />
          <input value={filter} placeholder={q.kind === "branch" ? "Filter branches" : "Filter"} aria-label="Filter the options"
            onChange={(e) => { setFilter(e.target.value); setSelected(0); }} />
        </div>
      )}
      <div className={tiles ? "question-tiles" : "question-options"}>
        {options.map((o, i) => {
          const on = picked.includes(o.value);
          const props = {
            ref: (el: HTMLButtonElement | null) => { rows.current[i] = el; },
            "aria-label": o.label, "aria-pressed": multi ? on : undefined,
            "data-selected": i === selected || undefined, "data-picked": on || undefined,
            onFocus: () => setSelected(i), onClick: () => choose(i),
          };
          return tiles ? (
            <button key={o.value} type="button" className="question-tile" {...props}>
              <OptionPicture path={o.image ?? null} />
              <span className="question-tile-label">
                {i < 9 && <kbd className="question-num">{i + 1}</kbd>}
                <span className="question-option-label">{o.label}</span>
                {multi && on && <Icon name="check" size={14} />}
              </span>
              {o.description && <span className="question-option-desc">{o.description}</span>}
            </button>
          ) : (
            <button key={o.value} type="button" className="question-option" {...props}>
              <kbd className="question-num">{i < 9 ? i + 1 : ""}</kbd>
              <span className="question-option-body">
                <span className="question-option-label">{o.label}</span>
                {o.description && <span className="question-option-desc">{o.description}</span>}
              </span>
              {o.current && <span className="question-option-note">Current</span>}
              {multi && on && <Icon name="check" size={14} />}
            </button>
          );
        })}
        {options.length === 0 && filter && <p className="question-empty">Nothing matches “{filter.trim()}”.</p>}
      </div>
      {other && (othering ? (
        <div className="question-option question-other-edit">
          <kbd className="question-num"><Icon name="edit" size={12} /></kbd>
          <input ref={otherInput} className="question-other-input" type="text" value={otherText}
            placeholder={q.placeholder ?? "Type your answer…"} aria-label="Your answer" onChange={(e) => setOtherText(e.target.value)} />
          <button type="button" className="btn primary question-other-submit" disabled={!otherText.trim()} onClick={submitOther}>Answer</button>
        </div>
      ) : (
        <button ref={(el) => { rows.current[options.length] = el; }} type="button" className="question-option question-other"
          aria-label="Something else" data-selected={selected === options.length || undefined}
          onFocus={() => setSelected(options.length)} onClick={() => setOthering(true)}>
          <kbd className="question-num"><Icon name="edit" size={12} /></kbd>
          <span className="question-option-body"><span className="question-option-label">Something else</span></span>
        </button>
      ))}
      <Footer keys={[["↑↓", "Navigate"], ["↵", multi ? "Toggle" : "Select"]]} dismiss={p.dismiss} ownsEscape={p.ownsEscape} skip={p.skip}>
        {multi && (
          <button type="button" className="btn primary question-continue" disabled={!picked.length} onClick={() => p.commit(picked)}>
            Continue <kbd>↩</kbd>
          </button>
        )}
      </Footer>
    </div>
  );
}

/** An option's picture: main's thumbnail of a path Realm resolved in the workspace, or the image
 *  glyph while there is none — and forever, for a file that cannot be drawn. */
function OptionPicture({ path }: { path: string | null }) {
  const url = useThumbnail(path, "card");
  return (
    <span className="question-tile-pic">
      {url ? <img src={url} alt="" draggable={false} /> : <Icon name="image" size={20} />}
    </span>
  );
}

const INPUT_TYPE: Record<string, string> = { email: "email", uri: "url", number: "number", integer: "number" };

function TextBody(p: BodyProps) {
  const { q } = p;
  const time = q.kind === "time";
  const multiline = q.format === "multiline";
  const [value, setValue] = useState(() => startOf(p)[0] ?? "");
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => { if (p.focus) field.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- on mount only

  const ok = validText(q, value);
  // A one-line answer is its words; a secret and a note are kept exactly as typed.
  const submit = () => { if (ok) p.commit(q.secret || multiline ? value : value.trim()); };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    // Escape out of a field that holds an answer steps out of the field and answers nothing; an empty
    // one lets the key go on to the card, where it skips.
    else if (e.key === "Escape" && value !== "") { e.preventDefault(); e.stopPropagation(); field.current?.blur(); }
  };
  const type = time ? (q.format === "date" ? "date" : "datetime-local") : q.secret ? "password" : INPUT_TYPE[q.format ?? ""] ?? "text";
  const common = {
    ref: field, className: "question-text-input", value, "aria-label": "Your answer",
    placeholder: q.placeholder ?? (time ? undefined : "Type your answer…"),
    onChange: (e: { target: { value: string } }) => setValue(e.target.value), onKeyDown,
  };
  return (
    <div className="question-body">
      <div className="question-text" data-secret={q.secret || undefined}>
        {q.secret && <Icon name="padlock" size={14} />}
        {multiline
          ? <textarea {...common} rows={3} />
          : <input {...common} type={type} autoComplete="off" spellCheck={q.secret ? false : undefined}
              {...(q.format === "number" || q.format === "integer" ? { min: q.min, max: q.max, step: q.format === "integer" ? 1 : "any" } : {})} />}
      </div>
      {/* Where a secret goes is said on the field that takes it. */}
      {q.secret && <p className="question-note">Goes to {p.card.asker.name} only. Realm keeps a mark in its place, never what you type.</p>}
      <Footer keys={[[multiline ? "⌘↵" : "↵", "Answer"]]} dismiss={p.dismiss} ownsEscape={p.ownsEscape} skip={p.skip}>
        <button type="button" className="btn primary question-continue" disabled={!ok} onClick={submit}>Answer <kbd>↩</kbd></button>
      </Footer>
    </div>
  );
}

/** Whether a typed answer is one the question can take. */
function validText(q: AskQuestion, value: string): boolean {
  if (value.trim() === "") return false;
  if (q.kind === "time") return q.format === "date" ? /^\d{4}-\d{2}-\d{2}$/.test(value) : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);
  if (q.format === "number" || q.format === "integer") {
    const n = Number(value);
    if (!Number.isFinite(n) || (q.format === "integer" && !Number.isInteger(n))) return false;
    return (q.min === undefined || n >= q.min) && (q.max === undefined || n <= q.max);
  }
  if (q.format === "email" && !/^[^\s@]+@[^\s@]+$/.test(value.trim())) return false;
  return (q.min === undefined || value.length >= q.min) && (q.max === undefined || value.length <= q.max);
}

/** A model option as the chooser lists models. */
const asDelegable = (o: AskOption): DelegableModel => ({ key: o.value, label: o.label, kind: (o.agent ?? "fake") as AgentKind, id: o.value, ready: o.ready !== false });

function ModelBody(p: BodyProps) {
  const { q } = p;
  const options = q.options ?? [];
  const own = options.find((o) => o.own) ?? options[0]!;
  const rows = q.rows ?? [{ id: q.id, label: "" }];
  const start = startOf(p);
  const [values, setValues] = useState<string[]>(() => rows.map((_, i) => {
    const v = start.length === rows.length ? start[i] : start[0];
    return v !== undefined && options.some((o) => o.value === v) ? v : own.value;
  }));
  const [choosing, setChoosing] = useState<number | null>(null);
  const chips = useRef<(HTMLButtonElement | null)[]>([]);
  const anchor = useRef<HTMLElement | null>(null);
  useEffect(() => { if (p.focus) chips.current[0]?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- on mount only
  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const models = useMemo(() => options.filter((o) => o !== own).map(asDelegable), [options, own]);

  const submit = () => p.commit(q.rows ? values : values[0]!);
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (choosing !== null) return; // the chooser has the keyboard
    const at = chips.current.findIndex((c) => c === document.activeElement);
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    else if (e.key === "ArrowDown" && at >= 0) { e.preventDefault(); chips.current[(at + 1) % rows.length]?.focus(); }
    else if (e.key === "ArrowUp" && at >= 0) { e.preventDefault(); chips.current[(at - 1 + rows.length) % rows.length]?.focus(); }
  };

  return (
    <div className="question-body" onKeyDown={onKeyDown}>
      <div className="question-models">
        {rows.map((r, i) => {
          const m = byValue.get(values[i]!) ?? own;
          return (
            <div key={r.id} className="question-model-row" data-solo={!q.rows || undefined}>
              {q.rows && <kbd className="question-num">{i + 1}</kbd>}
              {q.rows && <span className="question-model-step">{r.label}</span>}
              <button ref={(el) => { chips.current[i] = el; }} type="button" className="question-model-chip"
                aria-haspopup="dialog" aria-expanded={choosing === i}
                aria-label={q.rows ? `Model for ${r.label}: ${m.label}` : `Model: ${m.label}`}
                title={m.agent ? `${m.label} on ${AGENT_META[m.agent].label}` : m.label}
                onClick={(e) => { anchor.current = e.currentTarget; setChoosing((c) => (c === i ? null : i)); }}>
                <Icon name={m.agent ? AGENT_META[m.agent].icon : "cpu"} size={14} colored />
                <span className="question-model-label">{m.label}</span>
                {m.own && <span className="question-model-own">this session</span>}
                <Icon name="chevronDown" size={12} className="question-model-caret" />
              </button>
            </div>
          );
        })}
      </div>
      <Footer keys={[["↑↓", "Navigate"], ["↵", "Choose"], ["⌘↵", "Continue"]]} dismiss={p.dismiss} ownsEscape={p.ownsEscape} skip={p.skip}>
        <button type="button" className="btn primary question-continue" onClick={submit}>Continue <kbd>⌘↩</kbd></button>
      </Footer>
      {choosing !== null && (
        <ModelChooser anchor={anchor} models={models}
          own={{ kind: (own.agent ?? "fake") as AgentKind, label: own.label }}
          picked={new Set([values[choosing] === own.value ? OWN : values[choosing]!])}
          label="Models" noAgent="question"
          onToggle={(key) => {
            const value = key === OWN ? own.value : key;
            const row = choosing;
            setValues((vs) => vs.map((v, i) => (i === row ? value : v)));
            setChoosing(null);
            // One pick and the panel goes, as a single choice should — and the keyboard goes back to
            // the chip it opened from, ready for the next row.
            chips.current[row]?.focus();
          }}
          onClose={() => setChoosing(null)} />
      )}
    </div>
  );
}

/** How many of the workspace's files the field lists at once. */
const FILE_HITS = 8;

function FileBody(p: BodyProps) {
  const { q, card } = p;
  const store = useAppStoreMaybe();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ProjectFileHit[]>([]);
  const [picked, setPicked] = useState<string[]>(() => startOf(p));
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (p.focus) input.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- on mount only
  const workspace = card.workspace ?? null;
  useEffect(() => {
    if (!store || !workspace) return;
    let live = true;
    const t = setTimeout(() => {
      void store.getState().searchFilesIn(workspace, query.trim())
        .then((r) => { if (live) { setHits(r.hits.slice(0, FILE_HITS)); setSelected(0); } })
        .catch(() => { if (live) setHits([]); });
    }, 90);
    return () => { live = false; clearTimeout(t); };
  }, [store, workspace, query]);

  const pick = (path: string) => {
    if (!q.multiple) { p.commit(path); return; }
    setPicked((x) => (x.includes(path) ? x.filter((v) => v !== path) : [...x, path]));
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, hits.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if ((e.metaKey || e.ctrlKey) && q.multiple) { if (picked.length) p.commit(picked); return; }
      const hit = hits[selected];
      if (hit) pick(hit.path);
      // No workspace to search: what was typed is the path, held to the workspace on the server.
      else if (!workspace && query.trim()) p.commit(query.trim());
    }
  };

  return (
    <div className="question-body" onKeyDown={onKeyDown}>
      {q.multiple && picked.length > 0 && (
        <div className="question-file-picks" aria-label="Picked files">
          {picked.map((f) => (
            <button key={f} type="button" className="question-file-pick" title={`Remove ${f}`} onClick={() => pick(f)}>
              <Icon name="artifact" size={12} />{f}<Icon name="close" size={12} />
            </button>
          ))}
        </div>
      )}
      <div className="question-filter">
        <Icon name="search" size={14} />
        <input ref={input} value={query} placeholder={workspace ? "Search this workspace" : "Type a path"} aria-label="Search files"
          aria-controls={`question-files-${q.id}`} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="question-options" id={`question-files-${q.id}`} role="listbox" aria-label="Files">
        {hits.map((h, i) => {
          const on = picked.includes(h.path);
          return (
            <button key={h.path} type="button" role="option" aria-selected={on} className="question-option question-file"
              aria-label={h.path} data-selected={i === selected || undefined} data-picked={on || undefined}
              onPointerMove={() => setSelected(i)} onClick={() => pick(h.path)}>
              <Icon name="artifact" size={14} />
              <span className="question-file-path">{h.segments.map((s, j) => (s.match ? <mark key={j}>{s.text}</mark> : <span key={j}>{s.text}</span>))}</span>
              {on && <Icon name="check" size={14} />}
            </button>
          );
        })}
        {workspace && hits.length === 0 && <p className="question-empty">{query.trim() ? `No file matches “${query.trim()}”.` : "Looking in the workspace…"}</p>}
      </div>
      <Footer keys={[["↑↓", "Navigate"], ["↵", q.multiple ? "Toggle" : "Select"]]} dismiss={p.dismiss} ownsEscape={p.ownsEscape} skip={p.skip}>
        {q.multiple && (
          <button type="button" className="btn primary question-continue" disabled={!picked.length} onClick={() => p.commit(picked)}>
            Continue <kbd>⌘↩</kbd>
          </button>
        )}
      </Footer>
    </div>
  );
}

function LinkBody(p: BodyProps) {
  const url = useMemo(() => { try { return new URL(p.q.url ?? ""); } catch { return null; } }, [p.q.url]);
  const open = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (p.focus) open.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- on mount only
  if (!url) return null;
  const href = url.href;
  const at = href.indexOf(url.host);
  // Look-alike letters in a host are encoded as `xn--` labels: the address may read as one site and be
  // another, which is exactly what a consent card exists to catch.
  const lookalike = url.hostname.split(".").some((label) => label.startsWith("xn--"));
  return (
    <div className="question-body">
      {/* The WHOLE address, as text — never a link — with the host set apart, because the host is what
          says whose page this is and the rest is where on it. */}
      <p className="question-link" title={href}>
        <span className="question-link-rest">{href.slice(0, at)}</span>
        <span className="question-link-host">{url.host}</span>
        <span className="question-link-rest">{href.slice(at + url.host.length)}</span>
      </p>
      {url.protocol === "http:" && <p className="question-warn"><Icon name="alert" size={14} />This page is not encrypted: the address is http, not https.</p>}
      {lookalike && <p className="question-warn"><Icon name="alert" size={14} />The address uses look-alike letters. Check it is the site you expect.</p>}
      <p className="question-note">Opens in your browser, outside Realm. Nothing you do there passes through Realm or reaches an agent.</p>
      <Footer keys={[]} dismiss={p.dismiss} ownsEscape={p.ownsEscape} skip={null}>
        <button ref={open} type="button" className="btn primary question-continue"
          onClick={() => { window.open(href, "_blank"); p.commit("opened"); }}>
          Open {url.host}
        </button>
      </Footer>
    </div>
  );
}

/**
 * A question, after the fact: who asked, each question, and what was answered — read off the
 * persisted `permission_response`, so it is the same tomorrow as the moment it was sent. A masked
 * answer is only ever the mark the log kept. A request the user skipped says so, and one Realm
 * declined itself says why, because nothing about it was the user's to decide.
 *
 * At rest: no lift, no controls. It is a record in the scrollback, not something to act on, and the
 * shape is the question card's own so a reader knows what kind of thing it was.
 */
export function AnsweredQuestion({ card, decision, answers, enter = false }: {
  card: AskCard; decision: "allow" | "allow_always" | "deny"; answers?: AskAnswers; enter?: boolean;
}) {
  const skipped = decision === "deny" || !answers || Object.keys(answers).length === 0;
  const outcome = card.refused ? "Declined by Realm" : skipped ? (card.mode === "question" ? "Skipped" : "Declined") : null;
  return (
    <div className="question-answered" role="group" aria-label={askerLine(card.asker, true)} data-enter={enter || undefined}>
      <div className="question-answered-head">
        <Icon name={askerIcon(card.asker)} size={14} colored />
        <span className="question-from-name">{askerLine(card.asker, true)}</span>
        {outcome && <span className="question-answered-outcome">{outcome}</span>}
      </div>
      {card.refused
        ? <p className="question-answered-why">{card.message ? `${card.message} — ` : ""}{card.refused}</p>
        : (
          <dl className="question-answered-list">
            {card.questions.map((q) => (
              <div key={q.id} className="question-answered-row">
                <dt>{q.prompt}</dt>
                <dd>{answers?.[q.id] === undefined ? <span className="question-answered-none">Not answered</span> : <AnswerValue q={q} value={answers[q.id]!} />}</dd>
              </div>
            ))}
          </dl>
        )}
    </div>
  );
}

const labelOf = (q: AskQuestion, v: string): string =>
  (q.kind === "confirm" ? CONFIRM : q.options ?? []).find((o) => o.value === v)?.label ?? v;

/** One answer as a reader takes it in: an option by its label, a model by its chip, a day as a day. */
function AnswerValue({ q, value }: { q: AskQuestion; value: string | string[] }) {
  const values = Array.isArray(value) ? value : [value];
  if (q.secret || values[0] === HIDDEN_ANSWER) return <span className="question-answered-secret" aria-label="Hidden">{HIDDEN_ANSWER}</span>;
  switch (q.kind) {
    case "model": {
      const chip = (v: string) => {
        const m = q.options?.find((o) => o.value === v);
        return <span className="question-answered-model"><Icon name={m?.agent ? AGENT_META[m.agent].icon : "cpu"} size={12} colored />{m?.label ?? v}</span>;
      };
      if (!q.rows) return chip(values[0]!);
      return (
        <ol className="question-answered-steps">
          {q.rows.map((r, i) => <li key={r.id}><span>{r.label}</span>{values[i] !== undefined && chip(values[i]!)}</li>)}
        </ol>
      );
    }
    case "file": return <span className="question-answered-path">{values.join(", ")}</span>;
    case "time": return <span>{values[0] ? whenOf(values[0], q.format === "date") : ""}</span>;
    case "link": return <span>Opened {hostOf(q.url)}</span>;
    case "choice": case "multi": case "branch": case "confirm": {
      const picture = q.options?.find((o) => o.value === values[0])?.image;
      return (
        <span className="question-answered-choice">
          {picture && values.length === 1 && <OptionPicture path={picture} />}
          {values.map((v) => labelOf(q, v)).join(", ")}
        </span>
      );
    }
    case "text": return <span className="question-answered-text">{values[0]}</span>;
  }
}

/** A day, or a day and a time, in the reader's own calendar. Parsed as LOCAL time: a date-only
 *  answer read as UTC would land on the day before for everyone west of Greenwich. */
function whenOf(v: string, dateOnly: boolean): string {
  const [d, t = "00:00"] = v.split("T");
  const [y, m, day] = (d ?? "").split("-").map(Number);
  const [h, min] = t.split(":").map(Number);
  const at = new Date(y ?? 0, (m ?? 1) - 1, day ?? 1, h ?? 0, min ?? 0);
  if (Number.isNaN(at.getTime())) return v;
  return dateOnly
    ? at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })
    : at.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const hostOf = (url: string | undefined): string => { try { return new URL(url ?? "").host; } catch { return "the page"; } };
