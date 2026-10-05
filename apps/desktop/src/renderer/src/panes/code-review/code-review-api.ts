import type { EventPayload, MethodName, MethodParams, MethodResult } from "@realm/contracts";
import { rpc } from "../../rpc/client";

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
  status: (force = false) => call("codeReview.status", { force }),
  list: (section: MethodParams<"codeReview.list">["section"], cursor: string | null, force = false) => call("codeReview.list", { section, cursor, force }),
  search: (query: string, cursor: string | null) => call("codeReview.search", { query, cursor }),
  detail: (ref: MethodParams<"codeReview.detail">["ref"], force = false) => call("codeReview.detail", { ref, force }),
  files: (ref: MethodParams<"codeReview.files">["ref"], headSha: string) => call("codeReview.files", { ref, headSha }),
  patches: (ref: MethodParams<"codeReview.patches">["ref"], headSha: string, paths: string[]) => call("codeReview.patches", { ref, headSha, paths }),
  fileLines: (ref: MethodParams<"codeReview.fileLines">["ref"], headSha: string, path: string) => call("codeReview.fileLines", { ref, headSha, path }),
  submit: (review: MethodParams<"codeReview.submit">) => call("codeReview.submit", review),
  instructions: (profileId: string) => call("codeReview.instructions", { profileId }),
  setInstructions: (profileId: string, text: string) => call("codeReview.setInstructions", { profileId, text }),
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
