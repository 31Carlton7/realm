import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, type BrowserWindowConstructorOptions } from "electron";
import { documentStem, printsAsPdf } from "@realm/contracts";
import { existingPath, statFile } from "./attachments";
import { readTextFile } from "./read-text";

/**
 * Download as PDF: a text file the documents pane opens, typeset by print-document.ts and printed by
 * Chromium into a file the user picks.
 *
 * The page is made from whatever is in the file, so the window that prints it is shut tight: no
 * script, no preload, sandboxed, its own in-memory session that can load the one page and nothing
 * else, no navigation and no new windows. The page's CSP says the same again. The window lives for
 * one export and is destroyed after it, whether the print worked or not.
 */

/** Hidden and offscreen: nothing is ever drawn to the screen. */
export const PRINT_WINDOW: BrowserWindowConstructorOptions = {
  show: false,
  width: 816,
  height: 1056,
  webPreferences: {
    sandbox: true,
    javascript: false,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
    offscreen: true,
    partition: "realm-print",
  },
};

/** The regions whose paper is US Letter, as CLDR lists them; the rest of the world prints on A4. */
const LETTER_REGIONS = new Set(["BZ", "CA", "CL", "CO", "CR", "GT", "MX", "NI", "PA", "PH", "PR", "SV", "US", "VE"]);

/** The paper for the Mac's region (System Settings ▸ General ▸ Language & Region), which is what
 *  `app.getLocaleCountryCode()` reads. */
export const paperFor = (region: string): "Letter" | "A4" => (LETTER_REGIONS.has(region.toUpperCase()) ? "Letter" : "A4");

/** The folder each export's page is written to. A page carrying its fonts is megabytes, past what
 *  Chromium takes as a data: URL, so it is loaded as a file. */
const PAGE_DIR_PREFIX = join(tmpdir(), "realm-pdf-");

/** The footer, set by Chromium in the bottom margin: the title, and where this page is in the whole.
 *  The template is its own document, which sees system fonts only. */
const FOOTER = `<div style="width:100%;margin:0 0.85in;display:flex;justify-content:space-between;gap:24px;font:8pt -apple-system,system-ui,sans-serif;color:#6b6e75;">
<span class="title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
<span style="white-space:nowrap;font-variant-numeric:tabular-nums;"><span class="pageNumber"></span> of <span class="totalPages"></span></span>
</div>`;

/** The page's markup as a PDF. `createWindow` is for tests; the export always uses `PRINT_WINDOW`. */
export async function printPage(html: string, pageSize: "Letter" | "A4", createWindow = () => new BrowserWindow(PRINT_WINDOW)): Promise<Buffer> {
  const dir = await mkdtemp(PAGE_DIR_PREFIX);
  const page = join(dir, "page.html");
  const win = createWindow();
  try {
    const { webContents } = win;
    webContents.on("will-navigate", (e) => e.preventDefault());
    webContents.on("will-redirect", (e) => e.preventDefault());
    webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // An export's own page is the one request this session answers. A picture, a font or a stylesheet
    // from anywhere else is refused here as well as by the page's CSP.
    webContents.session.webRequest.onBeforeRequest((details, answer) => {
      const isPage = details.url.startsWith("file:") && fileURLToPath(details.url).startsWith(PAGE_DIR_PREFIX);
      answer({ cancel: !isPage && !details.url.startsWith("data:") });
    });
    await writeFile(page, html);
    // Resolves on the page's load event, which waits for its pictures and the faces the text is set in.
    await win.loadFile(page);
    return await webContents.printToPDF({
      pageSize,
      printBackground: true,
      margins: { top: 0.8, bottom: 0.8, left: 0.85, right: 0.85 },
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: FOOTER,
      generateTaggedPDF: true,
      generateDocumentOutline: true,
    });
  } finally {
    win.destroy();
    await rm(dir, { recursive: true, force: true });
  }
}

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** A picture the document names on disk, read as the pane's links are: `~/…`, relative to the
 *  document's folder, or a `file://` URL. Null for anything that is not a picture there. */
export async function readImageBeside(docPath: string, href: string): Promise<string | null> {
  let named = href.trim();
  try { named = decodeURI(named); } catch { /* the href as written */ }
  const found = await existingPath(named, dirname(docPath));
  const type = found ? IMAGE_TYPES[extname(found).toLowerCase()] : undefined;
  const file = type ? await statFile(found) : null;
  if (!file) return null;
  return `data:${type};base64,${(await readFile(file.path)).toString("base64")}`;
}

/** Renderer → main: make a PDF of the file at `path` and save it where the user says. Answers the
 *  saved path, or null when nothing was saved. A failure is said in a sheet on the window. */
export function registerPdfExport(): void {
  ipcMain.handle("files:save-pdf", async (e, path: unknown): Promise<string | null> => {
    if (typeof path !== "string" || !printsAsPdf(path)) return null;
    const win = BrowserWindow.fromWebContents(e.sender);
    const name = basename(path);
    const fail = async (detail: string): Promise<null> => {
      const box = { type: "warning" as const, message: `Realm could not make a PDF of ${name}.`, detail };
      await (win ? dialog.showMessageBox(win, box) : dialog.showMessageBox(box));
      return null;
    };
    const read = await readTextFile(path);
    if (!read) return fail("It is no longer on disk.");
    if (!read.ok) return fail(read.reason === "large" ? "It is larger than the 2 MB the documents pane opens." : "It is not text.");
    const ask = { defaultPath: join(app.getPath("downloads"), `${documentStem(name)}.pdf`), filters: [{ name: "PDF", extensions: ["pdf"] }] };
    const where = await (win ? dialog.showSaveDialog(win, ask) : dialog.showSaveDialog(ask));
    if (where.canceled || !where.filePath) return null;
    try {
      const { buildPrintDocument } = await import("./print-document");
      const doc = await buildPrintDocument({ path, text: read.text, readImage: (href) => readImageBeside(path, href) });
      await writeFile(where.filePath, await printPage(doc.html, paperFor(app.getLocaleCountryCode())));
      return where.filePath;
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
}
