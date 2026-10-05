import { AGENT_META, basenameOf, isOpenablePath, isPlayablePath, mimeForPath, sessionModeOf, type Session, type SessionStatus } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Composer } from "../../panes/session/Composer";
import { Transcript } from "../../panes/session/Transcript";
import { useMediaFiles } from "../../panes/session/media/use-media";
import { FALLBACK_AGENT, useApp, type PickedAttachment } from "../../state/store";
import { VIEWER_SLOT, exchangeResults, exchangeStart, ownerOf, type ViewerFile, type ViewerState } from "../../state/viewer";
import { ViewerShowContext } from "./open";

const NO_ATTACHMENTS: PickedAttachment[] = [];
const NOOP = () => {};

/**
 * The prompter docked under the viewer, and the exchange it has had — a quick chat about the file on
 * show, in the session the file came from.
 *
 * In that session and not in a side thread, because that is where the file's context is: the agent
 * that made the picture knows what it is for, and "make the sky warmer" is a request about the work
 * that made it. So the question and its answer are ordinary turns of that session, kept in its
 * transcript where the file's history already is, and the viewer draws only its own part of them —
 * from the first message it sent — above its prompter. The file goes with every message, as an
 * attachment through the prompter's own wire, until it is taken off.
 *
 * When the agent answers with a new version of the file — a picture it wrote, or one its answer
 * names — the viewer puts it on the stage beside the original, which ← brings back.
 */
export function ViewerChat({ viewer, file, size, onSettled }: {
  viewer: ViewerState;
  file: ViewerFile;
  /** The file's size on disk, for its chip; null while unknown or for a file that is gone. */
  size: number | null;
  /** A turn of this viewer's exchange has finished — the file on show may have been rewritten. */
  onSettled: () => void;
}) {
  const sessions = useApp((s) => s.sessions);
  const sessionSpace = useApp((s) => s.sessionSpace);
  const ownerId = ownerOf(viewer, file, (id) => sessions[id] !== undefined || id in sessionSpace);
  const owner = ownerId ? sessions[ownerId] : undefined;
  const status: SessionStatus = useApp((s) => (ownerId ? s.sessionStatus[ownerId] ?? s.sessions[ownerId]?.status ?? "idle" : "idle"));
  const entry = useApp((s) => (ownerId ? s.transcripts[ownerId] : undefined));
  const spaceName = useApp((s) => {
    const home = file.from?.spaceId ?? viewer.spaceId ?? s.activeSpaceId;
    return s.spaces.find((sp) => sp.id === home)?.name ?? "this space";
  });
  const draft = useApp((s) => s.drafts[VIEWER_SLOT] ?? "");
  const extras = useApp((s) => s.pendingAttachments[VIEWER_SLOT] ?? NO_ATTACHMENTS);
  const lastAgentKind = useApp((s) => s.lastAgentKind);
  const modelFavorites = useApp((s) => s.modelFavorites);
  const modelInfo = useApp((s) => s.modelInfo);
  const agentProbe = useApp((s) => s.agentProbe);
  const fastSupport = useApp((s) => s.fastSupport);
  const submitKey = useApp((s) => s.submitKey);
  const setDraft = useApp((s) => s.setDraft);
  const sendFromViewer = useApp((s) => s.sendFromViewer);
  const interruptSession = useApp((s) => s.interruptSession);
  const setSessionOptions = useApp((s) => s.setSessionOptions);
  const setSessionAgent = useApp((s) => s.setSessionAgent);
  const pickViewerAgent = useApp((s) => s.pickViewerAgent);
  const attachFromPicker = useApp((s) => s.attachFromPicker);
  const attachFiles = useApp((s) => s.attachFiles);
  const removeAttachment = useApp((s) => s.removeAttachment);
  const detachViewerFile = useApp((s) => s.detachViewerFile);
  const addViewerFiles = useApp((s) => s.addViewerFiles);
  const showViewerFile = useApp((s) => s.showViewerFile);
  const respondPermission = useApp((s) => s.respondPermission);
  const toggleModelFavorite = useApp((s) => s.toggleModelFavorite);
  const closeViewer = useApp((s) => s.closeViewer);
  const revealSession = useApp((s) => s.revealSession);
  const run = useApp((s) => s.run);
  const [sends, setSends] = useState(0);

  /* No session yet: the prompter still has to say which agent and model the first send will start,
     and the picker is how that is chosen — so it is handed a session the size of that choice. */
  const pickKind = viewer.pick?.agentKind ?? lastAgentKind ?? FALLBACK_AGENT;
  const pickModel = viewer.pick?.model ?? null;
  const draftSession = useMemo((): Session => ({
    id: VIEWER_SLOT, spaceId: viewer.spaceId ?? "", projectId: null, agentKind: pickKind, model: pickModel, effort: null,
    permissionMode: "default", fastMode: false, environmentId: "", cwd: "", status: "idle", providerSessionId: null,
    title: "", lastEventSeq: 0, seenSeq: 0, terminalItemId: null, dispatchedBy: null, createdAt: 0, updatedAt: 0,
  }), [viewer.spaceId, pickKind, pickModel]);
  const session = owner ?? draftSession;

  // This viewer's own part of the session: from its first question on, and only in that session.
  const thread = viewer.thread && viewer.thread.sessionId === ownerId ? viewer.thread : null;
  const start = thread && entry ? exchangeStart(entry.t.blocks, thread.from, thread.at) : -1;
  const exchange = useMemo(() => (entry && start >= 0
    // The session's written account is of the whole session, not of this exchange, so it stays out.
    ? { ...entry.t, blocks: entry.t.blocks.slice(start), summary: null, promptHint: null }
    : null), [entry, start]);

  /* What the exchange produced, confirmed on disk: media through main's media gate, which the stage
     can draw, and a written document by its stat. Each lands on the stage once, the first time it is
     seen — moving back to the original afterwards is the person's choice and is not undone. */
  const candidates = useMemo(() => (exchange ? exchangeResults(exchange.blocks, session.cwd || null) : []), [exchange, session.cwd]);
  const media = useMediaFiles(useMemo(() => candidates.filter(isPlayablePath), [candidates]));
  const written = useWrittenFiles(useMemo(() => candidates.filter((p) => !isPlayablePath(p) && p.startsWith("/") && isOpenablePath(p)), [candidates]));
  const handled = useRef(new Set<string>());
  useEffect(() => {
    const fresh = [...media.map((m) => m.path), ...written].filter((p) => !handled.current.has(p));
    if (fresh.length === 0) return;
    for (const p of fresh) handled.current.add(p);
    addViewerFiles(fresh, true);
  }, [media, written, addViewerFiles]);

  // A turn of the exchange ending is when an in-place rewrite of the file on show has landed.
  const busy = status === "running" || status === "waiting_permission";
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && thread) onSettled();
    wasBusy.current = busy;
  }, [busy, thread, onSettled]);

  /* The file goes with the message, as the prompter's first chip, unless it was taken off — or is not
     there to send. The chip's × takes it off this message; the next file viewed brings it back. */
  const viewed: PickedAttachment | null = viewer.detached === file.path || size === null ? null
    : { path: file.path, mime: file.mime ?? mimeForPath(file.path), name: file.name ?? basenameOf(file.path), size };
  const attachments = useMemo(() => (viewed ? [viewed, ...extras.filter((a) => a.path !== viewed.path)] : extras),
    [viewed?.path, viewed?.mime, viewed?.size, extras]); // eslint-disable-line react-hooks/exhaustive-deps -- `viewed` is rebuilt each render from these

  const name = file.name ?? basenameOf(file.path);
  const openOwner = () => {
    if (!ownerId) return;
    closeViewer();
    run(() => revealSession(ownerId, sessionSpace[ownerId] ?? null));
  };
  const kind = session.agentKind;

  return (
    <ViewerShowContext.Provider value={showViewerFile}>
      <section className="media-viewer-chat" aria-label={`Ask about ${name}`}>
        {exchange ? (
          <div className="media-viewer-thread">
            <Transcript transcript={exchange} sessionStatus={status} visible focused={false} cwd={session.cwd || null}
              mode={sessionModeOf(session.permissionMode)} sends={sends}
              onDecide={(requestId, d, answers) => { if (ownerId) run(() => respondPermission(ownerId, requestId, d, answers)); }} />
          </div>
        ) : thread && (
          // Sent while the session was working on something else: the question waits its turn, and
          // until it goes out there is nothing of this exchange's to draw.
          <p className="media-viewer-waiting">{owner ? `Your question goes to ${owner.title} when the turn it is on ends.` : "Your question goes out when the current turn ends."}</p>
        )}
        {/* Where the question goes, which is what decides what the next send means: the session the
            file came from — a way into it, too — or, with none, the session a send will start. */}
        <div className="media-viewer-owner">
          <Icon name={AGENT_META[kind].icon} size={12} colored className="media-viewer-owner-mark" />
          {owner ? (
            <button type="button" className="media-viewer-owner-name" onClick={openOwner}
              title={`Open ${owner.title} — your questions and the answers stay in its transcript`}>
              {owner.title}
            </button>
          ) : (
            <span className="media-viewer-owner-name" title="Your first question starts a session of its own there">New session in {spaceName}</span>
          )}
        </div>
        <Composer compact session={session} status={status} gitInfo={null} hero={false} spaceName=""
          placeholder={`Ask about ${name}, or ask for a change`}
          onOpenDiff={NOOP} draft={draft} onDraftChange={(t) => setDraft(VIEWER_SLOT, t)}
          attachments={attachments}
          onAttachPick={() => run(() => attachFromPicker(VIEWER_SLOT))}
          onAttachFiles={(files) => run(() => attachFiles(VIEWER_SLOT, files))}
          onRemoveAttachment={(path) => (path === file.path ? detachViewerFile(path) : removeAttachment(VIEWER_SLOT, path))}
          onSend={(text) => { setSends((n) => n + 1); run(() => sendFromViewer(text)); }}
          onStop={() => { if (ownerId) run(() => interruptSession(ownerId)); }}
          onOptions={(o) => { if (owner) run(() => setSessionOptions(owner.id, o)); }}
          onPickModel={(pick, modelId) => {
            if (!owner) { pickViewerAgent(pick, modelId); return; }
            run(async () => {
              // setAgent clears `model`, so the model lands after it — the pane's own order.
              if (pick !== owner.agentKind) await setSessionAgent(owner.id, pick);
              if (modelId !== null) await setSessionOptions(owner.id, { model: modelId });
            });
          }}
          onMode={NOOP} planReturn={null}
          canSwitchAgent={!owner || (entry?.t.blocks.length ?? 0) === 0}
          agentProbe={agentProbe} modelFavorites={modelFavorites} modelInfo={modelInfo}
          onToggleModelFavorite={(key) => run(() => toggleModelFavorite(key))}
          sessionInit={entry?.t.init ?? null} fastSupport={fastSupport} submitKey={submitKey} />
      </section>
    </ViewerShowContext.Provider>
  );
}

/** The paths among `paths` that are files on disk, asked of main once each. A write that failed, or
 *  a path the agent named for a file it never made, is simply not among them. */
function useWrittenFiles(paths: readonly string[]): string[] {
  const [found, setFound] = useState<string[]>([]);
  const asked = useRef(new Set<string>());
  // Held across re-runs rather than per effect: a path is asked once, so its answer must land even
  // when the list has grown again before it came back.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const key = paths.join("\n");
  useEffect(() => {
    const fresh = paths.filter((p) => !asked.current.has(p));
    if (fresh.length === 0) return;
    for (const p of fresh) asked.current.add(p);
    void Promise.all(fresh.map((p) => (window.realm?.files?.stat?.(p) ?? Promise.resolve(null)).catch(() => null)))
      .then((stats) => {
        const real = fresh.filter((_, i) => stats[i] != null);
        if (mounted.current && real.length > 0) setFound((cur) => [...cur, ...real]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` IS the path list, stably
  }, [key]);
  return found;
}
