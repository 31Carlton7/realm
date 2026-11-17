import type { WebContents } from "electron";
import type { PaneHealth } from "@realm/contracts";

/** The parts of a view's `WebContents` the check touches. */
export type PageProcess = Pick<WebContents, "isDestroyed" | "isCrashed" | "executeJavaScript" | "reload">;

/** How long a page gets to evaluate `1`. A renderer that is alive does it in a frame; this is asked only
 *  after an op on the page has already gone a minute without an answer. */
export const PAGE_ANSWER_MS = 2_000;

/**
 * Whether a pane's page answers.
 *
 * A renderer that crashed is reloaded, which starts a new one: there is nothing left on the page to
 * lose. One that is alive but does not answer is left alone. A page can miss the check while healthy —
 * mid-navigation on a slow site, behind a JavaScript dialog, busy for a few seconds — and a reload
 * would throw away a half-filled form or a sign-in in progress. A page that answers with an error still
 * answered: its process is there.
 */
export async function checkPaneHealth(wc: PageProcess | undefined, answerMs = PAGE_ANSWER_MS): Promise<PaneHealth> {
  if (!wc || wc.isDestroyed()) return "gone";
  if (!wc.isCrashed()) {
    let timer: NodeJS.Timeout | undefined;
    const answered = await Promise.race([
      wc.executeJavaScript("1").then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), answerMs); }),
    ]);
    clearTimeout(timer);
    return answered ? "ok" : "unresponsive";
  }
  try {
    wc.reload();
  } catch {
    return "gone";
  }
  return "restarted";
}
