import { useCallback, useSyncExternalStore } from "react";
import { PR_SECTIONS, type FileDiff, type GhStatus, type PrDetail, type PrFiles, type PrOwners, type PrRef, type PrSection, type PrSummary, type ReviewerPick } from "@realm/contracts";
import { EMPTY_DRAFT, sameListing, stillListed, type ReviewDraft } from "./code-review-model";

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

/** Each profile's reviewer as last read or picked, by profile — what Review with… names in its first
 *  frame. The profile's own copy is the server's (`codeReview.reviewerPick`). */
const reviewers = new Map<string, ReviewerPick>();
export const heldReviewer = (profileId: string): ReviewerPick | null => reviewers.get(profileId) ?? null;
export function useHeldReviewer(profileId: string): [ReviewerPick | null, (pick: ReviewerPick) => void] {
  const pick = useSyncExternalStore(subscribe, () => heldReviewer(profileId));
  const hold = useCallback((next: ReviewerPick) => {
    reviewers.set(profileId, next);
    for (const fn of listeners) fn();
  }, [profileId]);
  return [pick, hold];
}

/** A list as the column last drew it. */
export type Listed = { prs: PrSummary[]; next: string | null; state: "loading" | "ready" | "error"; error: string | null };

/** The page as it was put away: what gh last said, the request on screen, the pinned requests and
 *  the lists, whether the team's was open, the tab each request was left on, and how Changes was being
 *  read. gh's answer and the pins are what the page's first frame is drawn from — its column is the
 *  sidebar's, and a page that drew itself before knowing would hand the column over a few frames late,
 *  or grow a Pinned section under the rows already there. */
export const pageHeld = {
  status: null as GhStatus | null,
  /** The profile `status` is about: each profile reviews as the account it picked. */
  statusProfile: null as string | null,
  /** The login everything held below was read as, or null while nothing has been. */
  readAs: null as string | null,
  /** gh's accounts as last listed — what the column's menu offers to switch between. */
  accounts: [] as string[],
  /** What gh said before may no longer be so (`signInSent`): each is asked again, once, on the
   *  next look, instead of gh's last answer being taken for its minute. */
  stale: { status: false, accounts: false },
  /** By profile: pins are each profile's own. */
  pins: {} as Record<string, PrSummary[]>,
  /** By profile: each profile's choice of owners as this window last heard it, so its column says
   *  what is left out, and ticks its menu, in its first frame. */
  owners: {} as Record<string, PrOwners>,
  selection: null as PrRef | null,
  lists: {} as Partial<Record<PrSection, Listed>>,
  /** The choice of owners `lists` was read under, or null while that is not known. */
  listedUnder: null as PrOwners | null,
  teamOpen: false,
  tabs: new Map<string, "summary" | "changes">(),
  view: { split: true, tree: true },
};

/**
 * What gh said about a profile, held — and, when it answers as a different account from the one the
 * reads above were made as, those reads let go: a list or a request read as one account is not shown
 * as another's, and the request on screen may be one the new account cannot see. The reviews being
 * written, the pins and how the page was laid out are the person's, and stay.
 */
export function holdStatus(profileId: string | null, status: GhStatus): void {
  pageHeld.status = status;
  pageHeld.statusProfile = profileId;
  if (status.state !== "ready") return;
  const login = (status.login ?? "").toLowerCase();
  if (pageHeld.readAs !== null && pageHeld.readAs !== login) {
    for (const m of [heldDetails, heldFiles, heldPatches, heldLines]) m.clear();
    pageHeld.lists = {};
    pageHeld.selection = null;
  }
  pageHeld.readAs = login;
}

/** The page sent the person to a terminal to sign in. Who gh is signed in as, and to which accounts,
 *  are both things that step changes. */
export function signInSent(): void {
  pageHeld.stale = { status: true, accounts: true };
}

/**
 * The lists held, for a column about to be drawn under `owners`, which is its profile's choice of
 * owners, or null while this window has not heard it. Lists read under a choice that came to another
 * search are let go first, and so are any while either choice is not known. Two profiles can share
 * an account and not a choice, and one's rows are not drawn as the other's.
 */
export function listsHeldUnder(owners: PrOwners | null): Partial<Record<PrSection, Listed>> {
  if (!owners || !pageHeld.listedUnder || !sameListing(owners, pageHeld.listedUnder)) pageHeld.lists = {};
  pageHeld.listedUnder = owners;
  return pageHeld.lists;
}

/** A profile's choice of owners as just heard, held for its column's next first frame. */
export function holdOwners(profileId: string, owners: PrOwners): void {
  pageHeld.owners[profileId] = owners;
}

/**
 * The lists on screen, moved to `owners`. Their column calls this on hearing its profile's choice.
 * Where that comes to the search the lists were read under, or the choice was not known until now,
 * they stand and the answer is null. Otherwise each list keeps the rows `owners` still lists, with
 * no further page to ask for, and is marked as being read, since its column reads it again.
 */
export function listsMovedTo(owners: PrOwners): Partial<Record<PrSection, Listed>> | null {
  const was = pageHeld.listedUnder;
  pageHeld.listedUnder = owners;
  if (!was || sameListing(was, owners)) return null;
  const moved: Partial<Record<PrSection, Listed>> = {};
  for (const section of PR_SECTIONS) {
    const listed = pageHeld.lists[section];
    if (listed) moved[section] = { prs: stillListed(owners, listed.prs), next: null, state: "loading", error: null };
  }
  pageHeld.lists = moved;
  return moved;
}

/** Everything above, forgotten — what a new window starts from, and what each test does. */
export function forgetHeld(): void {
  drafts.clear();
  for (const m of [heldDetails, heldFiles, heldPatches, heldLines, reviewers]) m.clear();
  Object.assign(pageHeld, { status: null, statusProfile: null, readAs: null, accounts: [], stale: { status: false, accounts: false },
    pins: {}, owners: {}, selection: null, lists: {}, listedUnder: null, teamOpen: false, tabs: new Map(), view: { split: true, tree: true } });
  for (const fn of listeners) fn();
}
