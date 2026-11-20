import { afterEach, describe, expect, it, vi } from "vitest";
import { SETTING_ACTIVE_SPACE } from "@realm/contracts";
import { SETTING_QUICK_CHAT, createAppStore } from "./store";
import { fakeApi, type FakeData } from "./store.test-fakes";

/**
 * One quick chat, shown in the panel, in a window's card, or both. A window and the panel are two
 * pages on one server, so here they are two stores on one fake, and `window.realm.surface` says
 * which of them the code under test is running in.
 */
function home(overrides: FakeData = {}) {
  const api = fakeApi(overrides);
  const told = vi.fn();
  const as = (surface: "quick-chat" | undefined) => { (window as any).realm = { surface, quickChatPanel: { chatChanged: told } }; };
  const panel = createAppStore(api);
  const win = createAppStore(api);
  return {
    api, told,
    panel: async <T>(fn: (s: ReturnType<typeof panel.getState>) => Promise<T>) => { as("quick-chat"); return fn(panel.getState()); },
    win: async <T>(fn: (s: ReturnType<typeof win.getState>) => Promise<T>) => { as(undefined); return fn(win.getState()); },
    panelState: () => panel.getState(), winState: () => win.getState(),
    stored: () => api.data.settings[SETTING_QUICK_CHAT] as { sessionId: string | null; panel?: boolean } | undefined,
    made: () => api.calls.filter((c) => c.startsWith("createUnlistedSession:")).length,
    deleted: () => api.calls.filter((c) => c.startsWith("deleteSession:")).length,
  };
}

afterEach(() => { delete (window as any).realm; });

describe("the quick chat panel's page", () => {
  it("makes a chat when it is opened, in the space the app was last in, and marks it the panel's", async () => {
    const h = home();
    const last = h.api.data.spaces.at(-1)!;
    h.api.data.settings[SETTING_ACTIVE_SPACE] = last.id;
    await h.panel((s) => s.showQuickChatPanel());
    const chat = h.panelState().quickChat!;
    expect(h.panelState().sessions[chat.sessionId]!.spaceId).toBe(last.id);
    expect(h.stored()).toMatchObject({ sessionId: chat.sessionId, panel: true });
    expect(h.told).toHaveBeenCalled();
  });

  it("shows no space: it restores no layout and does not say where the app was left", async () => {
    const h = home();
    await h.panel((s) => s.showQuickChatPanel());
    expect(h.panelState().layout).toBeNull();
    expect(h.panelState().booted).toBe(true);
    expect(h.api.calls.filter((c) => c.startsWith(`setSetting:${SETTING_ACTIVE_SPACE}`))).toEqual([]);
  });

  it("shows the same chat each time it is opened", async () => {
    const h = home();
    await h.panel((s) => s.showQuickChatPanel());
    const first = h.panelState().quickChat!.sessionId;
    await h.panel((s) => s.showQuickChatPanel());
    expect(h.panelState().quickChat!.sessionId).toBe(first);
    expect(h.made()).toBe(1);
  });

  it("has nothing to open in a home with no space", async () => {
    const h = home({ spaces: [] });
    await h.panel((s) => s.showQuickChatPanel());
    expect(h.panelState().quickChat).toBeNull();
    expect(h.made()).toBe(0);
  });

  it("shows the chat a window's card already has, and leaves it the window's", async () => {
    const h = home();
    await h.win((s) => s.boot());
    await h.win((s) => s.openQuickChat());
    const card = h.winState().quickChat!.sessionId;
    await h.panel((s) => s.showQuickChatPanel());
    expect(h.panelState().quickChat!.sessionId).toBe(card);
    expect(h.made()).toBe(1);
    expect(h.stored()!.panel).toBeUndefined();
  });
});

describe("a Realm window, beside the panel", () => {
  it("puts up no card for a chat made in the panel just because it was launched", async () => {
    const h = home();
    await h.panel((s) => s.showQuickChatPanel());
    await h.win((s) => s.boot());
    expect(h.winState().quickChat).toBeNull();
  });

  it("opens the panel's chat when asked for the quick chat, and does not make a second", async () => {
    const h = home();
    await h.panel((s) => s.showQuickChatPanel());
    const inPanel = h.panelState().quickChat!.sessionId;
    await h.win((s) => s.boot());
    await h.win((s) => s.openQuickChat());
    expect(h.winState().quickChat!.sessionId).toBe(inPanel);
    expect(h.made()).toBe(1);
    // It is the window's card from here on, so it comes back with the window.
    expect(h.stored()).toMatchObject({ sessionId: inPanel });
    expect(h.stored()!.panel).toBeUndefined();
  });

  it("drops its card when the panel deletes the chat, and deletes nothing itself", async () => {
    const h = home();
    await h.win((s) => s.boot());
    await h.win((s) => s.openQuickChat());
    await h.panel((s) => s.showQuickChatPanel());
    await h.panel((s) => s.closeQuickChat());
    expect(h.deleted()).toBe(1);
    await h.win((s) => s.syncQuickChat());
    expect(h.winState().quickChat).toBeNull();
    expect(h.deleted()).toBe(1);
  });

  it("puts up no card when told the panel made a chat", async () => {
    const h = home();
    await h.win((s) => s.boot());
    await h.panel((s) => s.showQuickChatPanel());
    await h.win((s) => s.syncQuickChat());
    expect(h.winState().quickChat).toBeNull();
  });
});

describe("the panel, when a window deletes the chat", () => {
  it("lets go of it without deleting it again, and makes a new one the next time it opens", async () => {
    const h = home();
    await h.win((s) => s.boot());
    await h.win((s) => s.openQuickChat());
    await h.panel((s) => s.showQuickChatPanel());
    const first = h.panelState().quickChat!.sessionId;
    await h.win((s) => s.closeQuickChat());
    await h.panel((s) => s.syncQuickChat());
    expect(h.panelState().quickChat).toBeNull();
    expect(h.panelState().sessions[first]).toBeUndefined();
    expect(h.deleted()).toBe(1);
    await h.panel((s) => s.showQuickChatPanel());
    expect(h.panelState().quickChat!.sessionId).not.toBe(first);
    expect(h.made()).toBe(2);
  });
});
