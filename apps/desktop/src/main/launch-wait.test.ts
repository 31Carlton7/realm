import { beforeEach, describe, expect, it, vi } from "vitest";

const made: FakeWindow[] = [];
class FakeWindow {
  url = "";
  shown = false;
  destroyed = false;
  private ready: (() => void) | null = null;
  constructor(readonly options: Record<string, unknown>) { made.push(this); }
  once(event: string, fn: () => void) { if (event === "ready-to-show") this.ready = fn; }
  loadURL(url: string) { this.url = url; this.ready?.(); return Promise.resolve(); }
  show() { this.shown = true; }
  isDestroyed() { return this.destroyed; }
  destroy() { if (this.destroyed) throw new Error("destroyed twice"); this.destroyed = true; }
}
vi.mock("electron", () => ({ BrowserWindow: FakeWindow }));

const { launchWaitText, showLaunchWait } = await import("./launch-wait");
const page = (w: FakeWindow) => decodeURIComponent(w.url.slice("data:text/html;charset=utf-8,".length));
const words = (html: string) => html.slice(html.indexOf("<body>")).replace(/<svg[\s\S]*<\/svg>/, "").replace(/<[^>]+>/g, "").trim();

describe("the launch's maintenance notice", () => {
  beforeEach(() => { made.length = 0; });

  it("says what the server is busy with", () => {
    expect(launchWaitText("vacuum")).toBe("Realm is tidying its database…");
    expect(launchWaitText("heap-snapshot")).toBe("Realm is saving a memory report…");
  });

  it("shows the line for the marker's what, under the mark, once painted", () => {
    showLaunchWait("vacuum");
    const [w] = made;
    expect(w!.shown).toBe(true);
    expect(words(page(w!))).toBe("Realm is tidying its database…");
    expect(page(w!)).toMatch(/<svg[^>]*viewBox="0 0 40 48"/);
    showLaunchWait("heap-snapshot");
    expect(words(page(made[1]!))).toBe("Realm is saving a memory report…");
  });

  it("runs no script and fetches nothing", () => {
    showLaunchWait("vacuum");
    const w = made[0]!;
    expect(w.options.webPreferences).toMatchObject({ javascript: false, sandbox: true });
    expect(page(w)).toContain("default-src 'none'");
    expect(page(w)).not.toMatch(/<script|<img|<link/);
  });

  it("takes the quiet options a live check passes, and closes once however often it is told to", () => {
    const close = showLaunchWait("vacuum", { opacity: 0.01, focusable: false });
    expect(made[0]!.options).toMatchObject({ opacity: 0.01, focusable: false });
    close();
    close();
    expect(made[0]!.destroyed).toBe(true);
  });

  it("is left alone when the person closed it first", () => {
    // The notice can be closed by hand mid-wait; the launch's close after its window opens must not
    // touch the destroyed window. MUTANT: drop the isDestroyed guard and destroy() throws here.
    const close = showLaunchWait("vacuum");
    made[0]!.destroyed = true;
    expect(close).not.toThrow();
  });
});
