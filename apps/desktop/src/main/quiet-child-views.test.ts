import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const app = new EventEmitter();

class FakeView {
  children: FakeView[] = [];
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  visible = true;
  addChildView(v: FakeView) { this.children.push(v); }
  removeChildView(v: FakeView) { this.children.splice(this.children.indexOf(v), 1); }
  setBounds(b: { x: number; y: number; width: number; height: number }) { this.bounds = b; }
  setVisible(v: boolean) { this.visible = v; }
  getBounds() { return this.bounds; }
  getVisible() { return this.visible; }
}

const fakeContents = (targetId: string) => Object.assign(new EventEmitter(), {
  isDestroyed: () => false,
  debugger: { isAttached: () => false, attach: vi.fn(), sendCommand: vi.fn(async () => ({ targetInfo: { targetId } })) },
});

class FakeContentsView extends FakeView {
  webContents: ReturnType<typeof fakeContents>;
  constructor(targetId: string) { super(); this.webContents = fakeContents(targetId); }
}

class FakeWindow {
  static all: FakeWindow[] = [];
  static getAllWindows() { return FakeWindow.all; }
  contentView = new FakeView();
  zoom = 1;
  scripts: string[] = [];
  webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getZoomFactor: () => this.zoom,
    executeJavaScript: vi.fn(async (s: string) => { this.scripts.push(s); }),
  });
  constructor() { FakeWindow.all.push(this); app.emit("browser-window-created", {}, this); }
  isDestroyed() { return false; }
}

vi.mock("electron", () => ({ app, BrowserWindow: FakeWindow, View: FakeView }));
const { childViewsOf, publishChildViews } = await import("./quiet-child-views");

/** What the page was last told, as the relay would read it. */
function told(win: FakeWindow): unknown {
  const page: Record<string, unknown> = {};
  const calls: unknown[] = [];
  new Function("globalThis", win.scripts.at(-1) ?? "")(Object.assign(page, { __realmChildViewsChanged: (json: string) => calls.push(JSON.parse(json)) }));
  expect(calls).toEqual([page.__realmChildViews]);
  return page.__realmChildViews;
}

const settle = () => new Promise((r) => setImmediate(r)).then(() => new Promise((r) => setImmediate(r)));

describe("childViewsOf", () => {
  it("lists the visible views with a target, bottom first, in the page's CSS pixels", () => {
    const ids = new Map<unknown, string>();
    const view = (id: string | null, b: { x: number; y: number; width: number; height: number }, visible = true) => {
      const wc = {};
      if (id) ids.set(wc, id);
      return { webContents: wc as never, getBounds: () => b, getVisible: () => visible };
    };
    const children = [
      view("A", { x: 100, y: 50, width: 400, height: 300 }),
      view("HIDDEN", { x: 0, y: 0, width: 10, height: 10 }, false),
      view(null, { x: 0, y: 0, width: 10, height: 10 }),
      { getBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }), getVisible: () => true },
      view("B", { x: 0, y: 0, width: 50, height: 20 }),
    ];
    expect(childViewsOf(children, 2, (wc) => ids.get(wc) ?? null)).toEqual([
      { targetId: "A", x: 50, y: 25, width: 200, height: 150 },
      { targetId: "B", x: 0, y: 0, width: 25, height: 10 },
    ]);
  });
});

describe("publishChildViews", () => {
  publishChildViews();

  it("tells the window's page where its views are after each change, once per change", async () => {
    const win = new FakeWindow();
    const pane = new FakeContentsView("T1");
    win.contentView.addChildView(pane);
    pane.setBounds({ x: 10, y: 20, width: 300, height: 200 });
    await settle();
    expect(told(win)).toEqual([{ targetId: "T1", x: 10, y: 20, width: 300, height: 200 }]);
    const count = win.scripts.length;
    pane.setBounds({ x: 10, y: 20, width: 300, height: 200 });
    await settle();
    expect(win.scripts.length).toBe(count);
    pane.setBounds({ x: 40, y: 20, width: 300, height: 200 });
    await settle();
    expect(win.scripts.length).toBe(count + 1);
    expect(told(win)).toEqual([{ targetId: "T1", x: 40, y: 20, width: 300, height: 200 }]);
    pane.setVisible(false);
    await settle();
    expect(told(win)).toEqual([]);
    pane.setVisible(true);
    win.contentView.removeChildView(pane);
    await settle();
    expect(told(win)).toEqual([]);
  });

  it("tells a page that reloads again", async () => {
    const win = new FakeWindow();
    const pane = new FakeContentsView("T2");
    win.contentView.addChildView(pane);
    pane.setBounds({ x: 0, y: 0, width: 5, height: 5 });
    await settle();
    const count = win.scripts.length;
    win.webContents.emit("did-finish-load");
    await settle();
    expect(win.scripts.length).toBe(count + 1);
    expect(told(win)).toEqual([{ targetId: "T2", x: 0, y: 0, width: 5, height: 5 }]);
  });
});
