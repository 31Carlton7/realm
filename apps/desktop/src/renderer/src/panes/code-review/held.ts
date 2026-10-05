import { useCallback, useSyncExternalStore } from "react";
import type { AgentKind, FileDiff, PrDetail, PrFiles, PrRef, PrSection, PrSummary } from "@realm/contracts";
import { EMPTY_DRAFT, type ReviewDraft } from "./code-review-model";

/**
 * What the Code Review page keeps between one look at a request and the next, for as long as the
 * window is open: the review being written (so closing the page to check something does not cost the
 * comment), and the reads already made (so coming back to a request draws it at once and reads it
 * again behind). The server holds the real cache; this is only what is already on screen.
 */

const drafts = new Map<string, ReviewDraft>();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** The review being written for one request, by `prKey`. */
export function useReviewDraft(key: string): [ReviewDraft, (next: ReviewDraft | ((d: ReviewDraft) => ReviewDraft)) => void] {
  const draft = useSyncExternalStore(subscribe, () => drafts.get(key) ?? EMPTY_DRAFT);
  const set = useCallback((next: ReviewDraft | ((d: ReviewDraft) => ReviewDraft)) => {
    const cur = drafts.get(key) ?? EMPTY_DRAFT;
    const value = typeof next === "function" ? next(cur) : next;
    if (value === EMPTY_DRAFT) drafts.delete(key); else drafts.set(key, value);
    for (const fn of listeners) fn();
  }, [key]);
  return [draft, set];
}

export const heldDetails = new Map<string, PrDetail>();
/** Files and patches by `<prKey>@<head>`: a push makes a new head, and nothing read at the old one
 *  is shown against the new. */
export const heldFiles = new Map<string, PrFiles>();
export const heldPatches = new Map<string, FileDiff>();
export const heldLines = new Map<string, string[] | null>();
export const atHead = (key: string, headSha: string) => `${key}@${headSha}`;
export const patchId = (key: string, headSha: string, path: string) => `${key}@${headSha}:${path}`;

/** The model the person last reviewed with — Review with… names it until they pick another. */
export const reviewerPick: { current: { kind: AgentKind; model: string | null } | null } = { current: null };

/** A list as the column last drew it. */
export type Listed = { prs: PrSummary[]; next: string | null; state: "loading" | "ready" | "error"; error: string | null };

/** The page as it was put away: the request on screen, the lists, whether the team's was open, the
 *  tab each request was left on, and how Changes was being read. */
export const pageHeld = {
  selection: null as PrRef | null,
  lists: {} as Partial<Record<PrSection, Listed>>,
  teamOpen: false,
  tabs: new Map<string, "summary" | "changes">(),
  view: { split: true, tree: true },
};

/** Everything above, forgotten — what a new window starts from, and what each test does. */
export function forgetHeld(): void {
  drafts.clear();
  for (const m of [heldDetails, heldFiles, heldPatches, heldLines]) m.clear();
  reviewerPick.current = null;
  Object.assign(pageHeld, { selection: null, lists: {}, teamOpen: false, tabs: new Map(), view: { split: true, tree: true } });
  for (const fn of listeners) fn();
}
