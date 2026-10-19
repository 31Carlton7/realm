import { Icon, type IconName } from "@realm/ui";
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  EDITABLE_FORMATS, inferFormat, isImageFile, itemTarget, itemVerb, mediaUrl, verbFamily,
  type DeliverableFormat, type TeamReviewDetail, type TeamReviewItem,
} from "@realm/contracts";
import { useApp } from "../../../../state/store";
import { Markdown } from "../../../session/Markdown";
import { DiffView } from "../../../session/rich/DiffView";
import { parseUnifiedDiff } from "../../../session/rich/diff";
import { FileMark } from "../../../../components/file-icon";
import { canQuickLook, fileDragProps, quickLook, quickLookOnSpace } from "../../../../components/file-actions";
import { numericColumns, parseDelimited, parseLinks } from "./parse";

/**
 * A draft drawn as the thing itself (team-deliverables.ts): a post as it would sit on its platform —
 * the account, the slides, the caption under them — an email as a mail with its subject and its
 * recipient, a DM as the message in its thread, a document as a page, a bundle of files as a stack the
 * Finder would recognise, a diff in the diff component's own colours. `inferFormat` picks the drawing
 * when the item does not say. Every drawing sits in the same place under the reader's head, so
 * stepping between items of different formats moves nothing else.
 *
 * `Deliverable` is the piece other surfaces reuse — a team chat's draft card draws the same preview.
 * Where the text IS the deliverable (an email, a note, a message) it may be edited in place before
 * the yes; a picture or a PDF is edited in Documents instead.
 */

export type EditBody = { save: (body: string) => Promise<void> };
type Props = { detail: TeamReviewDetail; item: TeamReviewItem; edit: EditBody | null };

/** Whether the drawing carries the item's text itself — so the reader does not draw it twice. A
 *  post's caption is part of the post and a PDF's note rides under its page; a document, a diff, links
 *  or a table that came as a file are the file, and their text is the reader's to show apart. */
export function drawsBody(format: DeliverableFormat, item: TeamReviewItem): boolean {
  if (format === "email" || format === "message" || format === "images" || format === "pdf" || format === "files") return true;
  return item.files.length === 0;
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

/** The item's own key/values, quiet above it — except what the drawing already shows (an email's
 *  Subject is its own line). */
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
const nameOf = (f: string): string => f.split("/").pop() ?? f;
const folderOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".");

/** A platform's own mark, where Realm's icon set has one. */
const CHANNEL_MARK: Record<string, IconName> = { tiktok: "tiktok", instagram: "instagram", youtube: "youtube", x: "x", twitter: "x", email: "mail", mail: "mail" };
const channelMark = (channel: string | undefined): IconName | null => (channel ? CHANNEL_MARK[channel.trim().toLowerCase()] ?? null : null);
/** "instagram" from a connector reads as the platform writes its name. */
const channelName = (c: string): string => (c === c.toLowerCase() ? c.charAt(0).toUpperCase() + c.slice(1) : c);

/* ── a post: its account, its pictures, its caption ─────────────────────────────────────────────── */

/**
 * Pictures. With a caption going out somewhere, a post as the platform lays it out: who it goes out
 * as, the slides in order at their own 9:16, the caption under them. One picture on its own is one
 * large frame. Each opens in the media viewer, where it can be asked about.
 */
function Images({ detail, item }: Props) {
  const openViewer = useApp((s) => s.openViewer);
  const pictures = item.files.filter(isImageFile);
  const others = item.files.filter((f) => !isImageFile(f));
  if (!detail.root) return null;
  const t = itemTarget(item);
  const open = (i: number, opener: HTMLElement) =>
    openViewer({ files: pictures.map((p) => ({ path: abs(detail, p) })), index: i, sessionId: detail.sessionId, spaceId: detail.spaceId, opener });
  const post = !!item.body || !!t?.channel;
  return (
    <>
      {post ? (
        <figure className="rv-post">
          {(t?.account || t?.channel) && <PostHead account={t.account} channel={t.channel} />}
          {pictures.length > 0 && (
            <div className="rv-strip" data-count={pictures.length}>
              {pictures.map((f, i) => (
                <button key={f} type="button" className="rv-slide" aria-label={`Slide ${i + 1} of ${pictures.length}, ${nameOf(f)}. Open it large`} onClick={(e) => open(i, e.currentTarget)}>
                  <img src={mediaUrl(abs(detail, f))} alt="" draggable={false} />
                  {pictures.length > 1 && <span className="rv-slide-n">{i + 1}</span>}
                </button>
              ))}
            </div>
          )}
          {item.body && <figcaption className="rv-post-caption" data-selectable="">{item.body}</figcaption>}
        </figure>
      ) : pictures.length === 1 ? (
        <button type="button" className="rv-picture" aria-label={`${nameOf(pictures[0]!)}. Open it large`} onClick={(e) => open(0, e.currentTarget)}>
          <img src={mediaUrl(abs(detail, pictures[0]!))} alt="" draggable={false} />
        </button>
      ) : (
        <div className="rv-strip" data-count={pictures.length}>
          {pictures.map((f, i) => (
            <button key={f} type="button" className="rv-slide" aria-label={`Picture ${i + 1} of ${pictures.length}, ${nameOf(f)}. Open it large`} onClick={(e) => open(i, e.currentTarget)}>
              <img src={mediaUrl(abs(detail, f))} alt="" draggable={false} />
            </button>
          ))}
        </div>
      )}
      {others.length > 0 && <FileStack detail={detail} files={others} />}
    </>
  );
}

function PostHead({ account, channel }: { account?: string | undefined; channel?: string | undefined }) {
  const mark = channelMark(channel);
  return (
    <div className="rv-post-head">
      <span className="rv-post-avatar" aria-hidden="true">{mark ? <Icon name={mark} size={16} /> : (account ?? "?").replace(/^@/, "").charAt(0).toUpperCase()}</span>
      {account && <span className="rv-post-account">{account}</span>}
      {channel && <span className="rv-post-channel">{channelName(channel)}</span>}
    </div>
  );
}

/* ── pdf ────────────────────────────────────────────────────────────────────────────────────────── */

/** A PDF on its own as paper — its first page, opening in Realm's own PDF viewer in Documents. A PDF
 *  that came with other files is one file of a bundle, and sits in the stack with them. */
function Pdf({ detail, item }: Props) {
  const pdfs = item.files.filter((f) => f.toLowerCase().endsWith(".pdf"));
  const bundle = pdfs.length < item.files.length;
  if (!detail.root) return null;
  return (
    <>
      {!bundle && pdfs.map((f) => <PdfPage key={f} detail={detail} file={f} />)}
      {item.body && <p className="rv-attached-note" data-selectable="">{item.body}</p>}
      {bundle && <FileStack detail={detail} files={item.files} />}
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
  const name = nameOf(file);
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

/** A document as a page: a `.md` file's text, or the body, at the reading measure. */
function MarkdownDoc({ detail, item, edit }: Props) {
  const file = item.files.find((f) => /\.(md|markdown)$/i.test(f));
  const text = file ? textOf(detail, file) : item.body;
  return (
    <>
      {text !== null && (
        <Editable body={file ? null : item.body} edit={file ? null : edit} label="document">
          <article className="rv-paper rv-doc" data-selectable="">
            {file && <div className="rv-paper-name"><FileMark path={file} size={16} />{nameOf(file)}</div>}
            <Markdown text={text} className="rv-md" />
          </article>
        </Editable>
      )}
      <FileStack detail={detail} files={item.files.filter((f) => f !== file || text === null)} />
    </>
  );
}

function Text({ item, edit }: Props) {
  return (
    <Editable body={item.body} edit={edit} label="note">
      <div className="rv-paper rv-text" data-selectable="">{item.body}</div>
    </Editable>
  );
}

/**
 * An email as a mail reads: who it is from and to, its subject as the head, then the text; its
 * attachments under it as files. Realm sends none of it on its own — the decision area says who does.
 */
function Email({ detail, item, edit }: Props) {
  const t = itemTarget(item);
  const subject = Object.entries(item.meta ?? {}).find(([k]) => k.toLowerCase() === "subject")?.[1] ?? null;
  const from = t?.account ?? "You";
  return (
    <>
      <Editable body={item.body} edit={edit} label="email">
        <article className="rv-paper rv-mail">
          <header className="rv-mail-head">
            <span className="rv-mail-avatar" aria-hidden="true">{from.charAt(0).toUpperCase()}</span>
            <dl className="rv-mail-who">
              <div><dt>From</dt><dd>{from}</dd></div>
              {t?.to && <div><dt>To</dt><dd>{t.to}</dd></div>}
            </dl>
          </header>
          {subject && <h2 className="rv-mail-subject" data-selectable="">{subject}</h2>}
          <div className="rv-mail-body" data-selectable="">{item.body}</div>
        </article>
      </Editable>
      <FileStack detail={detail} files={item.files} />
    </>
  );
}

/** A DM or a text post as it would read: the platform and the account it goes out as, then the words
 *  in their bubble — a DM in its thread, a post as the account's own. */
function Message({ detail, item, edit }: Props) {
  const t = itemTarget(item);
  const dm = verbFamily(itemVerb(detail.kind, item)) === "send" || !!t?.to;
  const mark = channelMark(t?.channel);
  return (
    <>
      <Editable body={item.body} edit={edit} label="message">
        <div className="rv-paper rv-chat" data-dm={dm || undefined}>
          <div className="rv-chat-head">
            {mark && <Icon name={mark} size={14} />}
            <span className="rv-chat-where">
              {dm ? <>{t?.to ? <b>{t.to}</b> : "A DM"}{t?.channel && <> on {channelName(t.channel)}</>}</> : <><b>{t?.account ?? "A post"}</b>{t?.channel && <> on {channelName(t.channel)}</>}</>}
            </span>
          </div>
          <div className="rv-chat-thread">
            <div className="rv-bubble" data-selectable="">{item.body}</div>
            {dm && t?.account && <span className="rv-bubble-from">from {t.account}</span>}
          </div>
        </div>
      </Editable>
      <FileStack detail={detail} files={item.files} />
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
        ? <div className="rv-diff diff-hunks" data-selectable=""><DiffView files={files} /></div>
        : text && <div className="rv-paper md" data-selectable=""><pre><code>{text}</code></pre></div>}
      <FileStack detail={detail} files={item.files.filter((f) => f !== file || files.length === 0)} />
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
        <ul className="rv-paper rv-links" data-selectable="">
          {links.map((l, i) => (
            <li key={`${l.url}:${i}`}>
              <a className="msg-chip" href={l.url} target="_blank" rel="noreferrer" title={l.url}><Icon name="link" size={12} />{l.title ?? l.host}</a>
              <span className="rv-link-where">{l.title ? l.host : ""}{l.path && <span className="t-mono">{l.title ? " · " : ""}{l.path}</span>}</span>
            </li>
          ))}
        </ul>
      )}
      <FileStack detail={detail} files={item.files.filter((f) => f !== file || links.length === 0)} />
    </>
  );
}

/** A table at the pane's full width, its heads over the cells they name. */
function Table({ detail, item }: Props) {
  const file = item.files.find((f) => /\.(csv|tsv)$/i.test(f));
  const text = file ? textOf(detail, file) : null;
  if (!file) return <div className="rv-paper rv-doc rv-table-md" data-selectable=""><Markdown text={item.body ?? ""} className="rv-md" /></div>;
  const rows = text ? parseDelimited(text, /\.tsv$/i.test(file) ? "\t" : ",") : [];
  const right = numericColumns(rows);
  const [head = [], ...body] = rows;
  return (
    <>
      {rows.length > 0 && (
        <div className="rv-table md" data-selectable="">
          <div className="md-scroll">
            <table>
              <thead><tr>{head.map((h, c) => <th key={c} align={right[c] ? "right" : undefined}>{h}</th>)}</tr></thead>
              <tbody>{body.map((r, i) => <tr key={i}>{head.map((_, c) => <td key={c} align={right[c] ? "right" : undefined}>{r[c] ?? ""}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <p className="rv-strip-note">{body.length} row{body.length === 1 ? "" : "s"} from <span className="t-mono">{file}</span></p>
        </div>
      )}
      <FileStack detail={detail} files={item.files.filter((f) => f !== file || rows.length === 0)} />
    </>
  );
}

function Files({ detail, item }: Props) {
  return (
    <>
      {item.body && <p className="rv-attached-note" data-selectable="">{item.body}</p>}
      <FileStack detail={detail} files={item.files} />
    </>
  );
}

/**
 * A bundle of files as one tidy stack: each file's own mark (its picture, where it is one), its name
 * and its folder, and what a Mac does with a file — Quick Look on Space, a drag out to the Finder.
 * A text file Realm has read opens in place, a diff in the diff's colours.
 */
function FileStack({ detail, files }: { detail: TeamReviewDetail; files: readonly string[] }) {
  if (files.length === 0 || !detail.root) return null;
  return (
    <ul className="rv-files" aria-label={files.length === 1 ? "1 file" : `${files.length} files`}>
      {files.map((f) => <StackFile key={f} detail={detail} file={f} />)}
    </ul>
  );
}

function StackFile({ detail, file }: { detail: TeamReviewDetail; file: string }) {
  const [open, setOpen] = useState(false);
  const path = abs(detail, file);
  const text = textOf(detail, file);
  const diff = text && /\.(diff|patch)$/i.test(file) ? parseUnifiedDiff(text, file) : [];
  return (
    <li className="rv-file" data-open={open || undefined}>
      <div className="rv-file-row" {...fileDragProps(path)}>
        {isImageFile(file)
          ? <img className="rv-file-thumb" src={mediaUrl(path)} alt="" draggable={false} />
          : <span className="rv-file-mark"><FileMark path={file} size={20} /></span>}
        <span className="rv-file-text">
          <span className="rv-file-name">{nameOf(file)}</span>
          <span className="rv-file-where t-mono">{folderOf(file)}</span>
        </span>
        {text !== null && (
          <button type="button" className="btn-quiet rv-file-open" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : diff.length > 0 ? "Show the diff" : "Show"}
          </button>
        )}
        {canQuickLook() && <button type="button" className="btn-quiet rv-file-look" onClick={() => quickLook(path)}>Quick Look</button>}
      </div>
      {open && text !== null && (
        diff.length > 0
          ? <div className="rv-file-body rv-diff diff-hunks" data-selectable=""><DiffView files={diff} /></div>
          : <div className="rv-file-body" data-selectable=""><Markdown text={/\.(md|markdown)$/i.test(file) ? text : fenced(text, file)} /></div>
      )}
    </li>
  );
}

/** A text file's words as a fenced block in its own language, so the Markdown renderer draws it as
 *  code — with a fence the text cannot close early. */
function fenced(text: string, file: string): string {
  const fence = text.includes("```") ? "~~~~" : "```";
  return `${fence}${file.split(".").pop() ?? ""}\n${text}\n${fence}`;
}

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
    <form className="rv-paper rv-editing" onSubmit={(e) => { e.preventDefault(); void save(); }}>
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
