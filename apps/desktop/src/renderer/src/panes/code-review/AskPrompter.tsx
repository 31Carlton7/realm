import { Icon } from "@realm/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { AGENT_META, prKey, prName, sameRepo, sessionModeOf, type PrDetail, type PrPlace, type PrRef, type SessionStatus } from "@realm/contracts";
import { Menu, type MenuItem } from "../../components/Menu";
import { SpaceIcon } from "../../components/SpaceIcon";
import { FALLBACK_AGENT, useApp, type PickedAttachment } from "../../state/store";
import { Composer } from "../session/Composer";
import { draftRun, draftSession as draftAsSession, withOptions, type DraftRun } from "../session/draft-run";
import { Transcript } from "../session/Transcript";
import { codeReview } from "./code-review-api";
import { sentAs } from "./code-review-model";

/** The prompter's draft and attachments live in the store under this slot, as the media viewer's
 *  do under its own — a remount must not drop what was typed. */
export const ASK_SLOT = "code-review";
const NO_ATTACHMENTS: PickedAttachment[] = [];
const NOOP = () => {};

/**
 * "Ask about this pull request": the prompter docked at the foot of the request, and the exchange it
 * has had. The question goes to the request's own session in the chosen place — carried on there
 * while it lives, started with the request attached when it does not (`codeReview.ask`) — so asking
 * twice is one conversation, and the session is a real one, reachable from its place like any other.
 *
 * The place is a space or one of its projects. One whose checkout is the request's repository is
 * chosen first, because there the agent has the code as well as the diff.
 */
export function AskPrompter({ pr, detail, account, place, places, onPlace }: {
  pr: PrRef; detail: PrDetail; account: string | null; place: PrPlace | null; places: PrPlace[]; onPlace: (p: PrPlace) => void;
}) {
  const key = prKey(pr);
  const spaces = useApp((s) => s.spaces);
  const lastAgentKind = useApp((s) => s.lastAgentKind);
  const draft = useApp((s) => s.drafts[ASK_SLOT] ?? "");
  const attachments = useApp((s) => s.pendingAttachments[ASK_SLOT] ?? NO_ATTACHMENTS);
  const agentProbe = useApp((s) => s.agentProbe);
  const modelFavorites = useApp((s) => s.modelFavorites);
  const modelInfo = useApp((s) => s.modelInfo);
  const fastSupport = useApp((s) => s.fastSupport);
  const effortSupport = useApp((s) => s.effortSupport);
  const submitKey = useApp((s) => s.submitKey);
  const setDraft = useApp((s) => s.setDraft);
  const attachFromPicker = useApp((s) => s.attachFromPicker);
  const attachFiles = useApp((s) => s.attachFiles);
  const removeAttachment = useApp((s) => s.removeAttachment);
  const refreshSessions = useApp((s) => s.refreshSessions);
  const openSession = useApp((s) => s.openSession);
  const interruptSession = useApp((s) => s.interruptSession);
  const setSessionOptions = useApp((s) => s.setSessionOptions);
  const toggleModelFavorite = useApp((s) => s.toggleModelFavorite);
  const respondPermission = useApp((s) => s.respondPermission);
  const revealSession = useApp((s) => s.revealSession);
  const closePageOverlay = useApp((s) => s.closePageOverlay);
  const run = useApp((s) => s.run);
  const [thread, setThread] = useState<{ sessionId: string; spaceId: string } | null>(null);
  /* What the first question starts, while there is no session to change: the picker's model, and the
     level, fast mode and permission its card and chips set — each held here exactly as a session's
     row would hold it, and handed to the session `codeReview.ask` makes. */
  const [pick, setPick] = useState<DraftRun>(() => draftRun(lastAgentKind ?? FALLBACK_AGENT));
  const [sends, setSends] = useState(0);
  const [asking, setAsking] = useState(false);
  /* The exchange folds away: it stands over the request, and once its answer is read the request is
     what the person came back to. A new question opens it again. */
  const [shown, setShown] = useState(true);
  const owner = useApp((s) => (thread ? s.sessions[thread.sessionId] : undefined));
  const entry = useApp((s) => (thread ? s.transcripts[thread.sessionId] : undefined));
  const status: SessionStatus = useApp((s) => (thread ? s.sessionStatus[thread.sessionId] ?? s.sessions[thread.sessionId]?.status ?? "idle" : "idle"));

  // The request's session, if a question about it was asked before — loaded so its exchange shows.
  useEffect(() => {
    let live = true;
    setThread(null);
    codeReview.thread(pr).then(async (t) => {
      if (!live || !t.sessionId || !t.spaceId) return;
      await refreshSessions(t.spaceId);
      await openSession(t.sessionId);
      if (live) setThread({ sessionId: t.sessionId, spaceId: t.spaceId });
    }, () => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the request
  }, [key]);

  const ask = (text: string) => run(async () => {
    if (!place) return;
    setSends((n) => n + 1);
    setShown(true);
    setAsking(true);
    try {
      const sent = attachments;
      const r = await codeReview.ask({ ref: pr, spaceId: place.spaceId, projectId: place.projectId, agentKind: owner?.agentKind ?? pick.agentKind, model: pick.model,
        effort: pick.effort, fastMode: pick.fastMode, permissionMode: pick.permissionMode,
        text, attachments: sent.map(({ path, mime }) => ({ path, mime })), ...sentAs(account) });
      for (const a of sent) removeAttachment(ASK_SLOT, a.path);
      await refreshSessions(place.spaceId);
      await openSession(r.sessionId);
      setThread({ sessionId: r.sessionId, spaceId: place.spaceId });
    } catch (e) {
      // The question is not lost to a refusal: it goes back in the box it was typed in.
      setDraft(ASK_SLOT, text);
      throw e;
    } finally { setAsking(false); }
  });

  /* No session yet: the prompter still says which agent and model the first question starts, and the
     picker is how that is chosen — so it is handed a session the size of that choice. */
  const draftSession = useMemo(() => draftAsSession(pick, { id: ASK_SLOT, spaceId: place?.spaceId ?? "", projectId: place?.projectId ?? null, cwd: place?.path ?? "" }),
    [place?.spaceId, place?.projectId, place?.path, pick]);
  // A thread in another place than the one chosen is not where the next question goes: it starts anew.
  const continuing = thread && owner && place && thread.spaceId === place.spaceId ? owner : null;
  const session = continuing ?? draftSession;
  const exchange = useMemo(() => (entry && continuing ? { ...entry.t, summary: null, promptHint: null } : null), [entry, continuing]);
  const openOwner = () => { if (!continuing) return; closePageOverlay(); run(() => revealSession(continuing.id, continuing.spaceId)); };

  return (
    <section className="cr-ask" aria-label="Ask about this pull request">
      {exchange && exchange.blocks.length > 0 && shown && (
        <div className="cr-ask-thread">
          <Transcript transcript={exchange} sessionStatus={status} visible focused={false} cwd={continuing?.cwd || null}
            mode={sessionModeOf(session.permissionMode)} sends={sends}
            onDecide={(requestId, d, answers) => { if (continuing) run(() => respondPermission(continuing.id, requestId, d, answers)); }} />
        </div>
      )}
      <div className="cr-ask-where">
        <PlaceChip pr={pr} place={place} places={places} spaces={spaces} onPlace={onPlace} />
        {continuing ? (
          <button type="button" className="cr-ask-owner" onClick={openOwner} title={`Open ${continuing.title} — your questions and their answers stay in its transcript`}>
            <Icon name={AGENT_META[continuing.agentKind].icon} size={12} colored />{continuing.title}
          </button>
        ) : <span className="cr-ask-new" title="The first question starts a session there, with the pull request attached">New session</span>}
        {exchange && exchange.blocks.length > 0 && (
          <button type="button" className="cr-ask-fold" aria-expanded={shown} onClick={() => setShown((v) => !v)}
            title={shown ? "Fold the answers away" : "Show the answers"}>
            {shown ? "Hide answers" : "Show answers"}<Icon name={shown ? "chevronDown" : "chevronUp"} size={12} />
          </button>
        )}
      </div>
      <Composer compact session={session} status={asking ? "running" : status} gitInfo={null} hero={false} spaceName=""
        placeholder={`Ask about ${prName(detail.ref)}`}
        onOpenDiff={NOOP} draft={draft} onDraftChange={(t) => setDraft(ASK_SLOT, t)}
        attachments={attachments}
        onAttachPick={() => run(() => attachFromPicker(ASK_SLOT))}
        onAttachFiles={(files) => run(() => attachFiles(ASK_SLOT, files))}
        onRemoveAttachment={(path) => removeAttachment(ASK_SLOT, path)}
        onSend={ask}
        onStop={() => { if (continuing) run(() => interruptSession(continuing.id)); }}
        onOptions={(o) => {
          if (continuing) run(() => setSessionOptions(continuing.id, o));
          else setPick((p) => withOptions(p, o));
        }}
        onPickModel={(kind, modelId) => {
          if (!continuing) { setPick((p) => ({ ...p, agentKind: kind, model: modelId })); return; }
          if (modelId !== null) run(() => setSessionOptions(continuing.id, { model: modelId }));
        }}
        onMode={NOOP} planReturn={null}
        canSwitchAgent={!continuing}
        agentProbe={agentProbe} modelFavorites={modelFavorites} modelInfo={modelInfo}
        onToggleModelFavorite={(k) => run(() => toggleModelFavorite(k))}
        sessionInit={entry?.t.init ?? null} fastSupport={fastSupport} effortSupport={effortSupport} submitKey={submitKey} />
    </section>
  );
}

/** Where the question goes: a space, or a project in one. A checkout of the request's repository
 *  says so, since that is where the agent can read the code as well as the diff. */
function PlaceChip({ pr, place, places, spaces, onPlace }: {
  pr: PrRef; place: PrPlace | null; places: PrPlace[]; spaces: { id: string; name: string; icon: string }[]; onPlace: (p: PrPlace) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const repo = `${pr.owner}/${pr.repo}`;
  const spaceOf = (id: string) => spaces.find((s) => s.id === id);
  const nameOf = (p: PrPlace) => (p.projectId ? `${spaceOf(p.spaceId)?.name ?? "Space"} / ${p.name}` : p.name);
  const items: MenuItem[] = places.map((p) => ({
    label: nameOf(p),
    checked: !!place && place.spaceId === p.spaceId && place.projectId === p.projectId,
    detail: p.repo && sameRepo(p.repo, repo) ? `Has ${repo} checked out${p.branch ? ` on ${p.branch}` : ""}` : p.path,
    icon: <SpaceIcon icon={spaceOf(p.spaceId)?.icon ?? "folder"} size={14} />,
    onSelect: () => onPlace(p),
  }));
  const here = place?.repo && sameRepo(place.repo, repo);
  return (
    <>
      <button ref={anchor} type="button" className="cr-ask-place" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        title={place ? (here ? `Asks in a checkout of ${repo}` : `Asks in ${place.path}`) : "Choose where to ask"}>
        <Icon name={here ? "branch" : "folder"} size={12} />
        <span className="cr-ask-place-name">{place ? nameOf(place) : "Choose project"}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open && <Menu items={items} anchorRef={anchor} align="left" placement="up" label="Ask in" onClose={() => setOpen(false)} />}
    </>
  );
}
