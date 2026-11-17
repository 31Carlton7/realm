import { afterEach, describe, expect, it, vi } from "vitest";
import { checkPaneHealth, PAGE_ANSWER_MS, type PageProcess } from "./pane-health";

/** A view's renderer: alive and answering, crashed, or alive and hung. */
function page(o: { crashed?: boolean; destroyed?: boolean; evaluate?: () => Promise<unknown>; reloadThrows?: boolean } = {}) {
  const did: string[] = [];
  const wc = {
    isDestroyed: () => o.destroyed ?? false,
    isCrashed: () => o.crashed ?? false,
    executeJavaScript: () => (o.evaluate ?? (() => Promise.resolve(1)))(),
    forcefullyCrashRenderer: () => { did.push("crash"); },
    stop: () => { did.push("stop"); },
    reload: () => { if (o.reloadThrows) throw new Error("reload failed"); did.push("reload"); },
  } as unknown as PageProcess;
  return { wc, did };
}

afterEach(() => { vi.useRealTimers(); });

describe("checkPaneHealth", () => {
  it("a page that answers is left alone", async () => {
    const { wc, did } = page();
    expect(await checkPaneHealth(wc)).toBe("ok");
    expect(did).toEqual([]);
  });

  it("a page that answers with an error still answered", async () => {
    // THE MUTANT: a rejected evaluate read as silence, which would mark a live page mid-navigation.
    const { wc, did } = page({ evaluate: () => Promise.reject(new Error("frame disposed")) });
    expect(await checkPaneHealth(wc)).toBe("ok");
    expect(did).toEqual([]);
  });

  it("a crashed renderer is reloaded, which starts a new one", async () => {
    const { wc, did } = page({ crashed: true });
    expect(await checkPaneHealth(wc)).toBe("restarted");
    expect(did).toEqual(["reload"]);
  });

  it("a live page that does not answer is left as it is, and the check gives up on it in seconds", async () => {
    // THE MUTANT: crash and reload it, as this check once did. A page busy for a few seconds, or behind
    // a dialog, would lose a half-filled form or a sign-in in progress.
    vi.useFakeTimers();
    const { wc, did } = page({ evaluate: () => new Promise(() => {}) });
    const health = checkPaneHealth(wc);
    await vi.advanceTimersByTimeAsync(PAGE_ANSWER_MS);
    expect(await health).toBe("unresponsive");
    expect(did).toEqual([]);
  });

  it("no view, or one that will not reload, is gone", async () => {
    expect(await checkPaneHealth(undefined)).toBe("gone");
    expect(await checkPaneHealth(page({ destroyed: true }).wc)).toBe("gone");
    expect(await checkPaneHealth(page({ crashed: true, reloadThrows: true }).wc)).toBe("gone");
  });
});
