import { describe, expect, it, vi } from "vitest";
import { CLEAR_BROWSING_DATA_COPY, clearBrowsingData, saveBrowserScreenshot, screenshotFileName, type ScreenshotDeps } from "./browser-controls";

const NOW = new Date("2026-10-01T19:30:05.123Z");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function deps(over: Partial<ScreenshotDeps> = {}) {
  const written = new Map<string, Uint8Array>();
  const made: string[] = [];
  const d: ScreenshotDeps = {
    capture: async () => PNG,
    pageUrl: "https://example.com/docs?q=1",
    dir: "/tmp/space/screenshots",
    now: () => NOW,
    mkdirp: (dir) => { made.push(dir); },
    exists: (p) => written.has(p),
    writeFile: async (p, bytes) => { written.set(p, bytes); },
    ...over,
  };
  return { d, written, made };
}

describe("screenshotFileName", () => {
  it("names the site and the moment, the way the simulator's screenshots are named", () => {
    expect(screenshotFileName("https://example.com/docs", NOW)).toBe("example.com-2026-10-01T19-30-05.png");
    // A port is part of which site this was, and a colon has no business in a file name.
    expect(screenshotFileName("http://127.0.0.1:8971/", NOW)).toBe("127.0.0.1-8971-2026-10-01T19-30-05.png");
  });

  it("an annotation's capture says so in its name, after the time", () => {
    expect(screenshotFileName("https://example.com/list", NOW, "-annotations")).toBe("example.com-2026-10-01T19-30-05-annotations.png");
  });

  it("a page with no host is still a file with a name", () => {
    expect(screenshotFileName("about:blank", NOW)).toBe("page-2026-10-01T19-30-05.png");
    expect(screenshotFileName("", NOW)).toBe("page-2026-10-01T19-30-05.png");
  });
});

describe("saveBrowserScreenshot", () => {
  it("writes the view's PNG into the folder it was given, and answers what an attachment needs", async () => {
    const { d, written, made } = deps();
    const r = await saveBrowserScreenshot(d);
    expect(r).toEqual({ ok: true, path: "/tmp/space/screenshots/example.com-2026-10-01T19-30-05.png", name: "example.com-2026-10-01T19-30-05.png", size: PNG.length });
    expect(made).toEqual(["/tmp/space/screenshots"]);
    expect([...written.values()]).toEqual([PNG]);
  });

  it("names the file with the suffix it is given", async () => {
    const { d } = deps({ nameSuffix: "-annotations" });
    expect(await saveBrowserScreenshot(d)).toMatchObject({ ok: true, name: "example.com-2026-10-01T19-30-05-annotations.png" });
  });

  it("two shots in the same second are two files — the first is never overwritten", async () => {
    /* THE mutant: write to the plain name every time. The first screenshot may already be attached
       to a message, and replacing it would change what that message shows. */
    const { d, written } = deps();
    await saveBrowserScreenshot(d);
    const second = await saveBrowserScreenshot(d);
    expect(second).toMatchObject({ ok: true, name: "example.com-2026-10-01T19-30-05 (2).png" });
    expect(written.size).toBe(2);
  });

  it("a capture with nothing in it says so instead of writing an empty file", async () => {
    const { d, written } = deps({ capture: async () => null });
    expect(await saveBrowserScreenshot(d)).toEqual({ ok: false, error: "The page had nothing on screen to capture." });
    expect(written.size).toBe(0);
    const failed = deps({ capture: async () => { throw new Error("view gone"); } });
    expect((await saveBrowserScreenshot(failed.d)).ok).toBe(false);
  });

  it("refuses a relative folder — it would land wherever Electron happened to start", async () => {
    const { d, written } = deps({ dir: "screenshots" });
    expect((await saveBrowserScreenshot(d)).ok).toBe(false);
    expect(written.size).toBe(0);
  });
});

describe("clearBrowsingData", () => {
  it("clears only on a yes", async () => {
    const clear = vi.fn(async () => {});
    expect(await clearBrowsingData({ confirm: async () => 0, clear })).toEqual({ cleared: true });
    expect(clear).toHaveBeenCalledOnce();
  });

  it("Cancel, Escape or a dialog that failed to show all clear nothing", async () => {
    /* THE mutant: treat anything but an explicit Cancel as a yes. Escape answers the cancel index,
       and a dialog that throws answers nothing at all — neither may sign every pane out. */
    const clear = vi.fn(async () => {});
    expect(await clearBrowsingData({ confirm: async () => 1, clear })).toEqual({ cleared: false });
    expect(await clearBrowsingData({ confirm: async () => { throw new Error("no window"); }, clear })).toEqual({ cleared: false });
    expect(clear).not.toHaveBeenCalled();
  });

  it("the confirm names its consequence — every pane is signed out — and what it keeps", () => {
    expect(CLEAR_BROWSING_DATA_COPY.message).toMatch(/every browser pane/);
    expect(CLEAR_BROWSING_DATA_COPY.detail).toMatch(/signed out/);
    expect(CLEAR_BROWSING_DATA_COPY.detail).toMatch(/Saved sign-ins and passkeys in Settings are kept/);
  });
});
