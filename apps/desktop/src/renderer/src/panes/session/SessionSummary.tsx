import { Icon, type IconName } from "@realm/ui";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AGENT_META, DEFAULT_MODEL_LABEL, PERMISSION_MODES, SESSION_MODES, documentKindFor, sessionModeOf, type Environment, type GitInfo, type Item, type McpServer, type MemorySources, type Session } from "@realm/contracts";
import { useApp } from "../../state/store";
import { ScrollFades } from "../../components/ScrollFades";
import { FilePreview } from "../../components/FilePreview";
import { Sheet } from "../../components/Sheet";
import { Markdown } from "./Markdown";
import { MediaLightbox } from "./media/MediaView";
import { useMediaFiles } from "./media/use-media";
import { emptyTranscript } from "./transcript-model";
import { isEmptySummary, recapOf, summarize, type Output, type PlanEntry, type SessionSummary, type Upload } from "./session-summary";
import { isPlanDecision } from "./PlanCard";

/** Cents below a penny, so a session that has spent $0.004 does not read as free. Lives here now
 *  rather than in SessionPane, because this is the only surface that shows a cost. */
const fmtCost = (usd: number) => (usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`);

/**
 * The narrowest pane that still gets a PINNED summary.
 *
 * 320 for the panel, twice its inset, and 420 left for the transcript — which is roughly where a
 * message stops being a column and starts being a gutter. Below it the panel floats instead; the
 * alternative, pinning at any width, means a pane split three ways shows a summary and a sliver.
 */
export const SUMMARY_PIN_MIN_PANE = 320 + 420 + 16;

const NO_BLOCKS = emptyTranscript().blocks;
const NO_PERMISSIONS = emptyTranscript().pendingPermissions;
const EMPTY_USAGE = emptyTranscript().usage;
const STATUS_MARK: Record<string, string> = { pending: "○", in_progress: "◐", completed: "●" };

/**
 * The session PANE's rectangle, in viewport coordinates, as `right`/`top`/`height` insets.
 *
 * The panel docks to the pane rather than to the button, because a session pane is one column of a
 * split and a panel measured from the button would hang over whatever is beside it. Re-measured on
 * resize for the same reason: dragging a splitter must move the panel with the pane it belongs to.
 */
function usePaneRect(anchorRef: React.RefObject<HTMLElement | null>) {
  const [rect, setRect] = useState<{ right: number; top: number; height: number; width: number; pane: HTMLElement | null } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      /* Up to the leaf, then back DOWN to the session body.
         The button lives in the PanelBar, which is the leaf's chrome — so `.session-pane` never
         matched from here and the panel fell back to the whole window. Docking to the leaf instead
         is not right either: the leaf includes the bar, so the panel would cover its own toggle.
         The body is the box it should sit beside. Only a real window shows either mistake; in jsdom
         every rect is zero and all three answers look identical. */
      const leaf = anchorRef.current?.closest(".panel");
      const pane = (leaf?.querySelector(".session-pane") ?? leaf) as HTMLElement | null;
      // No pane to dock to (the button rendered on its own) falls back to the viewport's right edge
      // rather than to nothing. A panel that hides itself when it cannot find its anchor is a panel
      // that vanishes for a reason the user cannot see.
      const b = pane?.getBoundingClientRect();
      setRect(b
        ? { right: Math.max(0, window.innerWidth - b.right), top: b.top, height: b.height, width: b.width, pane }
        : { right: 0, top: 0, height: window.innerHeight, width: window.innerWidth, pane: null });
    };
    measure();
    window.addEventListener("resize", measure);
    // The splitter moves the pane without a window resize, so the pane itself is observed too.
    const observed = anchorRef.current?.closest(".panel");
    const ro = typeof ResizeObserver === "undefined" || !observed ? null : new ResizeObserver(measure);
    ro?.observe(observed!);
    return () => { window.removeEventListener("resize", measure); ro?.disconnect(); };
  }, [anchorRef]);
  return rect;
}

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
  const cost = useApp((s) => s.transcripts[id]?.t.usage.costUsd ?? 0);
  const summary = useMemo(() => summarize(blocks), [blocks]);
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  /** Media opens HERE, in the transcript's own lightbox — the same surface a message's attachment
   *  opens in, because a file must not open two different ways depending on which list it was
   *  reached from. Files and plans go through the store's sheet slot instead (SheetHost), which is
   *  what keeps a modal from being painted over by a browser pane's native view. */
  const [lightbox, setLightbox] = useState<string | null>(null);
  /* The gate is "has this session anything to report", and spend counts. Gating on the three lists
     alone hid the cost with the button for a session that had run a turn and written nothing — the
     exact case where "what is this costing me" is the live question. */
  if (isEmptySummary(summary) && cost === 0) return null;
  return (
    <>
      {/* `data-on` while the panel is up. The icon itself cannot fill — only the stroke pack ships
          here — so the BUTTON fills instead, which is the ordinary toggle treatment and says the
          same thing: this control is currently on. The fill is `.icon-btn[data-on]`, shared with the
          pane bar's focus toggle: "this control is on" gets one appearance in this bar, or a user
          learns two of them. */}
      <button ref={btn} className="icon-btn" data-on={open || undefined}
        aria-label={`Summary of ${item.title}`} title="Outputs, sources and plans"
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {/* The glyph alone. The cost rode this button for a version and was too much for a control
            in a four-button strip — it is inside the panel, where the rest of the session's numbers
            already are, and where a number has room to be labelled. */}
        <Icon name="info" size={14} />
      </button>
      {open && (
        <SummaryPanel summary={summary} sessionId={id} environmentId={environmentId} anchorRef={btn} onClose={() => setOpen(false)}
          onLightbox={(path) => setLightbox(path)} />
      )}
      {lightbox && <SummaryLightbox path={lightbox} onClose={() => setLightbox(null)} />}
    </>
  );
}

/**
 * The panel itself — three sections, each drawn only when it has rows.
 *
 * A side panel docked to the session pane's right edge, not a popover hanging off its button. Two
 * things follow from that and both were asked for by name:
 *
 *  - **It stays.** A popover closes on the next click anywhere, which made it useless for the thing
 *    people actually do with it — read the list while scrolling the transcript for the message that
 *    produced a file. It closes when the button is pressed again, or on Escape.
 *  - **It is positioned against the PANE, not the button.** A session pane is one column of a split;
 *    a panel measured from the button would hang over whatever is beside it.
 */
function SummaryPanel({ summary, sessionId, environmentId, anchorRef, onClose, onLightbox }: {
  summary: SessionSummary;
  sessionId: string;
  /** The session's checkout — the workspace a file opens against. */
  environmentId: string | null;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onLightbox: (path: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const rect = usePaneRect(anchorRef);
  /* Pinned or floating, decided by how much room the pane has.
   *
   * The panel is a fixed 320 plus its inset. A pane wide enough to give that up and still leave a
   * readable column keeps the panel PINNED — it sits beside the transcript rather than over it, and
   * stays put while you scroll, which is the whole thing it is for. A narrower pane cannot do that
   * without squeezing the transcript into a gutter, so there the panel floats over the pane and
   * dismisses on a click outside, the way any overlay you did not make room for should. */
  const pinned = (rect?.width ?? 0) >= SUMMARY_PIN_MIN_PANE;

  /* Pinning means the transcript gets out of the way, and the transcript is not this component's to
     render. The attribute goes on the pane node the measurement already found, and comes off on
     unmount — a small, reversible write to a node React owns the children of but not the state of,
     which is cheaper than threading an open flag up through SessionPane and back down. */
  useEffect(() => {
    const pane = rect?.pane;
    if (!pane || !pinned) return;
    pane.dataset.summaryPinned = "";
    return () => { delete pane.dataset.summaryPinned; };
  }, [rect?.pane, pinned]);

  /* Outside-click dismissal, but only while floating. Pinned, this panel's whole job is to stay
     readable while you work in the transcript beside it, and a dismiss-on-any-click panel cannot do
     that — which is why it was Escape-only before there was a pinned mode to tell it apart from. */
  useEffect(() => {
    if (pinned) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [pinned, onClose, anchorRef]);
  const usage = useApp((s) => s.transcripts[sessionId]?.t.usage ?? EMPTY_USAGE);
  const blocks = useApp((s) => s.transcripts[sessionId]?.t.blocks ?? NO_BLOCKS);
  const recap = useMemo(() => recapOf(blocks), [blocks]);
  /** The model's account, when one has been written for this session. */
  const written = useApp((s) => s.transcripts[sessionId]?.t.summary?.text ?? null);
  // Escape closes it in either mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
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
    /* Docked to the pane's right edge and its TOP, and then as tall as it needs to be.
       It used to take `height: rect.height`, so three short rows drew a column of empty surface the
       height of the window — a panel claiming room it had nothing to put in. The pane's height is now
       a CAP, handed over as a custom property so the inset it has to leave at both ends stays in the
       stylesheet that owns the inset (`--sidebar-inset`); a max-height computed here would be the
       same number written twice. Top-aligned rather than centred or bottom-docked, because the panel
       is a continuation of the pane bar's button and the eye starts at the same place either way. */
    <div ref={ref} className="session-summary" role="dialog" aria-label="Session summary" data-pinned={pinned || undefined}
      style={{ position: "fixed", right: rect?.right ?? 0, top: rect?.top ?? 0,
        "--summary-pane-h": `${rect?.height ?? window.innerHeight}px` } as React.CSSProperties}>
      <div className="summary-panel-head">
        <h3>Summary</h3>
        <button type="button" className="icon-btn" aria-label="Close summary" onClick={onClose}>
          <Icon name="close" size={12} />
        </button>
      </div>
      {/* Only drawn when something is genuinely under them — which, now the panel is content-height,
          is only when the content reached the cap. A band over a list that fits is a band over
          nothing, and `ScrollFades` is the primitive that already knows the difference. */}
      <div className="summary-scroll-wrap">
      <ScrollFades scroller={scroller} />
      <div className="summary-scroll" ref={scroller}>
      {/* What the session was ABOUT, first. The three lists below say what it produced, and none of
          them answers the question a panel called "Summary" is actually being asked — a filename
          tells you nothing about why the file exists.
          Written by a model when there is one to ask, and keyed on the text so a new account fades
          in rather than replacing the old one under the reader. The pair below is the fallback, and
          it is the transcript rearranged — the last thing asked and the first line of the answer —
          which is honest but reads as thin, because it IS just the two ends of the log. */}
      {written ? (
        <div className="summary-recap" key={written}>
          <p className="summary-recap-answered">{written}</p>
        </div>
      ) : recap && (
        <div className="summary-recap">
          {recap.asked && <p className="summary-recap-asked">{recap.asked}</p>}
          {recap.answered && <p className="summary-recap-answered">{recap.answered}</p>}
        </div>
      )}
      {/* Spend next, because it is the one fact that is true from the first turn — and because a
          panel whose three lists are still empty must not open onto nothing. */}
      {(usage.costUsd > 0 || usage.numTurns > 0) && (
        <div className="summary-spend">
          <span>{fmtCost(usage.costUsd)}</span>
          <span className="summary-spend-turns">{usage.numTurns === 1 ? "1 turn" : `${usage.numTurns} turns`}</span>
        </div>
      )}
      {/* What the agent is WORKING WITH, before what it made: the folder and branch it runs in, the
          model and permission it runs under, the memory files that actually reach it, and the
          connections it can call. Every one of these is a fact the app already holds somewhere —
          a chip, a settings page, a memory pane — and this is the one place they stand together,
          which is what "show me this agent's context" asks for. */}
      <ContextSection sessionId={sessionId} />
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
      </div>
      </div>
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

/** One fact of the session's context: a value with the label beside it, on the section's row grid. */
function Fact({ icon, label, value, title }: { icon: IconName; label: string; value: string; title?: string }) {
  return (
    <div className="summary-row summary-fact" title={title ?? value}>
      <Icon name={icon} size={12} className="summary-row-glyph" />
      <span className="summary-row-name">{value}</span>
      <span className="summary-row-meta">{label}</span>
    </div>
  );
}

/**
 * The session's context, as rows: where it runs, what it runs as, what it reads, what it can reach.
 *
 * Each row is derived from state the store already keeps for other reasons — the session row, the
 * environment, `gitInfo` for the cwd, the memory pane's per-session sources, the connections list —
 * and asks for exactly one refresh (the memory sources, which are fetched per session on demand).
 * A fact the store does not have is a row that is not drawn: "Branch —" would be a claim about a
 * folder nobody has asked git about.
 */
export function ContextSection({ sessionId }: { sessionId: string }) {
  const session = useApp((s) => s.sessions[sessionId] ?? null);
  const env = useApp((s) => (session ? s.environments[session.environmentId] ?? null : null));
  const git = useApp((s) => (session ? s.gitInfo[session.cwd] ?? null : null));
  const memory = useApp((s) => s.sessionMemorySources[sessionId] ?? null);
  const servers = useApp((s) => s.mcpServers);
  const refreshMemorySources = useApp((s) => s.refreshMemorySources);
  const run = useApp((s) => s.run);
  useEffect(() => { if (session) run(() => refreshMemorySources(sessionId)); }, [session?.id, sessionId, refreshMemorySources, run]);
  if (!session) return null;
  const rows = contextRows({ session, env, git, memory, servers });
  return (
    <Section title="Context" count={rows.length} icon="folder">
      {rows.map((r) => <Fact key={r.label} {...r} />)}
    </Section>
  );
}

/** The rows, as data, so the test can hold the rule for each without a DOM. */
export function contextRows({ session, env, git, memory, servers }: {
  session: Session; env: Environment | null; git: GitInfo | null; memory: MemorySources | null; servers: McpServer[];
}): { icon: IconName; label: string; value: string; title?: string }[] {
  const out: { icon: IconName; label: string; value: string; title?: string }[] = [];
  const folder = session.cwd.replace(/\/+$/, "").split("/").pop() || session.cwd;
  out.push({ icon: "folder", label: env?.kind === "worktree" ? "worktree" : "folder", value: folder, title: session.cwd });
  const branch = git?.branch || env?.branch || null;
  if (branch) out.push({ icon: "branch", label: git && git.dirty > 0 ? `branch · ${git.dirty} changed` : "branch", value: branch });
  const model = session.model ?? DEFAULT_MODEL_LABEL[session.agentKind];
  const effort = session.effort ? ` · ${session.effort}` : "";
  out.push({ icon: AGENT_META[session.agentKind].icon, label: AGENT_META[session.agentKind].label, value: `${model}${effort}` });
  const mode = sessionModeOf(session.permissionMode);
  const permission = mode === "build"
    ? (PERMISSION_MODES.find((m) => m.id === session.permissionMode)?.label ?? session.permissionMode)
    : (SESSION_MODES.find((m) => m.id === mode)?.label ?? mode);
  out.push({ icon: "tool", label: "permission", value: permission });
  if (memory) {
    const reaching = memory.sources.filter((m) => m.exists && m.via !== "none");
    const names = reaching.map((m) => m.path.split("/").pop() || m.path);
    const value = reaching.length === 0
      ? (memory.realmMemoryInjected ? "Realm memory" : "none")
      : `${memory.realmMemoryInjected ? "Realm memory, " : ""}${names.slice(0, 3).join(", ")}${names.length > 3 ? `, +${names.length - 3}` : ""}`;
    out.push({ icon: "documents", label: "memory", value, title: reaching.map((m) => m.path).join("\n") || memory.note });
  }
  const connected = servers.filter((sv) => sv.status === "connected");
  if (connected.length > 0) {
    out.push({ icon: "connections-page", label: connected.length === 1 ? "connection" : "connections", value: connected.map((sv) => sv.name).join(", "),
      title: connected.map((sv) => `${sv.name} · ${sv.tools.length} tools`).join("\n") });
  }
  return out;
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
  if (!file) return <FilePreview path={path} onClose={onClose} />;
  return <MediaLightbox file={file} onClose={onClose} />;
}

/** SheetHost's `artifact` sheet: a file the session produced or was handed. The preview itself is
 *  shared with the Library (`FilePreview`) — a `.zip` reached from a summary and the same `.zip`
 *  reached from the file browser must not offer two different sets of actions. This sheet passes no
 *  provenance: the summary knows the path and nothing the preview could turn into a "go to the
 *  session it came from", so that row is simply absent rather than half-filled. */
export function ArtifactSheet({ path }: { path: string }) {
  const closeSheet = useApp((s) => s.closeSheet);
  return <FilePreview path={path} onClose={closeSheet} />;
}

/** SheetHost's `session-plan` sheet: one plan, read from the live transcript rather than copied into
 *  the sheet, so a plan the agent revises while the sheet is open shows the revision. */
export function SessionPlanSheet({ sessionId, planId }: { sessionId: string; planId: string }) {
  const blocks = useApp((s) => s.transcripts[sessionId]?.t.blocks ?? NO_BLOCKS);
  const pending = useApp((s) => s.transcripts[sessionId]?.t.pendingPermissions ?? NO_PERMISSIONS);
  const status = useApp((s) => s.sessions[sessionId]?.status);
  const closeSheet = useApp((s) => s.closeSheet);
  const respondPermission = useApp((s) => s.respondPermission);
  const sendMessage = useApp((s) => s.sendMessage);
  const run = useApp((s) => s.run);
  const plan = useMemo(() => summarize(blocks).plans.find((p) => p.planId === planId) ?? null, [blocks, planId]);
  /* The plan the agent is CURRENTLY waiting on, if this is it. Approving that request is what
     actually leaves Plan mode (see `respondPermission`), so when it exists it is the only honest way
     to implement the plan — a chat message saying "go ahead" would leave the session in Plan and the
     agent would answer it with more planning. */
  const awaiting = status === "waiting_permission" ? pending.find((p) => isPlanDecision(p)) : undefined;
  if (!plan) return null;
  const implement = () => {
    if (awaiting) run(() => respondPermission(sessionId, awaiting.requestId, "allow"));
    // An older plan, already answered or never gated: there is no request to approve, so this is a
    // fresh instruction. Naming the plan matters — a session may have proposed three.
    else run(() => sendMessage(sessionId, `Implement this plan: ${planTitle(plan)}`));
    closeSheet();
  };
  return (
    <Sheet title={planTitle(plan)} onClose={closeSheet} width={560}
      footer={<button type="button" className="btn primary" onClick={implement}>Implement this plan</button>}>
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
