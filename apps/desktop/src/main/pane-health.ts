import type { WebContents } from "electron";
import type { PaneHealth } from "@realm/contracts";

/** The parts of a view's `WebContents` the check touches. */
export type PageProcess = Pick<WebContents, "isDestroyed" | "isCrashed" | "executeJavaScript" | "forcefullyCrashRenderer" | "reload">;

/** How long a page gets to evaluate `1`. A renderer that is alive does it in a frame; this is asked only
 *  after an op on the page has already gone a minute without an answer. */
export const PAGE_ANSWER_MS = 2_000;

/**
 * Whether a pane's page answers, and if it does not, bring it back.
 *
 * A renderer that crashed is reloaded, which starts a new one. One that is alive but does not answer
 * is hung — a script in a loop, a page wedged in its own work — and is crashed first, since a reload
 * goes through the same renderer and would wait behind it. A page that answers with an error still
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
    if (answered) return "ok";
    wc.forcefullyCrashRenderer();
  }
  try {
    wc.reload();
  } catch {
    return "gone";
  }
  return "restarted";
}
