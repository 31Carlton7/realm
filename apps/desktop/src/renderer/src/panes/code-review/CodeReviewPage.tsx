import { Icon } from "@realm/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { GH_LOGIN_COMMAND, prKey, type GhStatus, type PrDetail, type PrPlace, type PrRef, type PrSummary } from "@realm/contracts";
import { PageRail } from "../../components/page-nav";
import { useApp } from "../../state/store";
import type { PaneProps } from "../registry";
import { codeReview, terminalWith } from "./code-review-api";
import { holdStatus, pageHeld, signInSent } from "./held";
import { PrColumn, PrColumnPending } from "./PrColumn";
import { PrView } from "./PrView";

/** `gh` and its sign-in in one line, for a Mac that has neither — offered, never run. */
const INSTALL_COMMAND = `brew install gh && ${GH_LOGIN_COMMAND}`;

/**
 * Code review: pull requests on GitHub, read and reviewed here (the rail's place where Notifications
 * was). Codex's layout — the page's own column of requests, and beside it the one being read — over
 * the person's own `gh`, so Realm holds no GitHub token and sees what `gh` sees. The column is the
 * sidebar's while the page is up (`PageRail`), as every page's sections are; folded away, it is the
 * page's.
 *
 * Until `gh` is installed and signed in, the page is the way to get it there: what is missing, said
 * plainly, and Set up GitHub, which opens a terminal with the command typed in for the person to run.
 * Coming back to the window asks again, so finishing the sign-in is the whole of the next step.
 *
 * Which of gh's accounts it reads and posts as is the profile's own (`prAccountKey`), so the page is
 * one page per profile: another profile's is asked about afresh rather than drawn as this one's.
 */
export function CodeReviewPage({ item }: PaneProps) {
  const profileId = useApp((s) => s.activeProfileId);
  return <CodeReviewForProfile key={profileId ?? ""} profileId={profileId} vantage={item.spaceId} />;
}

/**
 * One profile's page: who gh says it reads as, and under that the page, or the way to set gh up.
 *
 * A pick made away from this page, in Settings or in another window, is stored before it is
 * announced, so asking on hearing of it is answered as the account that was picked. An answer asked
 * for before a pick was heard of is not drawn: it can come back after that one, and would put the
 * page back on the account from before.
 *
 * Refresh asks who is signed in as well as for the lists: a terminal may have switched gh's active
 * account, and a profile that picked none reads and posts as whichever that is. Where the answer is
 * that GitHub could not be reached, or the question is refused, nothing is drawn: the lists say so
 * in place, and the request being read stays on the page.
 */
function CodeReviewForProfile({ profileId, vantage }: { profileId: string | null; vantage: string }) {
  const windowActive = useApp((s) => s.windowActive);
  const profiles = useApp((s) => s.profiles);
  const profile = profiles.length > 1 ? profiles.find((p) => p.id === profileId)?.name ?? null : null;
  // What gh said last time, so a page opened again is drawn in its first frame as it was left —
  // column and all — and asked again behind it.
  const [status, setStatus] = useState<GhStatus | null>(() => (pageHeld.statusProfile === profileId ? pageHeld.status : null));
  const [checking, setChecking] = useState(false);

  const answer = useCallback((s: GhStatus) => { holdStatus(profileId, s); setStatus(s); return s; }, [profileId]);
  const picks = useRef(0);
  const check = useCallback((force: boolean) => {
    setChecking(true);
    const heardOf = picks.current;
    const heard = (s: GhStatus) => (heardOf === picks.current ? answer(s) : s);
    return codeReview.status(profileId, force).then(
      heard,
      (e: unknown): GhStatus => heard({ state: "unreachable", login: null, reason: e instanceof Error ? e.message : String(e) }),
    ).finally(() => setChecking(false));
  }, [profileId, answer]);
  useEffect(() => codeReview.onAccount((p) => {
    if (p.profileId !== profileId) return;
    picks.current += 1;
    void check(false);
  }), [profileId, check]);
  const askAgain = useCallback(() => {
    const heardOf = picks.current;
    codeReview.status(profileId, true).then((s) => { if (heardOf === picks.current && s.state !== "unreachable") answer(s); }, () => {});
  }, [profileId, answer]);
  // The held answer first, so the page draws at once; one that says "not yet" is asked again fresh,
  // since the person may be back from the terminal it sent them to.
  useEffect(() => {
    const stale = pageHeld.stale.status;
    pageHeld.stale.status = false;
    void check(stale).then((s) => { if (s.state !== "ready" && !stale) void check(true); });
  }, [check]);
  const away = useRef(!windowActive);
  useEffect(() => {
    if (windowActive && away.current && status && status.state !== "ready") void check(true);
    away.current = !windowActive;
  }, [windowActive, status, check]);

  /* Not asked yet in this window: the page as it will be once gh answers — the column's head and
     search in the sidebar's place, nothing chosen beside it — and the lists fill in under the head,
     rather than the spaces standing in the column's place until gh answers and the column replacing
     them a few frames into the page. */
  if (!status) {
    return (
      <div className="page code-review-page" aria-busy="true">
        <PageRail label="Code review"><PrColumnPending /></PageRail>
        <div className="cr-main"><NothingChosen /></div>
      </div>
    );
  }
  if (status.state !== "ready" || !profileId) {
    return <div className="page code-review-page"><Setup status={status} vantage={vantage} checking={checking} onCheck={() => void check(true)} /></div>;
  }
  return <Ready key={(status.login ?? "").toLowerCase()} login={status.login} account={status.account ?? null} profile={profile} profileId={profileId} vantage={vantage}
    onStatus={answer} onLost={() => void check(true)} onAsk={askAgain} />;
}

function Ready({ login, account, profile, profileId, vantage, onStatus, onLost, onAsk }: {
  login: string | null;
  /** The account this profile picked, which every read and the review are sent as; null is gh's own. */
  account: string | null;
  /** The profile's name, where there is another to tell it from; null where there is one. */
  profile: string | null;
  profileId: string; vantage: string;
  /** gh answered about this profile again — after another account was picked for it. */
  onStatus: (status: GhStatus) => void;
  onLost: () => void;
  /** Refresh: ask gh again who is signed in. */
  onAsk: () => void;
}) {
  const run = useApp((s) => s.run);
  const toast = useApp((s) => s.toast);
  const [selected, setSelected] = useState<PrRef | null>(pageHeld.selection);
  const [pins, setPinsHere] = useState<PrSummary[]>(pageHeld.pins[profileId] ?? []);
  const setPins = useCallback((next: PrSummary[]) => { pageHeld.pins[profileId] = next; setPinsHere(next); }, [profileId]);
  const [places, setPlaces] = useState<PrPlace[]>([]);
  const [accounts, setAccounts] = useState<string[]>(pageHeld.accounts);
  const signIn = useSignIn(vantage);

  useEffect(() => {
    let live = true;
    codeReview.pins(profileId).then((r) => { if (live) setPins(r.pins); }, () => {});
    codeReview.places(profileId).then((r) => { if (live) setPlaces(r.places); }, () => {});
    return () => { live = false; };
  }, [profileId, setPins]);

  const listAccounts = useCallback((force: boolean) => {
    codeReview.accounts(force).then((r) => { pageHeld.accounts = r.accounts; setAccounts(r.accounts); }, () => {});
  }, []);
  useEffect(() => {
    const stale = pageHeld.stale.accounts;
    pageHeld.stale.accounts = false;
    listAccounts(stale);
  }, [listAccounts]);
  const pickAccount = (next: string) => run(async () => {
    const status = await codeReview.setAccount(profileId, next).catch((e: unknown) => { listAccounts(true); throw e; });
    if (status.state === "ready") toast({ tone: "success", text: `Code review and pull requests in this profile use @${status.login ?? next}`, icon: "github" });
    onStatus(status);
  });

  const select = (ref: PrRef) => { pageHeld.selection = ref; setSelected(ref); };
  const pin = (d: PrDetail, pinned: boolean) => run(async () => {
    const row: PrSummary = { ref: d.ref, title: d.title, url: d.url, state: d.state, draft: d.draft, author: d.author, createdAt: d.createdAt, updatedAt: d.updatedAt };
    setPins((await codeReview.setPinned({ profileId, pr: row, pinned })).pins);
  });
  const isPinned = (ref: PrRef) => pins.some((p) => prKey(p.ref) === prKey(ref));

  return (
    <div className="page code-review-page">
      <PageRail label="Code review">
        <PrColumn login={login} account={account} accounts={accounts} profile={profile} pins={pins} selected={selected} onSelect={(ref) => select(ref)}
          onAccount={pickAccount} onRefresh={() => { listAccounts(true); onAsk(); }}
          onSignIn={() => signIn(GH_LOGIN_COMMAND)} onLost={onLost} />
      </PageRail>
      <div className="cr-main">
        {selected ? (
          <PrView key={prKey(selected)} pr={selected} login={login} account={account} profileId={profileId} vantage={vantage} places={places}
            pinned={isPinned(selected)} onPin={pin} />
        ) : <NothingChosen />}
      </div>
    </div>
  );
}

/** Beside the column while no request is chosen. */
function NothingChosen() {
  return (
    <div className="cr-empty">
      {/* off-ladder: the empty column's one picture, Codex's mark over the line that says what to
          do — the subject of an empty composition, as the Scheduled page's clock is. */}
      <Icon name="pullRequest" size={24} className="cr-empty-mark" />
      <h2 className="cr-empty-title">Select a pull request</h2>
      <p className="cr-empty-line">Choose one from the column to read it, review it, and ask about it.</p>
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
    signInSent();
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
