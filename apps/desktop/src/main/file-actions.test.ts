import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const listeners = new Map<string, (...args: unknown[]) => unknown>();
const previewFile = vi.fn();
const sharePopups: { filePaths: string[]; opts: unknown }[] = [];
const getFileIcon = vi.fn(async () => ({ isEmpty: () => false, id: "icon" }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    on: (ch: string, fn: (...a: unknown[]) => unknown) => listeners.set(ch, fn),
  },
  BrowserWindow: { fromWebContents: () => ({ previewFile }) },
  ShareMenu: class { constructor(private item: { filePaths: string[] }) {} popup(opts: unknown) { sharePopups.push({ filePaths: this.item.filePaths, opts }); } },
  app: { getFileIcon },
}));
const { registerFileActions } = await import("./file-actions");

/** The gate: only one real file exists. Anything else from the renderer is refused. */
const gate = async (p: unknown) => (p === "/work/report.pdf" || p === "/work/notes.md" ? p as string : null);
const opened: [string, string][] = [];
const openWith = (app: string, file: string) => { opened.push([app, file]); };
const sender = () => ({ getZoomFactor: () => 1.5, isDestroyed: () => false, startDrag: vi.fn() });

describe("a listed file, the way the Finder treats one", () => {
  beforeEach(() => { handlers.clear(); listeners.clear(); previewFile.mockClear(); sharePopups.length = 0; getFileIcon.mockClear(); opened.length = 0; registerFileActions({ gate, openWith }); });

  it("opens macOS's Quick Look panel on the gated path, and nothing for a path the gate refuses", async () => {
    await handlers.get("files:quick-look")!({ sender: sender() }, "/work/report.pdf");
    expect(previewFile).toHaveBeenCalledWith("/work/report.pdf", "report.pdf");
    await handlers.get("files:quick-look")!({ sender: sender() }, "/etc/passwd");
    expect(previewFile).toHaveBeenCalledTimes(1);
  });

  it("puts the system Share menu under the control that asked, in window coordinates", async () => {
    await handlers.get("files:share")!({ sender: sender() }, "/work/report.pdf", { x: 100, y: 20 });
    expect(sharePopups).toEqual([{ filePaths: ["/work/report.pdf"], opts: expect.objectContaining({ x: 150, y: 30 }) }]);
    await handlers.get("files:share")!({ sender: sender() }, "/nope", { x: 1, y: 1 });
    expect(sharePopups).toHaveLength(1);
  });

  /* THE mutant: looking the icon up on every drag. The drag has to start while the mouse is down, so
     the second drag of a type must not wait on the lookup at all. */
  it("starts an OS drag carrying the file, with its Finder icon looked up once per type", async () => {
    const s = sender();
    await listeners.get("files:drag-start")!({ sender: s }, "/work/report.pdf");
    expect(s.startDrag).toHaveBeenCalledWith({ file: "/work/report.pdf", icon: expect.objectContaining({ id: "icon" }) });
    await listeners.get("files:drag-start")!({ sender: s }, "/work/report.pdf");
    expect(getFileIcon).toHaveBeenCalledTimes(1);
    await listeners.get("files:drag-start")!({ sender: s }, "/work/notes.md");
    expect(getFileIcon).toHaveBeenCalledTimes(2);
    await listeners.get("files:drag-start")!({ sender: s }, "/secret");
    expect(s.startDrag).toHaveBeenCalledTimes(3);
  });

  /* THE mutant: dropping the extension check. The gate admits any file that exists, and handing a
     renderer-chosen file to an app by name is only safe while that file is one Preview shows. */
  it("hands a gated PDF to Preview by name, and nothing else", async () => {
    await handlers.get("files:open-in-preview")!({ sender: sender() }, "/work/report.pdf");
    expect(opened).toEqual([["Preview", "/work/report.pdf"]]);
    await handlers.get("files:open-in-preview")!({ sender: sender() }, "/work/notes.md");
    await handlers.get("files:open-in-preview")!({ sender: sender() }, "/etc/passwd");
    expect(opened).toHaveLength(1);
  });
});
