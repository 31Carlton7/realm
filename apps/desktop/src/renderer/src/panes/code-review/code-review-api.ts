import { prAccountKey, type EventPayload, type MethodName, type MethodParams, type MethodResult } from "@realm/contracts";
import { rpc } from "../../rpc/client";
import { sentAs } from "./code-review-model";

/**
 * The Code Review page's calls, typed — a page of its own over its own RPCs, the way the documents
 * pane and MCP views reach theirs, so the app store does not carry a page's worth of state it never
 * reads. Every read here is cached on the server (code-review/service.ts); this side keeps only what
 * is on screen.
 */
type CodeReviewMethod = Extract<MethodName, `codeReview.${string}`>;
/** Async, so a socket that cannot be had (no preload) is a refusal the page shows, not a throw in a
 *  render's effect. */
const call = async <M extends CodeReviewMethod>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => rpc().call(method, params);

export const codeReview = {
  status: (profileId: string | null, force = false) => call("codeReview.status", { force, profileId }),
  accounts: (force = false) => call("codeReview.accounts", { force }),
  /** Null takes the profile's pick back, which leaves it on the account gh has active. */
  setAccount: (profileId: string, login: string | null) => call("codeReview.setAccount", { profileId, login }),
  /** The account `profileId` picked, as it is stored — kept while gh is signed out of it, which is
   *  when `status` stops naming it and Settings still has to. Null for a profile that picked none. */
  pickedAccount: async (profileId: string): Promise<string | null> => {
    const { value } = await rpc().call("settings.get", { key: prAccountKey(profileId) });
    return typeof value === "string" && value !== "" ? value : null;
  },
  list: (section: MethodParams<"codeReview.list">["section"], cursor: string | null, force = false, account: string | null = null) =>
    call("codeReview.list", { section, cursor, force, ...sentAs(account) }),
  search: (query: string, cursor: string | null, account: string | null = null) => call("codeReview.search", { query, cursor, ...sentAs(account) }),
  detail: (ref: MethodParams<"codeReview.detail">["ref"], force = false, account: string | null = null) => call("codeReview.detail", { ref, force, ...sentAs(account) }),
  files: (ref: MethodParams<"codeReview.files">["ref"], headSha: string, account: string | null = null) => call("codeReview.files", { ref, headSha, ...sentAs(account) }),
  patches: (ref: MethodParams<"codeReview.patches">["ref"], headSha: string, paths: string[], account: string | null = null) =>
    call("codeReview.patches", { ref, headSha, paths, ...sentAs(account) }),
  fileLines: (ref: MethodParams<"codeReview.fileLines">["ref"], headSha: string, path: string, account: string | null = null) =>
    call("codeReview.fileLines", { ref, headSha, path, ...sentAs(account) }),
  submit: (review: MethodParams<"codeReview.submit">) => call("codeReview.submit", review),
  instructions: (profileId: string) => call("codeReview.instructions", { profileId }),
  setInstructions: (profileId: string, text: string) => call("codeReview.setInstructions", { profileId, text }),
  reviewerPick: (profileId: string) => call("codeReview.reviewerPick", { profileId }),
  setReviewerPick: (profileId: string, pick: MethodParams<"codeReview.setReviewerPick">["pick"]) => call("codeReview.setReviewerPick", { profileId, pick }),
  pins: (profileId: string) => call("codeReview.pins", { profileId }),
  setPinned: (params: MethodParams<"codeReview.setPinned">) => call("codeReview.setPinned", params),
  review: (params: MethodParams<"codeReview.review">) => call("codeReview.review", params),
  reviewGet: (ref: MethodParams<"codeReview.reviewGet">["ref"]) => call("codeReview.reviewGet", { ref }),
  places: (profileId: string) => call("codeReview.places", { profileId }),
  thread: (ref: MethodParams<"codeReview.thread">["ref"]) => call("codeReview.thread", { ref }),
  ask: (params: MethodParams<"codeReview.ask">) => call("codeReview.ask", params),
  /** A request's reviewer run moved. */
  onReview: (fn: (p: EventPayload<"codeReview.reviewChanged">) => void): (() => void) => {
    try { return rpc().on("codeReview.reviewChanged", fn); } catch { return () => {}; }
  },
  /** A profile's account was picked or taken back, from this window or another. */
  onAccount: (fn: (p: EventPayload<"codeReview.accountChanged">) => void): (() => void) => {
    try { return rpc().on("codeReview.accountChanged", fn); } catch { return () => {}; }
  },
};

/**
 * A terminal in `spaceId` with `command` typed into it and NOT run — the person presses Return.
 * Set up GitHub's whole job: Realm never runs a sign-in, it offers one.
 */
export async function terminalWith(spaceId: string, command: string): Promise<{ terminalId: string; itemId: string }> {
  const made = await rpc().call("terminals.create", { spaceId });
  // Prefill waits for the shell to go quiet, so it can be asked before the pane is even on screen.
  void rpc().call("terminals.prefill", { terminalId: made.terminalId, command }).catch(() => {});
  return made;
}
