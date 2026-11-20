import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {}, BrowserWindow: class {}, dialog: {}, ipcMain: { handle: () => {} },
}));
const { PRINT_WINDOW, paperFor, printPage } = await import("./print-pdf");

type Listener = (e: { preventDefault: () => void }) => void;
type Answer = (r: { cancel: boolean }) => void;

/** A window that records what was done to it, failing where asked. */
function fakeWindow({ failLoad = false, failPrint = false } = {}) {
  const on = new Map<string, Listener>();
  let openHandler: (() => { action: string }) | null = null;
  let filter: ((d: { url: string }, answer: Answer) => void) | null = null;
  const state = { destroyed: false, loaded: null as string | null, printOptions: null as Record<string, unknown> | null };
  const win = {
    webContents: {
      on: (event: string, fn: Listener) => { on.set(event, fn); },
      setWindowOpenHandler: (fn: () => { action: string }) => { openHandler = fn; },
      session: { webRequest: { onBeforeRequest: (fn: typeof filter) => { filter = fn; } } },
      printToPDF: async (options: Record<string, unknown>) => {
        state.printOptions = options;
        if (failPrint) throw new Error("printing failed");
        return Buffer.from("%PDF-");
      },
    },
    loadFile: async (file: string) => {
      state.loaded = file;
      if (failLoad) throw new Error("ERR_FAILED");
    },
    destroy: () => { state.destroyed = true; },
  };
  const refused = (event: string) => { let stopped = false; on.get(event)?.({ preventDefault: () => { stopped = true; } }); return stopped; };
  const allows = (url: string) => { let cancel = true; filter?.({ url }, (r) => { cancel = r.cancel; }); return !cancel; };
  return { win: win as unknown as Electron.BrowserWindow, state, refused, allows, opens: () => openHandler?.() };
}

describe("the window a PDF is printed in", () => {
  /* THE mutants: any one of these switched back on. The page is the user's file. */
  it("runs no script, has no preload, is sandboxed and isolated, and is never shown", () => {
    expect(PRINT_WINDOW.show).toBe(false);
    expect(PRINT_WINDOW.webPreferences).toMatchObject({ sandbox: true, javascript: false, contextIsolation: true, nodeIntegration: false, webSecurity: true, offscreen: true });
    expect(PRINT_WINDOW.webPreferences).not.toHaveProperty("preload");
    // An in-memory session of its own: no persist: prefix, so it shares nothing with the app's.
    expect(PRINT_WINDOW.webPreferences?.partition).toBe("realm-print");
  });

  it("refuses to navigate or open a window, and loads nothing but its own page", async () => {
    const fake = fakeWindow();
    await printPage("<p>hi</p>", "Letter", () => fake.win);
    expect(fake.refused("will-navigate")).toBe(true);
    expect(fake.refused("will-redirect")).toBe(true);
    expect(fake.opens()).toEqual({ action: "deny" });
    expect(fake.allows(pathToFileURL(fake.state.loaded!).href)).toBe(true);
    expect(fake.allows("https://example.com/chart.png")).toBe(false);
    expect(fake.allows("file:///etc/passwd")).toBe(false);
    expect(fake.allows(pathToFileURL(join(tmpdir(), "elsewhere", "page.html")).href)).toBe(false);
  });

  it("prints with page numbers in the footer, the outline on, and links kept", async () => {
    const fake = fakeWindow();
    const pdf = await printPage("<p>hi</p>", "A4", () => fake.win);
    expect(pdf.toString()).toBe("%PDF-");
    expect(fake.state.printOptions).toMatchObject({ pageSize: "A4", displayHeaderFooter: true, generateDocumentOutline: true, generateTaggedPDF: true, printBackground: true });
    expect(fake.state.printOptions?.["footerTemplate"]).toContain('<span class="pageNumber"></span> of <span class="totalPages"></span>');
  });

  /* THE mutant: destroy outside the finally, so a failed export leaves a hidden window behind. */
  it.each([["a print that works", {}], ["a page that fails to load", { failLoad: true }], ["a print that fails", { failPrint: true }]])(
    "is destroyed, and its page deleted, after %s", async (_, how) => {
      const fake = fakeWindow(how);
      const done = printPage("<p>hi</p>", "Letter", () => fake.win);
      if ("failLoad" in how || "failPrint" in how) await expect(done).rejects.toThrow();
      else await done;
      expect(fake.state.destroyed).toBe(true);
      expect(existsSync(dirname(fake.state.loaded!))).toBe(false);
    });
});

describe("the paper a PDF is printed on", () => {
  it("is Letter where the Mac's region uses it, and A4 everywhere else", () => {
    expect(["US", "CA", "MX", "ph"].map(paperFor)).toEqual(["Letter", "Letter", "Letter", "Letter"]);
    expect(["GB", "DE", "FR", "JP", "IN", "AU", ""].map(paperFor)).toEqual(Array(7).fill("A4"));
  });
});
