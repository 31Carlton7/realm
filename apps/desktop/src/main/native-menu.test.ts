import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const popups: { template: Record<string, unknown>[]; opts: { x: number; y: number; callback: () => void } }[] = [];
const images: { scaleFactor: number; template: boolean }[] = [];
vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn) },
  BrowserWindow: { fromWebContents: () => ({ id: 1 }) },
  nativeImage: {
    createFromBuffer: (_b: Buffer, o: { scaleFactor: number }) => {
      const img = { scaleFactor: o.scaleFactor, template: false };
      images.push(img);
      return { setTemplateImage: (t: boolean) => { img.template = t; } };
    },
  },
  Menu: {
    buildFromTemplate: (template: Record<string, unknown>[]) => ({
      template,
      popup: (opts: { x: number; y: number; callback: () => void }) => popups.push({ template, opts }),
      closePopup: vi.fn(),
    }),
  },
}));

const { menuTemplate, registerNativeMenus, PICK_GRACE_MS } = await import("./native-menu");

describe("native menus", () => {
  beforeEach(() => { handlers.clear(); popups.length = 0; images.length = 0; vi.useRealTimers(); });

  it("draws each row as the OS item that says the same thing", () => {
    const picked: number[] = [];
    const t = menuTemplate([
      { label: "Rename", enabled: true, accelerator: "Command+R" },
      { separator: true },
      { label: "Pinned", enabled: true, checked: true, toolTip: "Keep it at the top" },
      { label: "Archive", enabled: false, icon: "data:image/png;base64,AAAA" },
    ], (i) => picked.push(i));
    expect(t[0]).toMatchObject({ label: "Rename", enabled: true, accelerator: "Command+R", registerAccelerator: false });
    expect(t[0]).not.toHaveProperty("type");
    expect(t[1]).toEqual({ type: "separator" });
    expect(t[2]).toMatchObject({ type: "checkbox", checked: true, toolTip: "Keep it at the top" });
    expect(t[3]).toMatchObject({ enabled: false });
    // 2x, and a template — 16pt in the menu's own ink, not a 32pt black glyph.
    expect(images).toEqual([{ scaleFactor: 2, template: true }]);
    (t[2]!.click as () => void)();
    expect(picked).toEqual([2]);
  });

  it("answers with the pick, scales the point by the page zoom, and answers null when closed empty", async () => {
    registerNativeMenus();
    const popup = handlers.get("menu:popup")!;
    const sender = { getZoomFactor: () => 1.25 };
    const first = popup({ sender }, [{ label: "A", enabled: true }, { label: "B", enabled: true }], { x: 100, y: 40 }) as Promise<number | null>;
    expect(popups[0]!.opts).toMatchObject({ x: 125, y: 50 });
    // macOS closes the menu and then delivers the action: the pick must survive arriving second.
    popups[0]!.opts.callback();
    (popups[0]!.template[1]!.click as () => void)();
    expect(await first).toBe(1);

    vi.useFakeTimers();
    const second = popup({ sender }, [{ label: "A", enabled: true }], { x: 0, y: 0 }) as Promise<number | null>;
    popups[1]!.opts.callback();
    vi.advanceTimersByTime(PICK_GRACE_MS);
    expect(await second).toBeNull();
  });
});
