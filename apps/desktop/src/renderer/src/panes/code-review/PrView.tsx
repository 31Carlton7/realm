import { Icon } from "@realm/ui";
import { useEffect, useMemo, useState } from "react";
import { prKey, prName, sameRepo, type PrDetail, type PrPlace, type PrRef, type PrReview } from "@realm/contracts";
import { useApp } from "../../state/store";
import { codeReview } from "./code-review-api";
import { heldDetails, pageHeld, useReviewDraft } from "./held";
import { AskPrompter } from "./AskPrompter";
import { PrChanges } from "./PrChanges";
import { PrSummary } from "./PrSummary";
import { ReviewWith, SubmitReview } from "./ReviewTools";

type Tab = "summary" | "changes";

/** Where a question or a review of this request goes by default: a checkout of its repository when
 *  the profile has one — a project's before a space's own folder — and otherwise the space the page
 *  was opened from. */
export function defaultPlace(places: readonly PrPlace[], pr: PrRef, vantage: string): PrPlace | null {
  const repo = `${pr.owner}/${pr.repo}`;
  const checkouts = places.filter((p) => p.repo && sameRepo(p.repo, repo));
  return checkouts.find((p) => p.projectId) ?? checkouts[0] ?? places.find((p) => p.spaceId === vantage && !p.projectId) ?? places[0] ?? null;
}

/**
 * One pull request: its Summary and its Changes under one toolbar, and the prompter docked at the
 * foot for asking about it. Codex's arrangement — the tabs at the left of the bar, the request's own
 * actions at the right, ending in the one decision the page exists for, Submit review.
 */
export function PrView({ pr, login, profileId, vantage, places, pinned, onPin }: {
  pr: PrRef; login: string | null; profileId: string; vantage: string; places: PrPlace[];
  pinned: boolean; onPin: (detail: PrDetail, pinned: boolean) => void;
}) {
  const key = prKey(pr);
  const toast = useApp((s) => s.toast);
  const [detail, setDetail] = useState<PrDetail | null>(() => heldDetails.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTabState] = useState<Tab>(pageHeld.tabs.get(key) ?? "summary");
  const [split, setSplit] = useState(pageHeld.view.split);
  const [tree, setTree] = useState(pageHeld.view.tree);
  const [review, setReview] = useState<PrReview | null>(null);
  const [draft, setDraft] = useReviewDraft(key);
  const [placeKey, setPlaceKey] = useState<string | null>(null);
  /** A request to bring one file's line into view — a finding's "Show in changes". */
  const [jump, setJump] = useState<{ path: string; line: number; side: "LEFT" | "RIGHT"; n: number } | null>(null);

  const setTab = (t: Tab) => { pageHeld.tabs.set(key, t); setTabState(t); };

  useEffect(() => {
    let live = true;
    codeReview.detail(pr).then(
      (d) => { if (!live) return; heldDetails.set(key, d); setDetail(d); setError(null); },
      (e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the request
  }, [key]);

  useEffect(() => {
    let live = true;
    codeReview.reviewGet(pr).then((r) => { if (live) setReview(r.review); }, () => {});
    const off = codeReview.onReview((p) => { if (p.key === key) setReview(p.review); });
    return () => { live = false; off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the request
  }, [key]);

  const placeId = (p: PrPlace) => `${p.spaceId}:${p.projectId ?? ""}`;
  const place = useMemo(() => places.find((p) => placeId(p) === placeKey) ?? defaultPlace(places, pr, vantage), [places, placeKey, pr, vantage]);

  const copyLink = () => {
    if (!detail) return;
    void navigator.clipboard.writeText(detail.url).then(() => toast({ tone: "success", text: `Copied the link to ${prName(pr)}`, icon: "link" }));
  };
  const showInChanges = (path: string, line: number, side: "LEFT" | "RIGHT") => {
    setTab("changes");
    setJump((j) => ({ path, line, side, n: (j?.n ?? 0) + 1 }));
  };

  const changes = detail ? `+${detail.additions} −${detail.deletions}` : null;
  return (
    <div className="cr-view" data-tab={tab}>
      <div className="cr-bar">
        <fieldset className="seg cr-tabs">
          <legend className="visually-hidden">Show</legend>
          <label className="seg-opt" data-selected={tab === "summary" || undefined}>
            <input type="radio" name={`cr-tab-${key}`} checked={tab === "summary"} onChange={() => setTab("summary")} />Summary
          </label>
          <label className="seg-opt" data-selected={tab === "changes" || undefined}>
            <input type="radio" name={`cr-tab-${key}`} checked={tab === "changes"} onChange={() => setTab("changes")} />Changes
            {changes && <span className="cr-tab-counts"><span className="diff-add">+{detail!.additions}</span> <span className="diff-del">−{detail!.deletions}</span></span>}
          </label>
        </fieldset>
        <span className="cr-bar-spacer" />
        {tab === "changes" && (
          <span className="cr-bar-group" role="group" aria-label="View">
            <button type="button" className="icon-btn" aria-pressed={split} title={split ? "Side by side — show one column" : "One column — show side by side"}
              aria-label="Side by side" onClick={() => { pageHeld.view.split = !split; setSplit(!split); }}><Icon name="splitRight" size={14} /></button>
            <button type="button" className="icon-btn" aria-pressed={tree} title={tree ? "Hide the file tree" : "Show the file tree"}
              aria-label="File tree" onClick={() => { pageHeld.view.tree = !tree; setTree(!tree); }}><Icon name="panelRight" size={14} /></button>
          </span>
        )}
        <span className="cr-bar-group" role="group" aria-label="This pull request">
          <button type="button" className="icon-btn" aria-pressed={pinned} aria-label="Pin" disabled={!detail}
            title={pinned ? "Unpin from the top of the column" : "Pin to the top of the column"}
            onClick={() => detail && onPin(detail, !pinned)}><Icon name={pinned ? "unpin" : "pin"} size={14} /></button>
          <button type="button" className="icon-btn" aria-label="Copy link" title="Copy the link" disabled={!detail} onClick={copyLink}>
            <Icon name="link" size={14} />
          </button>
          <a className="icon-btn" href={detail?.url ?? `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`} target="_blank" rel="noreferrer"
            aria-label="Open on GitHub" title="Open on GitHub"><Icon name="github" size={14} /></a>
        </span>
        <ReviewWith pr={pr} detail={detail} profileId={profileId} place={place} review={review} onStarted={setReview} />
        <SubmitReview pr={pr} detail={detail} login={login} draft={draft} setDraft={setDraft} />
      </div>
      {error ? (
        <div className="cr-empty"><h2 className="cr-empty-title">This pull request could not be read</h2><p className="cr-empty-line">{error}</p></div>
      ) : !detail ? (
        <div className="cr-empty"><p className="cr-empty-line">Reading {prName(pr)}…</p></div>
      ) : tab === "summary" ? (
        <PrSummary detail={detail} review={review} draft={draft} setDraft={setDraft} onShow={showInChanges} />
      ) : (
        <PrChanges detail={detail} review={review} draft={draft} setDraft={setDraft} split={split} tree={tree} jump={jump} />
      )}
      {detail && <AskPrompter pr={pr} detail={detail} place={place} places={places} onPlace={(p) => setPlaceKey(placeId(p))} />}
    </div>
  );
}
