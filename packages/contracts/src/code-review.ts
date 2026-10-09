import { z } from "zod";
import { AgentKindSchema } from "./entities";
import { IdSchema } from "./ids";

/**
 * Code review (Realm v2): pull requests on GitHub, read and reviewed through the `gh` CLI the person
 * has already signed in with.
 *
 * Realm holds no GitHub token of its own. Every read and the one write — a review, on the owner's
 * click of Submit — go through `gh`, so what Realm can see is exactly what `gh` can see, the account
 * is one `gh auth status` names, and signing out of `gh` is signing Realm out too.
 *
 * Which of gh's accounts is a profile's own choice (`prAccountKey`): the one gh has active until
 * another is picked. A picked account's calls are started through a shell that asks gh for that
 * account's token and hands it to the `gh` it starts, so the token goes from gh to gh without Realm
 * ever reading it, and gh's own active account — the one a terminal uses — is left as it was. The
 * pull request Ship opens from one of the profile's checkouts goes out the same way, as that account.
 *
 * Nothing here may be reached by an agent: the reviewer a person runs from the page writes findings
 * for that person to keep or discard, and only Submit posts. The service never takes a review from
 * an agent's tool call, and no tool posts one.
 */

/** GitHub's own name rules, enforced at the wire: these land in `gh api repos/<owner>/<repo>/…`
 *  paths and in `--repo`, and a name that could carry a `/`, a `..` or a space is a path a pasted
 *  link could steer. A login is letters, digits and single hyphens; a repository adds `.` and `_`. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** A pull request by its address. */
export const PrRefSchema = z.object({
  owner: z.string().regex(OWNER, "not a GitHub owner"),
  repo: z.string().regex(REPO, "not a GitHub repository name").refine((r) => r !== "." && r !== "..", "not a GitHub repository name"),
  number: z.number().int().positive(),
});
export type PrRef = z.infer<typeof PrRefSchema>;

/** One string per pull request, for caches and stored keys. GitHub's names are case-insensitive, so
 *  the key is lowered while the ref keeps the case it was written in. */
export const prKey = (r: PrRef): string => `${r.owner}/${r.repo}#${r.number}`.toLowerCase();
/** How a pull request is named to a person: `acme/widgets#42`. */
export const prName = (r: PrRef): string => `${r.owner}/${r.repo}#${r.number}`;
export const prUrl = (r: PrRef): string => `https://github.com/${r.owner}/${r.repo}/pull/${r.number}`;
export const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * A pull request named in pasted text, or null.
 *
 * The three shapes a person has in hand: the page's URL (with whatever tab or anchor they copied it
 * on — `/files`, `#discussion_r…`), the same without its scheme, and the `owner/repo#42` GitHub
 * writes in its own prose. Anything else is a search, not an address.
 */
export function parsePrRef(text: string): PrRef | null {
  const t = text.trim();
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]\S*)?$/i.exec(t);
  const short = url ? null : /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(t);
  const m = url ?? short;
  if (!m) return null;
  const parsed = PrRefSchema.safeParse({ owner: m[1], repo: m[2]!, number: Number(m[3]) });
  return parsed.success ? parsed.data : null;
}

/* ────────────────────────────── gh ────────────────────────────── */

/**
 * What the page can do, from `gh`'s own answer.
 *
 * - `missing`: no `gh` on this Mac. The page says what it is and where it comes from.
 * - `signed-out`: `gh` answered "authentication required". Set up GitHub opens a terminal with
 *   `gh auth login` typed in for the person to run — Realm never runs a sign-in itself.
 * - `ready`: signed in as `login`.
 * - `unreachable`: signed in, as far as anyone can tell, but GitHub did not answer (offline, a
 *   proxy). Not `signed-out`: telling someone to sign in again over a dropped network is a lie that
 *   sends them to fix the wrong thing.
 */
export const GhStateSchema = z.enum(["missing", "signed-out", "ready", "unreachable"]);
export type GhState = z.infer<typeof GhStateSchema>;
/** A GitHub login as gh prints it. Checked at the wire because it reaches `gh auth token --user`. */
export const GhLoginSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/, "not a GitHub login");

export const GhStatusSchema = z.object({
  state: GhStateSchema, login: z.string().nullable(), reason: z.string().nullable(),
  /** The account the profile picked, while gh is still signed in to it — what every read and the
   *  write for that profile are sent as. Absent or null is gh's own active account. */
  account: z.string().nullable().optional(),
});
export type GhStatus = z.infer<typeof GhStatusSchema>;

/**
 * The accounts gh is signed in to on github.com, by login, and the one of them gh has `active` — the
 * account a profile that picked none runs as, so a control that offers the pick can say whose that is.
 * `active` is null wherever `accounts` is empty, and where the account gh has active is one nothing
 * can be sent as.
 */
export const GhAccountsSchema = z.object({ accounts: z.array(z.string()), active: z.string().nullable() });
export type GhAccounts = z.infer<typeof GhAccountsSchema>;

/**
 * The account a profile's Code review runs as, and its shipped pull requests are opened as, once the
 * person has picked one: a login, kept per PROFILE for the reason the instructions are — work and
 * school are different people on GitHub. A login and nothing else: the token stays gh's. It holds
 * only while gh is signed in to that account; signed out of it, the profile is back on gh's active
 * account, and the pick returns when the account does. Taken back, it is stored as null.
 */
export const prAccountKey = (profileId: string): string => `codeReview.account:${profileId}`;

/** The command Set up GitHub types into a terminal. Offered, never run: the person presses Return. */
export const GH_LOGIN_COMMAND = "gh auth login";

/* ─────────────────────────── the lists ─────────────────────────── */

/** The page's three lists, Codex's: what I opened, what waits on me, and what waits on a team I am
 *  in. "Needs my review" is a request made of ME; one made of a team I belong to is the third list,
 *  so a pull request is never in both. */
export const PR_SECTIONS = ["authored", "review", "team"] as const;
export const PrSectionSchema = z.enum(PR_SECTIONS);
export type PrSection = z.infer<typeof PrSectionSchema>;

export const PrStateSchema = z.enum(["open", "closed", "merged"]);
export type PrState = z.infer<typeof PrStateSchema>;

/** One row of a list: enough to choose by without opening it. */
export const PrSummarySchema = z.object({
  ref: PrRefSchema,
  title: z.string(),
  url: z.string(),
  state: PrStateSchema,
  draft: z.boolean(),
  /** Null for an account GitHub has since deleted (its "ghost"). */
  author: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type PrSummary = z.infer<typeof PrSummarySchema>;

/** A page of a list. `nextCursor` is GitHub's own, opaque here; null at the end. */
export const PrPageSchema = z.object({ prs: z.array(PrSummarySchema), nextCursor: z.string().nullable(), total: z.number().int() });
export type PrPage = z.infer<typeof PrPageSchema>;
/** Rows per page — Codex shows a handful before "Show more". */
export const PR_PAGE_SIZE = 10;

/* ─────────────────────────── one request ─────────────────────────── */

export const ReviewerStateSchema = z.enum(["approved", "changes_requested", "commented", "dismissed", "pending"]);
export type ReviewerState = z.infer<typeof ReviewerStateSchema>;
export const CheckStateSchema = z.enum(["success", "failure", "pending", "skipped", "neutral"]);
export type CheckState = z.infer<typeof CheckStateSchema>;

export const PrDetailSchema = PrSummarySchema.extend({
  body: z.string(),
  base: z.string(),
  head: z.string(),
  /** The fork the head branch lives in, when it is not the base repository's owner. */
  headOwner: z.string().nullable(),
  headSha: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changedFiles: z.number().int(),
  /** GitHub's `mergeable`, which is computed in the background: `unknown` is "not worked out yet". */
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
  /** GitHub's `mergeStateStatus`, lowered: clean, dirty, blocked, behind, unstable, has_hooks, draft
   *  or unknown — the reason a mergeable request still may not merge. */
  mergeState: z.string(),
  decision: z.enum(["approved", "changes_requested", "review_required"]).nullable(),
  /** Everyone who reviewed (their latest verdict) and everyone still asked to (pending). */
  reviewers: z.array(z.object({ name: z.string(), team: z.boolean(), state: ReviewerStateSchema })),
  comments: z.object({
    total: z.number().int(),
    /** The newest few, oldest first — the conversation's end, which is what a reader comes for. */
    recent: z.array(z.object({ author: z.string().nullable(), body: z.string(), createdAt: z.number().int(), url: z.string().nullable() })),
  }),
  checks: z.array(z.object({ name: z.string(), state: CheckStateSchema, url: z.string().nullable() })),
});
export type PrDetail = z.infer<typeof PrDetailSchema>;

/** GitHub's file statuses, in Realm's words where the diff pane already has one (`removed` is a
 *  deletion) — `changed` is a mode or type change with no edit to the text. */
export const PrFileStatusSchema = z.enum(["added", "modified", "deleted", "renamed", "copied", "changed"]);
export type PrFileStatus = z.infer<typeof PrFileStatusSchema>;

export const PrFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: PrFileStatusSchema,
  additions: z.number().int(),
  deletions: z.number().int(),
  /**
   * What `codeReview.patches` will have for this file. `none` is a file with no lines to show — a
   * binary, a rename that changed nothing, a mode flip. `too-large` is GitHub declining to send a
   * patch it judged too big, which is a different thing to tell a reader: the change is there, on
   * GitHub, just not here.
   */
  patch: z.enum(["text", "none", "too-large"]),
});
export type PrFile = z.infer<typeof PrFileSchema>;

/** GitHub's own ceiling: the files endpoint lists at most 3000 per pull request. */
export const PR_FILES_MAX = 3000;
export const PrFilesSchema = z.object({
  /** The head the list was read at. Patches are asked for at this head and no other, so a push that
   *  lands while the page is open cannot mix two versions of the change on one screen. */
  headSha: z.string(),
  files: z.array(PrFileSchema),
  total: z.number().int(),
  truncated: z.boolean(),
});
export type PrFiles = z.infer<typeof PrFilesSchema>;
/** Patches asked for in one call — what one screen of a long change shows, with room. */
export const PR_PATCHES_PER_CALL = 40;

/* ─────────────────────────── a review ─────────────────────────── */

/** GitHub's review events, as its API spells them — they go onto the wire verbatim. */
export const ReviewEventSchema = z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]);
export type ReviewEvent = z.infer<typeof ReviewEventSchema>;
/** Which side of a split diff a comment hangs off: LEFT is the base (a deleted line), RIGHT the head. */
export const ReviewSideSchema = z.enum(["LEFT", "RIGHT"]);
export type ReviewSide = z.infer<typeof ReviewSideSchema>;

export const REVIEW_BODY_MAX = 65_536;
export const REVIEW_COMMENTS_MAX = 100;
const SHA = z.string().regex(/^[0-9a-f]{7,64}$/i, "not a commit id");

/** One line comment in a review, on a line the diff shows. */
export const ReviewCommentSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  side: ReviewSideSchema,
  body: z.string().max(REVIEW_BODY_MAX).refine((b) => b.trim() !== "", "a comment needs words"),
});
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;

/**
 * `codeReview.submit`: post a review, exactly as composed. The comment is required for every event,
 * Approve included — the page asks for it, and a review is a thing other people read.
 *
 * `headSha` pins the review to the head the person was looking at. GitHub anchors line comments to
 * that commit, so a push that lands mid-review leaves them on the code that was read rather than
 * moving them onto lines nobody looked at.
 */
export const SubmitReviewSchema = z.object({
  ref: PrRefSchema,
  headSha: SHA,
  event: ReviewEventSchema,
  body: z.string().max(REVIEW_BODY_MAX).refine((b) => b.trim() !== "", "a review needs a comment"),
  comments: z.array(ReviewCommentSchema).max(REVIEW_COMMENTS_MAX).default([]),
  /** The account the page said the review posts as (`GhStatus.account`): null is gh's own. Sent with
   *  the review so the one write goes out as the account the person was shown, whatever another
   *  window has picked since. */
  account: GhLoginSchema.nullable().default(null),
});
export type SubmitReview = z.infer<typeof SubmitReviewSchema>;
export const SubmittedReviewSchema = z.object({ id: z.number().int().nullable(), url: z.string().nullable() });
export type SubmittedReview = z.infer<typeof SubmittedReviewSchema>;

/* ─────────────────────── how to review ─────────────────────── */

/** The person's standing instructions to the reviewer, one set per PROFILE: work and school review
 *  for different things. A named limit, refused rather than trimmed. */
export const REVIEW_INSTRUCTIONS_MAX = 8000;
export const ReviewInstructionsSchema = z.object({ text: z.string() });
export type ReviewInstructions = z.infer<typeof ReviewInstructionsSchema>;
export const reviewInstructionsKey = (profileId: string): string => `codeReview.instructions:${profileId}`;

/**
 * The reviewer a profile reviews with, beside its instructions: the agent and model Review with…
 * names, and the level and fast mode the picker's card sets for it. Kept as each is chosen — there is
 * no Save for a pick — and handed to every review the profile starts.
 */
export const ReviewerPickSchema = z.object({
  agentKind: AgentKindSchema,
  model: z.string().nullable(),
  /** Null is the model's own default, as on a session. A level the model now on does not take is
   *  kept, as a session's row keeps it, and comes back with a model that does. */
  effort: z.string().nullable().default(null),
  fastMode: z.boolean().default(false),
});
export type ReviewerPick = z.infer<typeof ReviewerPickSchema>;
export const reviewerPickKey = (profileId: string): string => `codeReview.reviewerPick:${profileId}`;

/** What "Add example" offers, one a press: the kinds of thing people tell a reviewer. */
export const REVIEW_INSTRUCTION_EXAMPLES: readonly string[] = [
  "I care most about the data model. Tell me where we might be overcomplicating things.",
  "Flag anything that changes behaviour without a test that would catch it.",
  "Point out error paths that swallow a failure instead of reporting it.",
  "Skip style nits; only comment on what could break in production.",
];

/** The pull requests a person keeps at the top of the column, per profile, newest pin first. */
export const prPinsKey = (profileId: string): string => `codeReview.pins:${profileId}`;
export const PR_PINS_MAX = 20;

/* ───────────────────── a review an agent ran ───────────────────── */

/**
 * One finding from a reviewer the person ran with "Review with…": a comment on a line, theirs to add
 * to the review or discard. `anchored` is whether the line is one the diff shows — GitHub accepts a
 * line comment nowhere else, so an unanchored finding is offered as part of the review's text.
 */
export const FindingSchema = z.object({
  id: z.string(),
  path: z.string(),
  line: z.number().int().positive(),
  side: ReviewSideSchema,
  body: z.string(),
  anchored: z.boolean(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const PrReviewStateSchema = z.enum(["running", "done", "stopped", "interrupted", "timeout", "failed", "gone"]);
export type PrReviewState = z.infer<typeof PrReviewStateSchema>;

/** A reviewer's run over one pull request, as the page shows it. Kept per pull request (the latest
 *  only — its session holds the whole trace) until the next run replaces it. */
export const PrReviewSchema = z.object({
  ref: PrRefSchema,
  headSha: z.string(),
  sessionId: IdSchema,
  spaceId: IdSchema,
  agentKind: AgentKindSchema,
  model: z.string().nullable(),
  /** The level the reviewer was started at; null for the model's own default — and for every review
   *  kept before levels were recorded. */
  effort: z.string().nullable().default(null),
  state: PrReviewStateSchema,
  /** The reviewer's account of the change, for the person (and, if they keep it, for the author). */
  summary: z.string(),
  findings: z.array(FindingSchema),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
});
export type PrReview = z.infer<typeof PrReviewSchema>;
export const prReviewKey = (ref: PrRef): string => `codeReview.review:${prKey(ref)}`;

/* ───────────────────── asking about one ───────────────────── */

/** Somewhere a question about a pull request can be asked: a space, or one of its projects. `repo`
 *  is the GitHub repository its checkout pushes to (`owner/name`), when it has one — the place whose
 *  repo matches the request's has the code checked out. */
export const PrPlaceSchema = z.object({
  spaceId: IdSchema,
  projectId: IdSchema.nullable(),
  name: z.string(),
  path: z.string(),
  repo: z.string().nullable(),
  branch: z.string().nullable(),
});
export type PrPlace = z.infer<typeof PrPlaceSchema>;
/** The session a pull request's questions go to, once one has been asked. */
export const prThreadKey = (ref: PrRef): string => `codeReview.thread:${prKey(ref)}`;
