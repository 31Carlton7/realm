import { Icon } from "@realm/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { GH_LOGIN_COMMAND, prKey, type GhStatus, type PrDetail, type PrPlace, type PrRef, type PrSummary } from "@realm/contracts";
import { useApp } from "../../state/store";
import type { PaneProps } from "../registry";
import { codeReview, terminalWith } from "./code-review-api";
import { pageHeld } from "./held";
import { PrColumn } from "./PrColumn";
import { PrView } from "./PrView";

/** `gh` and its sign-in in one line, for a Mac that has neither — offered, never run. */
const INSTALL_COMMAND = `brew install gh && ${GH_LOGIN_COMMAND}`;

/**
 * Code review: pull requests on GitHub, read and reviewed here (the rail's place where Notifications
 * was). Codex's layout — the page's own column of requests, and beside it the one being read — over
 * the person's own `gh`, so Realm holds no GitHub token and sees what `gh` sees.
 *
 * Until `gh` is installed and signed in, the page is the way to get it there: what is missing, said
 * plainly, and Set up GitHub, which opens a terminal with the command typed in for the person to run.
 * Coming back to the window asks again, so finishing the sign-in is the whole of the next step.
 */
export function CodeReviewPage({ item }: PaneProps) {
  const vantage = item.spaceId;
  const profileId = useApp((s) => s.activeProfileId);
  const windowActive = useApp((s) => s.windowActive);
  const [status, setStatus] = useState<GhStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback((force: boolean) => {
    setChecking(true);
    return codeReview.status(force).then(
      (s) => { setStatus(s); return s; },
      (e: unknown): GhStatus => { const s: GhStatus = { state: "unreachable", login: null, reason: e instanceof Error ? e.message : String(e) }; setStatus(s); return s; },
    ).finally(() => setChecking(false));
  }, []);
  // The held answer first, so the page draws at once; one that says "not yet" is asked again fresh,
  // since the person may be back from the terminal it sent them to.
  useEffect(() => { void check(false).then((s) => { if (s.state !== "ready") void check(true); }); }, [check]);
  const away = useRef(!windowActive);
  useEffect(() => {
    if (windowActive && away.current && status && status.state !== "ready") void check(true);
    away.current = !windowActive;
  }, [windowActive, status, check]);

  if (!status) return <div className="page code-review-page" aria-busy="true" />;
  if (status.state !== "ready" || !profileId) {
    return <div className="page code-review-page"><Setup status={status} vantage={vantage} checking={checking} onCheck={() => void check(true)} /></div>;
  }
  return <Ready login={status.login} profileId={profileId} vantage={vantage} onLost={() => void check(true)} />;
}

function Ready({ login, profileId, vantage, onLost }: { login: string | null; profileId: string; vantage: string; onLost: () => void }) {
  const run = useApp((s) => s.run);
  const [selected, setSelected] = useState<PrRef | null>(pageHeld.selection);
  const [pins, setPins] = useState<PrSummary[]>([]);
  const [places, setPlaces] = useState<PrPlace[]>([]);
  const signIn = useSignIn(vantage);

  useEffect(() => {
    let live = true;
    codeReview.pins(profileId).then((r) => { if (live) setPins(r.pins); }, () => {});
    codeReview.places(profileId).then((r) => { if (live) setPlaces(r.places); }, () => {});
    return () => { live = false; };
  }, [profileId]);

  const select = (ref: PrRef) => { pageHeld.selection = ref; setSelected(ref); };
  const pin = (d: PrDetail, pinned: boolean) => run(async () => {
    const row: PrSummary = { ref: d.ref, title: d.title, url: d.url, state: d.state, draft: d.draft, author: d.author, createdAt: d.createdAt, updatedAt: d.updatedAt };
    setPins((await codeReview.setPinned({ profileId, pr: row, pinned })).pins);
  });
  const isPinned = (ref: PrRef) => pins.some((p) => prKey(p.ref) === prKey(ref));

  return (
    <div className="page code-review-page">
      <PrColumn login={login} pins={pins} selected={selected} onSelect={(ref) => select(ref)} onSignIn={() => signIn(GH_LOGIN_COMMAND)} onLost={onLost} />
      <div className="cr-main">
        {selected ? (
          <PrView key={prKey(selected)} pr={selected} login={login} profileId={profileId} vantage={vantage} places={places}
            pinned={isPinned(selected)} onPin={pin} />
        ) : (
          <div className="cr-empty">
            {/* off-ladder: the empty column's one picture, Codex's mark over the line that says what to
                do — the subject of an empty composition, as the Scheduled page's clock is. */}
            <Icon name="pullRequest" size={24} className="cr-empty-mark" />
            <h2 className="cr-empty-title">Select a pull request</h2>
            <p className="cr-empty-line">Choose one from the column to read it, review it, and ask about it.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** Put a terminal on screen with `command` typed into it: the page steps aside, since the terminal
 *  is the thing to look at now. */
function useSignIn(spaceId: string) {
  const run = useApp((s) => s.run);
  const refreshItems = useApp((s) => s.refreshItems);
  const openItem = useApp((s) => s.openItem);
  const closePageOverlay = useApp((s) => s.closePageOverlay);
  return (command: string) => run(async () => {
    const { itemId } = await terminalWith(spaceId, command);
    await refreshItems(spaceId);
    closePageOverlay();
    await openItem(itemId);
  });
}

/** What stands between the page and GitHub, and the one step that removes it. */
function Setup({ status, vantage, checking, onCheck }: { status: GhStatus; vantage: string; checking: boolean; onCheck: () => void }) {
  const signIn = useSignIn(vantage);
  const missing = status.state === "missing";
  const command = missing ? INSTALL_COMMAND : GH_LOGIN_COMMAND;
  return (
    <div className="pane-empty cr-setup">
      {/* off-ladder: the page's subject at the size of the empty state's picture, as the diff pane's folder is. */}
      <div className="pane-empty-tile" aria-hidden="true"><Icon name="pullRequest" size={28} /></div>
      <h1 className="pane-empty-title">Code review</h1>
      {status.state === "unreachable" ? (
        <p className="pane-empty-line">GitHub did not answer{status.reason ? `: ${status.reason}` : "."}</p>
      ) : (
        <p className="pane-empty-line">
          {missing
            ? "Read pull requests from GitHub, review them with any agent, and post your review — through GitHub's own command-line tool, gh, which is not on this Mac yet."
            : "Read pull requests from GitHub, review them with any agent, and post your review — through gh, signed in as you."}
        </p>
      )}
      {status.state === "unreachable" ? (
        <button type="button" className="btn primary" disabled={checking} aria-busy={checking || undefined} onClick={onCheck}>{checking ? "Checking…" : "Check again"}</button>
      ) : (
        <>
          <button type="button" className="btn primary cr-setup-go" onClick={() => signIn(command)}><Icon name="github" size={14} />Set up GitHub</button>
          <p className="cr-setup-how">
            Opens a terminal with <code>{command}</code> typed in. Press Return to run it, sign in when it asks, then come back here.
            {missing && <> No Homebrew? gh is also at cli.github.com.</>}
          </p>
          <button type="button" className="btn-quiet" disabled={checking} onClick={onCheck}>{checking ? "Checking…" : "Check again"}</button>
        </>
      )}
    </div>
  );
}
