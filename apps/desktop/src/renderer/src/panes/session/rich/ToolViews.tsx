import { Icon } from "@realm/ui";
import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDissolve } from "../../../components/ScrollFades";
import { DiffView, PathLabel } from "./DiffView";
import { grammarForPath, highlightToHtml } from "./highlight";
import type { MatchGroup, ToolArg, ToolInputView, ToolPanel, ToolResultView, Todo, UploadFile } from "./tool-view";

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
  /* The block scrolls down past its cap and its body scrolls across: each dissolves where it runs on
     downwards, and neither sideways — a code line is read to its last character. */
  const block = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLPreElement>(null);
  useDissolve(block);
  useDissolve(body);
  return (
    <>
      <div className="code-block" ref={block}>
        {firstLine !== null && (
          <div className="code-gutter" aria-hidden="true">
            {Array.from({ length: lineCount(shown) }, (_, i) => firstLine + i).join("\n")}
          </div>
        )}
        <pre className="code-body" ref={body}><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>
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
  const out = useRef<HTMLPreElement>(null);
  useDissolve(out);
  return (
    <>
      <pre className="term-out" ref={out}>{shown || "(no output)"}</pre>
      {!showAll && total > LINE_CLAMP && <More label={`Show all ${total} lines`} onClick={() => setShowAll(true)} />}
      {exitCode !== null && <span className="term-exit" data-bad={exitCode !== 0 || undefined}>exit {exitCode}</span>}
    </>
  );
}

/** How far through, and what is happening right now. A fragment rather than a box, so the card's
 *  head row and the strip's header button can each lay it out their own way. */
export function TodoHeadline({ todos }: { todos: readonly Todo[] }) {
  const done = todos.filter((t) => t.status === "completed").length;
  const active = todos.find((t) => t.status === "in_progress");
  return (
    <>
      <span className="todo-count">{done} of {todos.length}</span>
      {/* The in-flight item's own words for what it is doing ("Running the suite"), which is what
          `activeForm` is for; without one the item's title stands in. */}
      {active && <span className="todo-active shimmer-text">{active.activeForm ?? active.content}</span>}
    </>
  );
}

/** The plan's real arithmetic — completed over total. The one part readable from across the room,
 *  which is why the strip keeps it out of the collapse. */
export function TodoTrack({ todos }: { todos: readonly Todo[] }) {
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div className="todo-track" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={todos.length}>
      <div className="todo-fill" style={{ width: `${todos.length ? (done / todos.length) * 100 : 0}%` }} />
    </div>
  );
}

export function TodoItems({ todos }: { todos: readonly Todo[] }) {
  const list = useRef<HTMLUListElement>(null);
  useDissolve(list);
  return (
    <ul className="todo-list" ref={list}>
      {todos.map((t, i) => (
        <li key={i} data-status={t.status}>
          {/* off-ladder: the dot is 13px, so the inline rung would fill it edge to edge. */}
          <span className="todo-dot" aria-hidden="true">{t.status === "completed" && <Icon name="check" size={10} />}</span>
          <span className="todo-text">{t.content}</span>
        </li>
      ))}
    </ul>
  );
}

/** TodoWrite's plan (AICSS "To-do List"), as the tool card draws it: the whole list, at the point in
 *  the log where the agent wrote it. The card is one moment; the strip above the prompter is now. */
export function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <div className="todo">
      <div className="todo-head"><TodoHeadline todos={todos} /></div>
      <TodoTrack todos={todos} />
      <TodoItems todos={todos} />
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
        <Icon name={url ? "browser" : "search"} size={12} />
        {host && <span className="req-host">{host}</span>}
        <span className="req-target" title={url ?? query ?? ""}>{url ?? query}</span>
      </div>
      {prompt && <div className="req-prompt">{prompt}</div>}
    </div>
  );
}

/**
 * The files a `browser_upload` is about to send, and where they are going.
 *
 * Drawn rather than left in the raw JSON because this is the one permission whose subject is a LIST:
 * "Allow" here means these bytes leave this Mac, and a reader who cannot see which files is not
 * consenting to anything. Two things are given weight for that reason — the host, which is the
 * destination, and the full path of any file from outside the space's folder, which is the case the
 * approval is really for. Files inside the space folder show their name and size only; their
 * location is the thing the user already chose by working there.
 */
export function UploadView({ host, element, files }: { host: string; element: string; files: UploadFile[] }) {
  return (
    <div className="upl">
      <div className="req-head">
        <Icon name="browser" size={12} />
        {host && <span className="req-host">{host}</span>}
        {element && <span className="req-target" title={element}>{element}</span>}
      </div>
      <ul className="upl-files">
        {files.map((f, i) => (
          <li key={`${f.name}-${i}`} className="upl-file" data-outside={f.path ? "" : undefined}>
            <span className="upl-name" title={f.name}>{f.name}</span>
            <span className="upl-size">{f.size}</span>
            {f.path && <span className="upl-path" title={f.path}>{f.path}</span>}
          </li>
        ))}
      </ul>
      {files.some((f) => f.path) && <div className="upl-note">Paths shown in full are outside this space's folder.</div>}
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
    case "upload": return <UploadView host={view.host} element={view.element} files={view.files} />;
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

/** How long a copy control holds its ✓ before turning back to the copy glyph (the icon swap). */
const COPIED_MS = 1400;

/** A copy control in a panel's head: the copy glyph turning over to a tick, and the word for WHAT it
 *  copies where a head carries two of them ("Command", "Output"). It copies the raw string it is
 *  handed — what a reader pastes into a shell has to be what the tool was given, not Realm's drawing
 *  of it — and keeps one accessible name throughout. */
export function PanelCopy({ what, text, word = null }: { what: string; text: string; word?: string | null }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button type="button" className="tool-panel-copy" aria-label={`Copy ${what}`} title={`Copy ${what}`} data-copied={copied || undefined}
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      }}>
      <span className="icon-swap" data-on={copied || undefined}>
        <Icon name="copy" size={12} className="swap-off" />
        <Icon name="check" size={12} className="swap-on" />
      </span>
      {word && <span>{word}</span>}
    </button>
  );
}

/** One panel of a call's body: the panel a fenced block already is — the signature curve, a fill and
 *  no ring — with a head of what it shows and how to copy it, unruled from the body under it. */
function Panel({ head, acts, tone = null, children }: { head: ReactNode; acts: ReactNode; tone?: "terminal" | null; children?: ReactNode }) {
  return (
    <div className="tool-panel" data-tone={tone ?? undefined}>
      <div className="tool-panel-head">
        <span className="tool-panel-label">{head}</span>
        <span className="tool-panel-acts">{acts}</span>
      </div>
      {children}
    </div>
  );
}

/** Text a panel holds as it came — an error, a fetched page, an MCP result — capped, dissolving where
 *  it runs on, and folded past `LINE_CLAMP` lines behind the shared "Show all". */
function PanelText({ text, form = "code", error = false }: { text: string; form?: "code" | "prose"; error?: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const total = lineCount(text);
  const shown = showAll || total <= LINE_CLAMP ? text : text.split("\n").slice(0, LINE_CLAMP).join("\n");
  const box = useRef<HTMLPreElement>(null);
  useDissolve(box);
  return (
    <>
      <pre className="tool-panel-text" ref={box} data-form={form} data-error={error || undefined}>{shown || "(empty)"}</pre>
      {!showAll && total > LINE_CLAMP && <More label={`Show all ${total} lines`} onClick={() => setShowAll(true)} />}
    </>
  );
}

/** A failure's words in full, for the kinds whose panel has no place of its own for them. */
export function ErrorPanel({ text }: { text: string }) {
  return <Panel head="Error" acts={<PanelCopy what="error" text={text} />}><PanelText text={text} error /></Panel>;
}

/** A path said from where the agent stands, when it is under the session's folder. */
const fromCwd = (path: string, cwd: string | null): string => {
  const root = cwd?.replace(/\/+$/, "");
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
};

/** A working directory in a panel's head: its last two parts, which are the ones that tell two
 *  checkouts apart; the whole path is the title. */
const shortDir = (dir: string): string => {
  const parts = dir.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : dir;
};

/** A command and what it printed, in ONE terminal panel: where it ran and how it ended in the head,
 *  the command on its prompt, the output under it in the same fill. */
function RunPanel({ command, cwd, output, diff, exitCode }: Extract<ToolPanel, { kind: "run" }>) {
  return (
    <>
    <Panel tone="terminal"
      head={<>
        {cwd && <span className="tool-panel-cwd" title={cwd}>in {shortDir(cwd)}</span>}
        {/* Only where the payload stated it: an "exit 0" on output that never said so is a verdict
            nobody gave. */}
        {exitCode !== null && <span className="tool-panel-exit" data-bad={exitCode !== 0 || undefined}>exit {exitCode}</span>}
      </>}
      acts={<>
        <PanelCopy what="command" text={command} word="Command" />
        {output !== null && <PanelCopy what="output" text={output} word="Output" />}
      </>}>
      <div className="cmd-line">
        <span className="cmd-prompt" aria-hidden="true">$</span>
        <code>{command}</code>
      </div>
      {output !== null && !diff && <TerminalView output={output} exitCode={null} />}
    </Panel>
    {diff && <DiffView files={diff} />}
    </>
  );
}

/** "lines 40–58", from the file's own numbering, or nothing where the listing carried none. */
const lineSpan = (text: string, first: number | null): string | null => {
  if (first === null) return null;
  const n = lineCount(text);
  return n <= 1 ? `line ${first}` : `lines ${first}–${first + n - 1}`;
};

function McpArgs({ args }: { args: ToolArg[] }) {
  return (
    <dl className="tool-args">
      {args.map((a) => (
        <div key={a.key} className="tool-arg">
          <dt>{a.key}</dt>
          <dd data-form={a.form}>{a.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** An opened call's body: the panel for its kind (`toolPanel`). */
export function ToolPanelBody({ panel, cwd }: { panel: Exclude<ToolPanel, { kind: "media" }>; cwd: string | null }) {
  switch (panel.kind) {
    case "run": return <RunPanel {...panel} cwd={panel.cwd ?? cwd} />;
    // The diff alone: an edit's own receipt ("The file … has been updated") says nothing the diff does
    // not, and it is still in Show raw.
    case "diff": return <>{<DiffView files={panel.files.map((f) => ({ ...f, path: fromCwd(f.path, cwd) }))} />}{panel.error && <ErrorPanel text={panel.error} />}</>;
    case "read": return panel.error ? <ErrorPanel text={panel.error} /> : (
      <Panel head={<>
        <PathLabel className="tool-panel-path" path={fromCwd(panel.path, cwd)} />
        {lineSpan(panel.text, panel.firstLine) && <span className="tool-panel-note">{lineSpan(panel.text, panel.firstLine)}</span>}
      </>} acts={<PanelCopy what="file" text={panel.text} />}>
        <CodeBlock text={panel.text} lang={grammarForPath(panel.path)} firstLine={panel.firstLine} />
      </Panel>
    );
    case "search": {
      const files = panel.groups.length;
      return (
        <Panel head={<>
          <span className="tool-panel-query">“{panel.pattern}”</span>
          <span className="tool-panel-note">{files} {files === 1 ? "file" : "files"}</span>
        </>} acts={<PanelCopy what="results" text={panel.groups.map((g) => g.path).join("\n")} />}>
          <MatchList groups={panel.groups} note={panel.note} />
        </Panel>
      );
    }
    case "fetch": {
      let host: string | null = null, rest = panel.url ?? "";
      try { if (panel.url) { const u = new URL(panel.url); host = u.host; rest = `${u.pathname}${u.search}`.replace(/^\/$/, ""); } } catch { /* shown whole */ }
      return (
        <Panel head={panel.url
          ? <>{host && <span className="tool-panel-host">{host}</span>}<span className="tool-panel-note" title={panel.url}>{host ? rest : panel.url}</span></>
          : <span className="tool-panel-query">“{panel.query}”</span>}
          acts={panel.result !== null && <PanelCopy what="result" text={panel.result} />}>
          {panel.prompt && <div className="tool-panel-prompt">{panel.prompt}</div>}
          {panel.result !== null && <PanelText text={panel.result} form="prose" error={panel.error} />}
        </Panel>
      );
    }
    case "mcp": return (
      <Panel head={<><span className="tool-panel-host">{panel.server}</span><span className="tool-panel-note">{panel.tool}</span></>}
        acts={<PanelCopy what="arguments" text={panel.argsText} />}>
        {panel.args.length > 0 && <McpArgs args={panel.args} />}
        {panel.result !== null && (
          <>
            <div className="tool-panel-head tool-panel-subhead">
              <span className="tool-panel-label">{panel.error ? "Error" : "Result"}</span>
              <span className="tool-panel-acts"><PanelCopy what={panel.error ? "error" : "result"} text={panel.result} /></span>
            </div>
            <PanelText text={panel.result} form={panel.json ? "code" : "prose"} error={panel.error} />
          </>
        )}
      </Panel>
    );
    case "todos": return <TodoList todos={panel.todos} />;
  }
}
