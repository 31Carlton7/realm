import { Icon } from "@realm/ui";
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  EDITABLE_FORMATS, inferFormat, isImageFile, itemTarget, mediaUrl,
  type DeliverableFormat, type TeamReviewDetail, type TeamReviewItem,
} from "@realm/contracts";
import { useApp } from "../../../state/store";
import { Markdown } from "../../session/Markdown";
import { DiffView } from "../../session/rich/DiffView";
import { parseUnifiedDiff } from "../../session/rich/diff";
import { canQuickLook, fileDragProps, quickLook, quickLookOnSpace } from "../../../components/file-actions";
import { numericColumns, parseDelimited, parseLinks } from "./parse";

/**
 * Review's renderers, one per format (team-deliverables.ts): the deliverable drawn as what it IS — a
 * strip of pictures, a PDF's first page, Markdown at the reading measure, a mail card, a message as
 * it would read, a diff, link chips, a table, plain prose, or file rows. `inferFormat` picks one when
 * the item does not say. Each draws in the same frame under the head, so changing format moves
 * nothing else on the pane.
 *
 * Where the text IS the deliverable (an email, a Markdown note, a message) it is drawn here, and may
 * be edited in place before the yes; where it rides with files (a caption under slides) the pane
 * draws it under its own head instead (`drawsBody`).
 */

export type EditBody = { save: (body: string) => Promise<void> };
type Props = { detail: TeamReviewDetail; item: TeamReviewItem; edit: EditBody | null };

/** Whether the renderer draws the item's text itself — so the pane does not draw it twice. */
export function drawsBody(format: DeliverableFormat, item: TeamReviewItem): boolean {
  if (format === "email" || format === "message") return true;
  return item.files.length === 0 && format !== "images" && format !== "pdf" && format !== "files";
}

/** Whether the person may edit this item's text here, before approving. */
export function editable(detail: TeamReviewDetail, item: TeamReviewItem): boolean {
  const f = inferFormat(item);
  return detail.state === "waiting" && EDITABLE_FORMATS.includes(f) && drawsBody(f, item) && !!item.body;
}

export function Deliverable({ detail, item, edit }: Props) {
  const format = inferFormat(item);
  const Draw = RENDERERS[format];
  return (
    <div className="rv-deliverable" data-format={format}>
      <MetaRows item={item} format={format} />
      <Draw detail={detail} item={item} edit={edit} />
    </div>
  );
}

/** The item's own key/values, quiet above it — except what the renderer already draws (an email's
 *  Subject is its card's). */
function MetaRows({ item, format }: { item: TeamReviewItem; format: DeliverableFormat }) {
  const rows = Object.entries(item.meta ?? {}).filter(([k]) => !(format === "email" && k.toLowerCase() === "subject"));
  if (rows.length === 0) return null;
  return (
    <dl className="rv-meta-rows">
      {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

const abs = (detail: TeamReviewDetail, f: string): string => `${detail.root}/${f}`;
const textOf = (detail: TeamReviewDetail, f: string): string | null => detail.fileTexts?.[f] ?? null;

/* ── images ─────────────────────────────────────────────────────────────────────────────────────── */

/** A strip of 9:16 slides — today's — opening the media viewer; one picture is one large frame. */
function Images({ detail, item }: Props) {
  const openViewer = useApp((s) => s.openViewer);
  const pictures = item.files.filter(isImageFile);
  const others = item.files.filter((f) => !isImageFile(f));
  if (!detail.root) return null;
  const open = (i: number, opener: HTMLElement) =>
    openViewer({ files: pictures.map((p) => ({ path: abs(detail, p) })), index: i, sessionId: detail.sessionId, spaceId: detail.spaceId, opener });
  return (
    <>
      {pictures.length === 1 && (
        <button type="button" className="rv-picture" aria-label={`${pictures[0]}. Open it large`} onClick={(e) => open(0, e.currentTarget)}>
          <img src={mediaUrl(abs(detail, pictures[0]!))} alt="" draggable={false} />
        </button>
      )}
      {pictures.length > 1 && (
        <div className="rv-strip" style={{ gridTemplateColumns: `repeat(${Math.max(pictures.length, 5)}, minmax(0, 1fr))` }}>
          {pictures.map((f, i) => (
            <button key={f} type="button" className="rv-slide" aria-label={`Slide ${i + 1}, ${f}. Open it large`} onClick={(e) => open(i, e.currentTarget)}>
              <img src={mediaUrl(abs(detail, f))} alt="" draggable={false} />
              <span className="rv-slide-n">{i + 1}</span>
            </button>
          ))}
        </div>
      )}
      {pictures.length > 0 && (
        <p className="rv-strip-note">{pictures.length === 1 ? "1 picture" : `${pictures.length} slides`} in <span className="t-mono">{folderOf(pictures[0]!)}</span>. Open one to see it full size, or to ask {detail.roleName ?? "the role"} about it.</p>
      )}
      {others.length > 0 && <FileRows detail={detail} files={others} />}
    </>
  );
}

/* ── pdf ────────────────────────────────────────────────────────────────────────────────────────── */

/** The PDF's first page as paper, at width, opening in Realm's own PDF viewer in Documents. */
function Pdf({ detail, item }: Props) {
  const pdfs = item.files.filter((f) => f.toLowerCase().endsWith(".pdf"));
  const others = item.files.filter((f) => !f.toLowerCase().endsWith(".pdf"));
  if (!detail.root) return null;
  return (
    <>
      {pdfs.map((f) => <PdfPage key={f} detail={detail} file={f} />)}
      {others.length > 0 && <FileRows detail={detail} files={others} />}
    </>
  );
}

function PdfPage({ detail, file }: { detail: TeamReviewDetail; file: string }) {
  const openDocumentPath = useApp((s) => s.openDocumentPath);
  const openViewer = useApp((s) => s.openViewer);
  const run = useApp((s) => s.run);
  const path = abs(detail, file);
  const [page, setPage] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const preview = window.realm?.files?.preview;
    if (!preview) { setPage(null); return; }
    preview(path, "page").then((url) => { if (live) setPage(url); }).catch(() => { if (live) setPage(null); });
    return () => { live = false; };
  }, [path]);
  const name = file.split("/").pop() ?? file;
  return (
    <figure className="rv-pdf">
      <button type="button" className="rv-pdf-page" aria-label={`${name}, its first page. Open it large`} {...fileDragProps(path)} onKeyDown={quickLookOnSpace(path)}
        onClick={(e) => openViewer({ files: [{ path }], index: 0, sessionId: detail.sessionId, spaceId: detail.spaceId, opener: e.currentTarget })}>
        {/* off-ladder: the glyph stands in for a PDF's first page, a picture the size of a card. */}
        {page ? <img src={page} alt="" draggable={false} /> : <span className="rv-pdf-blank"><Icon name="filePdf" size={24} />{page === undefined ? "" : name}</span>}
      </button>
      <figcaption className="rv-pdf-foot">
        <span className="rv-pdf-name">{name}<small className="t-mono"> · {folderOf(file)}</small></span>
        <button type="button" className="btn" onClick={() => run(() => openDocumentPath(path, null, detail.spaceId))}>Open in Documents</button>
      </figcaption>
    </figure>
  );
}

/* ── text that is the deliverable ───────────────────────────────────────────────────────────────── */

/** Markdown at the reading measure: a `.md` file's text, or the body. */
function MarkdownDoc({ detail, item, edit }: Props) {
  const file = item.files.find((f) => /\.(md|markdown)$/i.test(f));
  const text = file ? textOf(detail, file) : item.body;
  return (
    <>
      {text !== null && (
        <Editable body={file ? null : item.body} edit={file ? null : edit} label="note">
          <article className="rv-frame rv-doc"><Markdown text={text} className="rv-md" /></article>
        </Editable>
      )}
      <FileRows detail={detail} files={item.files.filter((f) => f !== file || text === null)} />
    </>
  );
}

function Text({ item, edit }: Props) {
  return (
    <Editable body={item.body} edit={edit} label="text">
      <div className="rv-frame rv-text">{item.body}</div>
    </Editable>
  );
}

/** A mail card: who it goes out as, to whom, its subject, then the text; attachments under it. */
function Email({ detail, item, edit }: Props) {
  const t = itemTarget(item);
  const subject = Object.entries(item.meta ?? {}).find(([k]) => k.toLowerCase() === "subject")?.[1] ?? null;
  return (
    <>
      <Editable body={item.body} edit={edit} label="email">
        <div className="rv-frame rv-mail">
          <dl className="rv-mail-head">
            <div><dt>From</dt><dd>{t?.account ?? "You"}</dd></div>
            {t?.to && <div><dt>To</dt><dd>{t.to}</dd></div>}
            {subject && <div className="rv-mail-subject"><dt>Subject</dt><dd>{subject}</dd></div>}
          </dl>
          <div className="rv-mail-body">{item.body}</div>
        </div>
      </Editable>
      <FileRows detail={detail} files={item.files} />
    </>
  );
}

/** A DM or a post's words as they would read, the account it goes out as above them. */
function Message({ detail, item, edit }: Props) {
  const t = itemTarget(item);
  const who = [t?.account, t?.channel].filter(Boolean).join(" · ");
  return (
    <>
      <Editable body={item.body} edit={edit} label="message">
        <div className="rv-frame rv-message">
          {(who || t?.to) && <div className="rv-message-who">{who}{t?.to && <span> to {t.to}</span>}</div>}
          <div className="rv-message-text">{item.body}</div>
        </div>
      </Editable>
      <FileRows detail={detail} files={item.files} />
    </>
  );
}

/* ── data ───────────────────────────────────────────────────────────────────────────────────────── */

/** A diff in the diff component's own colours and signs: a `.diff`/`.patch` file, or the body. */
function Diff({ detail, item }: Props) {
  const file = item.files.find((f) => /\.(diff|patch)$/i.test(f));
  const text = file ? textOf(detail, file) : item.body;
  const files = text ? parseUnifiedDiff(text, file ?? "") : [];
  return (
    <>
      {files.length > 0
        ? <div className="rv-diff"><DiffView files={files} /></div>
        : text && <div className="rv-frame md"><pre><code>{text}</code></pre></div>}
      <FileRows detail={detail} files={item.files.filter((f) => f !== file || files.length === 0)} />
    </>
  );
}

/** Links as what they point at: the line's own title where it gave one, the host, and the path. */
function Links({ detail, item }: Props) {
  const file = item.files.find((f) => /\.links\.md$/i.test(f));
  const links = parseLinks((file ? textOf(detail, file) : item.body) ?? "");
  return (
    <>
      {links.length > 0 && (
        <ul className="rv-frame rv-links">
          {links.map((l, i) => (
            <li key={`${l.url}:${i}`}>
              <a className="msg-chip" href={l.url} target="_blank" rel="noreferrer" title={l.url}><Icon name="link" size={12} />{l.title ?? l.host}</a>
              <span className="rv-link-where">{l.title ? l.host : ""}{l.path && <span className="t-mono">{l.title ? " · " : ""}{l.path}</span>}</span>
            </li>
          ))}
        </ul>
      )}
      <FileRows detail={detail} files={item.files.filter((f) => f !== file || links.length === 0)} />
    </>
  );
}

/** A table at the pane's full width, its heads over the cells they name. */
function Table({ detail, item }: Props) {
  const file = item.files.find((f) => /\.(csv|tsv)$/i.test(f));
  const text = file ? textOf(detail, file) : null;
  if (!file) return <div className="rv-frame rv-doc rv-table-md"><Markdown text={item.body ?? ""} className="rv-md" /></div>;
  const rows = text ? parseDelimited(text, /\.tsv$/i.test(file) ? "\t" : ",") : [];
  const right = numericColumns(rows);
  const [head = [], ...body] = rows;
  return (
    <>
      {rows.length > 0 && (
        <div className="rv-table md">
          <div className="md-scroll">
            <table>
              <thead><tr>{head.map((h, c) => <th key={c} align={right[c] ? "right" : undefined}>{h}</th>)}</tr></thead>
              <tbody>{body.map((r, i) => <tr key={i}>{head.map((_, c) => <td key={c} align={right[c] ? "right" : undefined}>{r[c] ?? ""}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <p className="rv-strip-note">{body.length} row{body.length === 1 ? "" : "s"} from <span className="t-mono">{file}</span></p>
        </div>
      )}
      <FileRows detail={detail} files={item.files.filter((f) => f !== file || rows.length === 0)} />
    </>
  );
}

function Files({ detail, item }: Props) {
  return <FileRows detail={detail} files={item.files} />;
}

/** Today's file rows, each one a file the Finder would recognise: Quick Look on Space, a drag out. */
function FileRows({ detail, files }: { detail: TeamReviewDetail; files: readonly string[] }) {
  if (files.length === 0 || !detail.root) return null;
  return (
    <ul className="settings-list rv-files">
      {files.map((f) => {
        const path = abs(detail, f);
        return (
          <li key={f} className="settings-row" {...fileDragProps(path)}>
            <Icon name="artifact" size={16} />
            <div className="settings-row-main"><span className="settings-row-name">{f.split("/").pop()}</span><span className="settings-row-detail t-mono">{f}</span></div>
            {canQuickLook() && <button type="button" className="btn" onClick={() => quickLook(path)}>Quick Look</button>}
          </li>
        );
      })}
    </ul>
  );
}

const folderOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".");

/* ── edit, then approve ─────────────────────────────────────────────────────────────────────────── */

/**
 * The text as drawn, with Edit at its corner while it waits for a yes. Editing swaps the drawing for
 * the words in a field; Save makes them the batch's next version — the button says so, because what
 * the yes covers changes — and Escape or Cancel leaves the text as it was.
 */
function Editable({ body, edit, label, children }: { body: string | null; edit: EditBody | null; label: string; children: ReactNode }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (draft !== null) field.current?.focus(); }, [draft !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!edit || body === null) return <>{children}</>;
  if (draft === null) {
    return (
      <div className="rv-editable">
        {children}
        <button type="button" className="btn-quiet rv-edit" title={`Edit this ${label} before you approve it`} onClick={() => { setError(null); setDraft(body); }}>
          <Icon name="pen" size={14} />Edit
        </button>
      </div>
    );
  }
  const save = async () => {
    setBusy(true); setError(null);
    try { await edit.save(draft); setDraft(null); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <form className="rv-frame rv-editing" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <textarea ref={field} className="rv-edit-field" value={draft} aria-label={`The ${label}'s text`} rows={Math.min(24, Math.max(6, draft.split("\n").length + 1))}
        onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setDraft(null); } }} />
      <div className="rv-edit-foot">
        <span className="rv-edit-note" role={error ? "alert" : undefined}>{error ?? "Saving makes this the batch's next version; Approve then covers your words."}</span>
        <button type="button" className="btn" onClick={() => setDraft(null)}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy || !draft.trim() || draft === body}>{busy ? "Saving…" : "Save edit"}</button>
      </div>
    </form>
  );
}

export const RENDERERS: Record<DeliverableFormat, ComponentType<Props>> = {
  images: Images, pdf: Pdf, markdown: MarkdownDoc, email: Email, message: Message,
  diff: Diff, links: Links, table: Table, text: Text, files: Files,
};
