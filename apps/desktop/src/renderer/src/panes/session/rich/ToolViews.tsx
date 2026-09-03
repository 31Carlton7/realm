import { Icon } from "@realm/ui";
import DOMPurify from "dompurify";
import { useMemo, useState } from "react";
import { DiffView, PathLabel } from "./DiffView";
import { grammarForPath, highlightToHtml } from "./highlight";
import type { MatchGroup, ToolInputView, ToolResultView, Todo } from "./tool-view";

/** The drawn forms of a tool call's input and result (AICSS's tool/structured-output blocks, fitted
 *  to the tools Realm's agents actually call). Each one is chosen by `tool-view.ts` and rendered
 *  here; anything it declines falls back to ToolCard's raw well, so nothing is ever hidden because
 *  a parser did not recognise it. */

/** Rows drawn before a list folds behind an expander — a `Grep` across a monorepo returns thousands
 *  of matches, and the reader's question is almost always answered by the first screen. */
const ROW_CLAMP = 40;
/** Lines of a file preview or command output shown before the same fold. */
const LINE_CLAMP = 200;

const lineCount = (s: string) => (s === "" ? 0 : s.split("\n").length);

/** The shared "N more" control. Takes the count so the reader knows what they are opening — an
 *  unlabelled "Show all" on 8000 lines is a trap. */
function More({ label, onClick }: { label: string; onClick: () => void }) {
  return <button className="tool-expand" onClick={onClick}>{label}</button>;
}

/** Mono code with a line-number rail (BUI CodeBlock's body). The gutter is a sibling column of
 *  numbers rather than a number per line: highlight.js token spans routinely straddle line breaks
 *  (a template literal, a block comment), and splitting the markup per line to interleave gutter
 *  cells would cut them in half. Both columns are the same mono face at the same line-height and
 *  neither wraps, so they stay in register while the code scrolls sideways under a fixed rail. */
export function CodeBlock({ text, lang, firstLine = null, clamp = LINE_CLAMP }: {
  text: string; lang: string | null; firstLine?: number | null; clamp?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const total = lineCount(text);
  const shown = showAll || total <= clamp ? text : text.split("\n").slice(0, clamp).join("\n");
  // highlight.js escapes everything it does not tokenise, and emits only <span class>. DOMPurify
  // runs anyway: the sanitizer is this app's single gate for generated markup, and carving out an
  // exception for "markup we believe is safe" is how the one that is not gets in.
  const html = useMemo(() => DOMPurify.sanitize(highlightToHtml(shown, lang)), [shown, lang]);
  return (
    <>
      <div className="code-block">
        {firstLine !== null && (
          <div className="code-gutter" aria-hidden="true">
            {Array.from({ length: lineCount(shown) }, (_, i) => firstLine + i).join("\n")}
          </div>
        )}
        <pre className="code-body"><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>
      </div>
      {!showAll && total > clamp && <More label={`Show all ${total} lines`} onClick={() => setShowAll(true)} />}
    </>
  );
}

/** A command and what it printed (AICSS "Tool & Action States", terminal flavour). The `$` is a
 *  prompt glyph outside the selectable text, so copying the row copies the command and not a shell
 *  prompt the reader would then have to delete. */
export function CommandView({ command, cwd, description }: { command: string; cwd: string | null; description: string | null }) {
  return (
    <div className="cmd">
      <div className="cmd-line">
        <span className="cmd-prompt" aria-hidden="true">$</span>
        <code>{command}</code>
      </div>
      {(cwd || description) && (
        <div className="cmd-meta">
          {description && <span>{description}</span>}
          {cwd && <span className="cmd-cwd" title={cwd}>in {cwd}</span>}
        </div>
      )}
    </div>
  );
}

/** Command output. `exitCode` is shown only where the payload actually carried one (Codex's
 *  `[exit N]` trailer) — a green "exit 0" badge on output that never stated its status would be an
 *  invented verdict on a command that may well have failed. */
export function TerminalView({ output, exitCode }: { output: string; exitCode: number | null }) {
  const [showAll, setShowAll] = useState(false);
  const total = lineCount(output);
  const shown = showAll || total <= LINE_CLAMP ? output : output.split("\n").slice(0, LINE_CLAMP).join("\n");
  return (
    <>
      <pre className="term-out">{shown || "(no output)"}</pre>
      {!showAll && total > LINE_CLAMP && <More label={`Show all ${total} lines`} onClick={() => setShowAll(true)} />}
      {exitCode !== null && <span className="term-exit" data-bad={exitCode !== 0 || undefined}>exit {exitCode}</span>}
    </>
  );
}

/** TodoWrite's plan (AICSS "To-do List"). The bar is the plan's real arithmetic — completed over
 *  total — and it is the one thing in the card readable from across the room, which is the point: a
 *  reader scrolling past a long run of tool calls wants to know how far through the agent is. */
export function TodoList({ todos }: { todos: Todo[] }) {
  const done = todos.filter((t) => t.status === "completed").length;
  const active = todos.find((t) => t.status === "in_progress");
  return (
    <div className="todo">
      <div className="todo-head">
        <span className="todo-count">{done} of {todos.length}</span>
        {/* The in-flight item's own words for what it is doing ("Running the suite"), which is what
            `activeForm` is for; without one the item's title stands in. */}
        {active && <span className="todo-active shimmer-text">{active.activeForm ?? active.content}</span>}
      </div>
      <div className="todo-track" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={todos.length}>
        <div className="todo-fill" style={{ width: `${todos.length ? (done / todos.length) * 100 : 0}%` }} />
      </div>
      <ul className="todo-list">
        {todos.map((t, i) => (
          <li key={i} data-status={t.status}>
            <span className="todo-dot" aria-hidden="true">{t.status === "completed" && <Icon name="check" size={10} />}</span>
            <span className="todo-text">{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Search results grouped by file (Grep, Glob). A path with no matches under it is a file-name hit —
 *  Grep's `files_with_matches` mode and every Glob result — and it stays a bare row rather than
 *  growing an empty body. */
export function MatchList({ groups, note }: { groups: MatchGroup[]; note: string | null }) {
  const [showAll, setShowAll] = useState(false);
  const total = groups.reduce((n, g) => n + 1 + g.matches.length, 0);
  const shown = showAll || total <= ROW_CLAMP ? groups : clampGroups(groups, ROW_CLAMP);
  return (
    <div className="matches">
      {note && <div className="matches-note">{note}</div>}
      {shown.map((g) => (
        <div className="match-file" key={g.path}>
          <PathLabel className="match-path" path={g.path} />
          {g.matches.map((m, i) => (
            <div className="match-row" key={i}>
              <span className="match-no" aria-hidden="true">{m.line ?? ""}</span>
              <span className="match-text">{m.text.trim() || " "}</span>
            </div>
          ))}
        </div>
      ))}
      {!showAll && total > ROW_CLAMP && <More label={`Show all ${groups.length} files`} onClick={() => setShowAll(true)} />}
    </div>
  );
}

/** Groups trimmed to `budget` rows, counting a path row and each of its matches. Trimming inside a
 *  file rather than dropping whole files keeps the FIRST files whole, which is the order the search
 *  returned them in and the order the reader is scanning. */
export function clampGroups(groups: readonly MatchGroup[], budget: number): MatchGroup[] {
  const out: MatchGroup[] = [];
  let left = budget;
  for (const g of groups) {
    if (left <= 1) break;
    left--;
    out.push({ path: g.path, matches: g.matches.slice(0, left) });
    left -= Math.min(left, g.matches.length);
  }
  return out;
}

/** A web request the agent is about to make. The host is pulled out as its own chip because it is
 *  the part that matters when the card is a permission prompt: what the page is called can wait,
 *  WHO is being talked to cannot. */
export function RequestView({ url, query, prompt }: { url: string | null; query: string | null; prompt: string | null }) {
  const host = useMemo(() => { try { return url ? new URL(url).host : null; } catch { return null; } }, [url]);
  return (
    <div className="req">
      <div className="req-head">
        <Icon name={url ? "browser" : "search"} size={13} />
        {host && <span className="req-host">{host}</span>}
        <span className="req-target" title={url ?? query ?? ""}>{url ?? query}</span>
      </div>
      {prompt && <div className="req-prompt">{prompt}</div>}
    </div>
  );
}

/** The input view for a tool call, or null when there is no better drawing than the raw payload. */
export function ToolInputBody({ view }: { view: ToolInputView }) {
  switch (view.kind) {
    case "diff": return <DiffView files={view.files} />;
    case "todos": return <TodoList todos={view.todos} />;
    case "command": return <CommandView command={view.command} cwd={view.cwd} description={view.description} />;
    case "request": return <RequestView url={view.url} query={view.query} prompt={view.prompt} />;
  }
}

export function ToolResultBody({ view }: { view: ToolResultView }) {
  switch (view.kind) {
    case "diff": return <DiffView files={view.files} />;
    case "terminal": return <TerminalView output={view.output} exitCode={view.exitCode} />;
    case "code": return <CodeBlock text={view.text} lang={grammarForPath(view.path)} firstLine={view.firstLine} />;
    case "matches": return <MatchList groups={view.groups} note={view.note} />;
  }
}
