import { Icon, type IconName } from "@realm/ui";
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { basenameOf, documentKindFor, isOpenablePath, type Item } from "@realm/contracts";
import { useApp } from "../../state/store";
import { useAnchoredPopover } from "../../components/use-anchored-popover";
import { Sheet } from "../../components/Sheet";
import { Markdown } from "./Markdown";
import { MediaLightbox } from "./media/MediaView";
import { useMediaFiles } from "./media/use-media";
import { emptyTranscript } from "./transcript-model";
import { isEmptySummary, summarize, type Output, type PlanEntry, type SessionSummary, type Upload } from "./session-summary";

const NO_BLOCKS = emptyTranscript().blocks;
const STATUS_MARK: Record<string, string> = { pending: "○", in_progress: "◐", completed: "●" };

/**
 * The session's own summary: what it produced, what it was handed, and what it proposed.
 *
 * A transcript answers all three, and answers them badly — the evidence is spread down a log, in the
 * order it happened rather than the order anyone wants it, and a file written forty messages ago is
 * only findable by scrolling past everything that came after. This is that same evidence collected
 * (`session-summary.ts` does the collecting, and does it purely, so the list and the transcript can
 * never disagree) and put where the pane's other per-session controls already live.
 *
 * The button hides itself for a session with nothing in any of the three lists. That is every session
 * for its first minute, and a permanently-empty panel behind a permanent button is the dead chrome
 * the pane bar bans.
 */
export function SessionSummaryButton({ item }: { item: Item }) {
  const id = item.refId;
  const blocks = useApp((s) => s.transcripts[id]?.t.blocks ?? NO_BLOCKS);
  const environmentId = useApp((s) => s.sessions[id]?.environmentId ?? null);
  const summary = useMemo(() => summarize(blocks), [blocks]);
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  /** Media opens HERE, in the transcript's own lightbox — the same surface a message's attachment
   *  opens in, because a file must not open two different ways depending on which list it was
   *  reached from. Files and plans go through the store's sheet slot instead (SheetHost), which is
   *  what keeps a modal from being painted over by a browser pane's native view. */
  const [lightbox, setLightbox] = useState<string | null>(null);
  if (isEmptySummary(summary)) return null;
  return (
    <>
      <button ref={btn} className="icon-btn" aria-label={`Summary of ${item.title}`} title="Outputs, sources and plans"
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="info" size={14} />
      </button>
      {open && (
        <SummaryPopover summary={summary} sessionId={id} environmentId={environmentId} anchorRef={btn} onClose={() => setOpen(false)}
          onLightbox={(path) => { setLightbox(path); setOpen(false); }} />
      )}
      {lightbox && <SummaryLightbox path={lightbox} onClose={() => setLightbox(null)} />}
    </>
  );
}

/** The panel itself — three sections, each drawn only when it has rows. */
function SummaryPopover({ summary, sessionId, environmentId, anchorRef, onClose, onLightbox }: {
  summary: SessionSummary;
  sessionId: string;
  /** The session's checkout — the workspace a file opens against. */
  environmentId: string | null;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onLightbox: (path: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { pos } = useAnchoredPopover({ ref, anchorRef, align: "right", onClose });
  const openSheet = useApp((s) => s.openSheet);
  const openDocumentPath = useApp((s) => s.openDocumentPath);
  const run = useApp((s) => s.run);
  /* A file the pane can EDIT opens in the documents pane, not in a sheet offering to hand it to the
     OS. That was the gap: an agent writes six files, the summary lists them, and every one of them
     opened a modal whose only real action was "leave for the Finder" — so the artifacts a session
     produced were the one thing you could not look at inside Realm. The sheet survives for the rest:
     a `.zip`, a binary, anything the pane has no view for. */
  const openFile = (path: string) => {
    onClose();
    if (documentKindFor(path) === "unsupported") { openSheet({ kind: "artifact", path }); return; }
    run(() => openDocumentPath(path, environmentId));
  };
  return createPortal(
    <div ref={ref} className="session-summary" role="dialog" aria-label="Session summary"
      style={{ position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999,
        visibility: pos ? "visible" : "hidden", transformOrigin: pos?.origin ?? "top right" }}>
      <Section title="Outputs" count={summary.outputs.length} icon="artifact">
        {summary.outputs.map((o) => <OutputRow key={rowKey(o)} output={o} onLightbox={onLightbox} onFile={openFile} />)}
      </Section>
      {/* "Sources" here means uploads: the files the USER handed the session. Pages the agent fetched
          are a different thing wearing the same word, and they already have a home under the message
          that read them (MessageSources) — listing them here too would make one label mean two things
          a few pixels apart. */}
      <Section title="Sources" count={summary.uploads.length} icon="attach">
        {summary.uploads.map((u) => <UploadRow key={u.path} upload={u} onLightbox={onLightbox} onFile={openFile} />)}
      </Section>
      <Section title="Plans" count={summary.plans.length} icon="plan">
        {summary.plans.map((p) => (
          <button key={p.planId} className="summary-row" onClick={() => { openSheet({ kind: "session-plan", sessionId, planId: p.planId }); onClose(); }}>
            <Icon name="plan" size={12} className="summary-row-glyph" />
            <span className="summary-row-name">{planTitle(p)}</span>
            {p.steps.length > 0 && <span className="summary-row-meta">{p.steps.length} steps</span>}
          </button>
        ))}
      </Section>
    </div>,
    document.body,
  );
}

const rowKey = (o: Output) => (o.kind === "file" ? `file:${o.path}` : `url:${o.url}`);

/** A plan's headline: its first non-empty prose line, else its first step, else a bare label. Never
 *  the whole plan — that is what the sheet is for. */
export function planTitle(p: PlanEntry): string {
  const line = p.text.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean);
  return line ?? p.steps[0]?.text ?? "Plan";
}

function Section({ title, count, icon, children }: { title: string; count: number; icon: IconName; children: React.ReactNode }) {
  // An empty section is omitted rather than shown at zero: "Outputs 0" is a row of chrome saying
  // nothing the section's absence does not already say.
  if (count === 0) return null;
  return (
    <section className="summary-section">
      <h4 className="summary-head"><Icon name={icon} size={12} /><span>{title}</span><span className="summary-count">{count}</span></h4>
      <div className="summary-rows">{children}</div>
    </section>
  );
}

function OutputRow({ output, onLightbox, onFile }: { output: Output; onLightbox: (path: string) => void; onFile: (path: string) => void }) {
  if (output.kind === "url") {
    // A link leaves for the OS browser rather than opening a viewer: there is no viewer Realm could
    // draw for an arbitrary page, and a modal whose only offer was "open this elsewhere" would be a
    // click in front of the click.
    return (
      <a className="summary-row" href={output.url} target="_blank" rel="noreferrer" title={output.url}>
        <Icon name="browser" size={12} className="summary-row-glyph" />
        <span className="summary-row-name">{output.host}</span>
        <span className="summary-row-meta">Link</span>
      </a>
    );
  }
  return (
    <button className="summary-row" title={output.path}
      onClick={() => (output.media === "file" ? onFile(output.path) : onLightbox(output.path))}>
      <Icon name={output.media === "image" ? "image" : output.media === "video" ? "video" : "artifact"} size={12} className="summary-row-glyph" />
      <span className="summary-row-name">{output.name}</span>
    </button>
  );
}

function UploadRow({ upload, onLightbox, onFile }: { upload: Upload; onLightbox: (path: string) => void; onFile: (path: string) => void }) {
  const media = upload.mime.startsWith("image/") || upload.mime.startsWith("video/");
  return (
    <button className="summary-row" title={upload.path}
      onClick={() => (media ? onLightbox(upload.path) : onFile(upload.path))}>
      <Icon name={upload.mime.startsWith("image/") ? "image" : upload.mime.startsWith("video/") ? "video" : "attach"} size={12} className="summary-row-glyph" />
      <span className="summary-row-name">{upload.name}</span>
    </button>
  );
}

/** Media, through the transcript's lightbox. `useMediaFiles` is what confirms the file is still
 *  there; a path the agent wrote and something later deleted opens the plain artifact sheet, which
 *  says so, rather than an empty frame. */
function SummaryLightbox({ path, onClose }: { path: string; onClose: () => void }) {
  const candidates = useMemo(() => [path], [path]);
  const files = useMediaFiles(candidates);
  const file = files[0];
  if (!file) return <ArtifactSheetBody path={path} onClose={onClose} missing />;
  return <MediaLightbox file={file} onClose={onClose} />;
}

/** SheetHost's `artifact` sheet: a file the session produced or was handed, and the one thing Realm
 *  can honestly do with it — hand it to the OS. */
export function ArtifactSheet({ path }: { path: string }) {
  const closeSheet = useApp((s) => s.closeSheet);
  return <ArtifactSheetBody path={path} onClose={closeSheet} />;
}

function ArtifactSheetBody({ path, onClose, missing = false }: { path: string; onClose: () => void; missing?: boolean }) {
  // Same gate the attachment tile applies, and for the same reason: on macOS `open` RUNS an `.app`
  // or a `.command`, so only an extension the mime table recognises — every one of which is a
  // document — may be handed over. Offering the button regardless would be an offer main refuses.
  const openable = isOpenablePath(path);
  return (
    <Sheet title={basenameOf(path)} onClose={onClose} width={480}>
      <p className="summary-file-path">{path}</p>
      {/* Named rather than hidden: a file the session wrote and something has since removed is worth
          knowing about, and it is the reason the button below would fail. */}
      {missing && <p className="summary-file-note">This file is no longer on disk.</p>}
      {openable
        ? <button className="btn" onClick={() => { void window.realm?.openAttachment?.(path); onClose(); }}>Open</button>
        : <p className="summary-file-note">Realm does not know how to open this kind of file.</p>}
    </Sheet>
  );
}

/** SheetHost's `session-plan` sheet: one plan, read from the live transcript rather than copied into
 *  the sheet, so a plan the agent revises while the sheet is open shows the revision. */
export function SessionPlanSheet({ sessionId, planId }: { sessionId: string; planId: string }) {
  const blocks = useApp((s) => s.transcripts[sessionId]?.t.blocks ?? NO_BLOCKS);
  const closeSheet = useApp((s) => s.closeSheet);
  const plan = useMemo(() => summarize(blocks).plans.find((p) => p.planId === planId) ?? null, [blocks, planId]);
  if (!plan) return null;
  return (
    <Sheet title={planTitle(plan)} onClose={closeSheet} width={560}>
      {plan.text && <Markdown className="summary-plan-prose" text={plan.text} />}
      {plan.steps.length > 0 && (
        <ol className="summary-plan-steps">
          {plan.steps.map((s, i) => (
            <li key={i} data-status={s.status}>
              {/* The mark is decorative; the status it stands for is spelled out for a reader who
                  cannot see a filled circle. Colour alone never carries state here. */}
              <span className="summary-step-mark" aria-hidden="true">{STATUS_MARK[s.status] ?? "○"}</span>
              <span>{s.text}</span>
              <span className="visually-hidden">{s.status.replace("_", " ")}</span>
            </li>
          ))}
        </ol>
      )}
    </Sheet>
  );
}
