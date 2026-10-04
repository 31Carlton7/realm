import { MEMORY_DOC_MAX } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Markdown } from "../../panes/session/Markdown";

const fmt = (n: number): string => n.toLocaleString("en-US");

/** How long a pause in typing is before the document is written. Long enough that a sentence is one
 *  write rather than forty, short enough that closing the page a breath after the last key loses
 *  nothing — and leaving the editor writes at once anyway. */
export const MEMORY_SAVE_AFTER_MS = 800;

type Status = "edited" | "saving" | "saved" | "over" | "failed" | null;

/**
 * One memory document, written the way a note is: the card IS the page, and it keeps itself.
 *
 * The editor it replaced was a labelled textarea in a box in a card, a count at full weight, and a
 * Save button that sat disabled until a keystroke — three frames around one field, and a control
 * whose resting state was "you cannot". The page is the text now, at reading size in the content
 * face, and a pause in typing writes it: the head says Edited, Saving…, Saved — the one fact the
 * button carried — and leaving the field or pressing ⌘S writes it at once.
 *
 * The cap is surfaced, never enforced by truncation: past MEMORY_DOC_MAX nothing is sent, the
 * overage is named, and the text stays exactly as typed. The server would refuse too — the client
 * check exists so the refusal is explained before the round trip, not so the doc can be trimmed.
 *
 * Preview renders the markdown the agents are handed, so a heading reads as one and a link as a
 * link, without leaving the page.
 */
export function MemoryDoc({ label, doc, placeholder, onSave, editorRef }: {
  /** The editor's accessible name: which document this is. */
  label: string;
  /** The stored document — what a draft is compared against, and what shows when there is none. */
  doc: string;
  placeholder: string;
  /** Write the document. Resolves once the server has it. */
  onSave: (text: string) => Promise<void>;
  /** Lets a mount context (the space page's empty-state button) focus the editor. */
  editorRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const [draft, setDraft] = useState<string | null>(null); // null = not edited; the stored doc shows
  const [status, setStatus] = useState<Status>(null);
  const [view, setView] = useState<"write" | "preview">("write");
  const ids = useId();
  const text = draft ?? doc;
  const over = text.length - MEMORY_DOC_MAX;

  const editor = useRef<HTMLTextAreaElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  // The latest of everything a deferred write needs, so a write fired by a timer or an unmount never
  // sends a stale draft or calls a stale saver.
  const latest = useRef({ draft, doc, onSave });
  latest.current = { draft, doc, onSave };

  const write = useCallback(() => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
    const { draft: d, doc: stored, onSave: save } = latest.current;
    if (d === null || d === stored) return;
    if (d.length > MEMORY_DOC_MAX) { if (mounted.current) setStatus("over"); return; }
    if (mounted.current) setStatus("saving");
    save(d).then(() => {
      if (!mounted.current) return;
      // Typed on while it was saving: the newer text is still a draft, and its own pause writes it.
      if (latest.current.draft === d) { setDraft(null); setStatus("saved"); }
    }, () => { if (mounted.current) setStatus("failed"); });
  }, []);

  // Leaving — the page closed, the tab changed — writes what was typed rather than dropping it.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; write(); };
  }, [write]);

  const change = (next: string) => {
    setDraft(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (next.length > MEMORY_DOC_MAX) { setStatus("over"); return; }
    setStatus("edited");
    timer.current = setTimeout(write, MEMORY_SAVE_AFTER_MS);
  };

  // The field grows with the document, so the page scrolls rather than a box inside it.
  useLayoutEffect(() => {
    const el = editor.current;
    if (!el || view !== "write") return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text, view]);

  const statusText = status === "edited" ? "Edited"
    : status === "saving" ? "Saving…"
    : status === "saved" ? "Saved"
    : status === "over" ? "Not saved"
    : status === "failed" ? "Couldn't save"
    : null;

  return (
    <div className="memory-doc-card">
      <div className="memory-doc-head">
        {/* A status, not a control: it says what the page has done with what you wrote. */}
        <span className="memory-doc-status" role="status" aria-live="polite"
          title={status === "failed" ? "Realm will try again the next time you change the document." : undefined}
          data-tone={status === "over" || status === "failed" ? "danger" : undefined}>
          {status === "saved" && <Icon name="check" size={12} />}
          {statusText}
        </span>
        <fieldset className="seg memory-doc-view">
          <legend className="visually-hidden">Show the document as</legend>
          {(["write", "preview"] as const).map((v) => (
            <label key={v} className="seg-opt" data-selected={view === v || undefined}>
              <input type="radio" name={`${ids}-view`} value={v} checked={view === v} onChange={() => { write(); setView(v); }} />
              {v === "write" ? "Write" : "Preview"}
            </label>
          ))}
        </fieldset>
      </div>
      {view === "write" ? (
        <textarea
          ref={(el) => { editor.current = el; if (editorRef) editorRef.current = el; }}
          className="memory-doc" aria-label={label} value={text} rows={8} spellCheck={false}
          placeholder={placeholder}
          onChange={(e) => change(e.target.value)}
          onBlur={write}
          onKeyDown={(e) => { if (e.key === "s" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); write(); } }} />
      ) : text.trim() === "" ? (
        <p className="memory-preview-empty">Nothing written yet.</p>
      ) : (
        <Markdown text={text} className="memory-preview" />
      )}
      <div className="memory-doc-foot">
        {/* The count recedes until it matters — it reports a limit almost nobody is near. */}
        <span className="memory-doc-count" data-tone={over > 0 ? "danger" : undefined}>
          {over > 0
            ? `${fmt(text.length)} / ${fmt(MEMORY_DOC_MAX)} — over by ${fmt(over)} characters. Trim it down; Realm will not truncate it.`
            : `${fmt(text.length)} / ${fmt(MEMORY_DOC_MAX)}`}
        </span>
      </div>
    </div>
  );
}
