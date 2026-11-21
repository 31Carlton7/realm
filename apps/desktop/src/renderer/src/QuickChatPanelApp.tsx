import { useEffect, useMemo } from "react";
import { CaretBridge, PressTrackingBridge, RubberBandBridge, ScrollbarStyleBridge, ThemeBridge, TooltipBridge, subscribeSessionEvents } from "./App";
import { dismissBootSplash } from "./boot-splash";
import { QuickChat } from "./components/QuickChat";
import { Toasts } from "./components/Toasts";
import { desktopMeetingAssistant } from "./meeting/desktop";
import { rpc } from "./rpc/client";
import { liveApi } from "./state/live-api";
import { StoreContext, createAppStore, useApp } from "./state/store";

/** The surface main names for the panel's page (main/quick-chat-panel.ts). */
export const QUICK_CHAT_SURFACE = "quick-chat";

/**
 * The quick chat panel's page: the Quick Chat and nothing else, in a small window of its own that
 * opens over any app (main/quick-chat-panel.ts).
 *
 * It is the same component a Realm window floats as a card, on a store of its own, because the
 * panel has to work with no Realm window open. The store is started on the panel's short path
 * (`boot` stops before a profile's view), so this page shows no space, claims none and writes no
 * layout. `:root[data-surface]` is what the stylesheet lays the card out by here: the window is the
 * card, and the bar drags the window.
 */
export function QuickChatPanelApp() {
  const store = useMemo(() => createAppStore(liveApi()), []);
  /* The meeting assistant lives on the page, not on the chat: deleting the chat, or putting the
     panel away, leaves a run listening, and the menu bar's mark says so. */
  const assistant = useMemo(() => desktopMeetingAssistant(() => store.getState().activeSpaceId), [store]);
  useEffect(() => {
    if (!assistant) return;
    void assistant.load();
    const off = window.realm?.meetingAssistant?.onStop(() => void assistant.stop());
    return () => { off?.(); assistant.dispose(); };
  }, [assistant]);
  useEffect(() => {
    document.documentElement.dataset.surface = QUICK_CHAT_SURFACE;
    const panel = window.realm?.quickChatPanel;
    /* One step at a time. Opening reads the look and the chat again and makes a chat when there is
       none, so two at once would each make one. A step that leaves no chat in a home that has a
       space was a delete, here or in a window, and an empty panel is put away. */
    let steps = Promise.resolve();
    let stepping = 0;
    const settle = () => {
      const s = store.getState();
      if (!s.quickChat && s.spaces.length > 0) panel?.hide();
    };
    const step = (action: () => Promise<void>) => {
      stepping++;
      steps = steps.then(action).catch((err: unknown) => store.getState().run(() => Promise.reject(err))).then(() => {
        stepping--;
        if (stepping === 0) settle();
      });
      return steps;
    };
    const show = () => step(() => store.getState().showQuickChatPanel()).then(() => {
      dismissBootSplash();
      document.querySelector<HTMLTextAreaElement>(".quick-chat .composer-input")?.focus();
    });
    /* Main's first "shown" can arrive before this listens, so a page loaded to be opened shows at
       once. One made ahead of the first press waits for it: showing would start a chat nobody asked for. */
    void (panel?.opening() ?? Promise.resolve(true)).then((opening) => { if (opening) void show(); });
    const offs = [
      subscribeSessionEvents(store),
      rpc().on("spaces.changed", () => store.getState().run(() => store.getState().refreshSpaces())),
      rpc().on("accounts.changed", () => store.getState().run(() => store.getState().refreshAccounts())),
      rpc().on("limits.changed", ({ limits }) => store.getState().applyPlanLimits(limits)),
      rpc().onStatusChange((state) => store.getState().applyConnectionState(state)),
      panel?.onShown(() => void show()),
      panel?.onChatChanged(() => void step(() => store.getState().syncQuickChat())),
      // The chat's own trash deletes it without a step of this page's.
      store.subscribe((s, prev) => { if (prev.quickChat && !s.quickChat && stepping === 0) settle(); }),
    ];
    /* Escape puts the panel away and deletes nothing. Registered before the chat mounts, so it is
       ahead of the chat's own Escape, which deletes an empty one and is stopped here either way. A
       menu or a field that used the key has stopped it or marked it handled before it bubbles this
       far, and then the panel stays. */
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      if (!e.defaultPrevented) panel?.hide();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      for (const off of offs) off?.();
      window.removeEventListener("keydown", onKey);
    };
  }, [store]);
  return (
    <StoreContext.Provider value={store}>
      <ThemeBridge />
      <ScrollbarStyleBridge />
      <RubberBandBridge />
      <PressTrackingBridge />
      <TooltipBridge />
      <CaretBridge />
      <QuickChat assistant={assistant} />
      <NoSpace />
      <Toasts />
    </StoreContext.Provider>
  );
}

/** A session runs in a space's folder, so a home with no space has nowhere to run a quick chat. */
function NoSpace() {
  const none = useApp((s) => s.booted && s.spaces.length === 0);
  if (!none) return null;
  return <p className="quick-chat-panel-note">Make a space in Realm first. A quick chat runs in one.</p>;
}
