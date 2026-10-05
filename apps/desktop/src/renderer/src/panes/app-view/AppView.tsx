import { Icon } from "@realm/ui";
import { findLeafOfItem, type AppView as AppViewData, type AppViewRef, type MethodResult } from "@realm/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { rpc } from "../../rpc/client";
import { useApp } from "../../state/store";
import { ViewBridge, type DisplayMode, type HostCapabilities } from "./bridge";
import { hostStyles, hostTheme, onThemeChange } from "./host-context";

/** The frame's sandbox: scripts, its own origin (so a view's storage works, on an origin nobody else
 *  shares), and forms it handles in script. No popups, no top navigation, no modals, no downloads,
 *  and an empty `allow`: no camera, microphone, location or clipboard, whatever the view declared. */
export const VIEW_SANDBOX = "allow-scripts allow-same-origin allow-forms";

/** Inline, a view is as tall as it says it is — up to this, so the transcript stays a transcript.
 *  Expanded, up to the second; past that the view scrolls inside its own frame. */
export const INLINE_COMPACT_MAX = 320;
export const INLINE_EXPANDED_MAX = 720;
const INLINE_MIN = 48;
/** The frame's height before the view has said how tall it is. */
const INLINE_FIRST = 160;

type State =
  | { kind: "loading" }
  | { kind: "ready"; view: AppViewData }
  | { kind: "hidden" }
  | { kind: "unavailable"; reason: string };

type Props = {
  viewId: string;
  /** Where the view is shown: under its tool call, or as a tab of its own. */
  mode: "inline" | "tab";
  /** The result's own reference, when there is one — what the head is labelled with before the view
   *  has been fetched, and what a tab is made from. */
  viewRef?: AppViewRef;
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * A view an MCP server drew for a tool call (MCP Apps), framed.
 *
 * The frame is the server's drawing and nothing of Realm's: it is loaded from Realm's views listener
 * on an origin of its own (`*.mcp-view.localhost`), sandboxed, under the CSP the server's resource
 * declared and Realm cut down. From inside it the view can reach its declared domains and this
 * component's bridge, and that is all — not Realm's page, not its preload, not another view.
 *
 * Under its tool call it is compact — as tall as it asks, up to `INLINE_COMPACT_MAX` — and expands on
 * request; opened as a tab it fills the pane. A view open as a tab is not also live under its call:
 * the call says where it went, rather than running a second copy of the same app.
 */
export function AppView({ viewId, mode, viewRef }: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const openAppView = useApp((s) => s.openAppView);
  const openItem = useApp((s) => s.openItem);
  // The tab this view has, when it has one on screen.
  const tabItemId = useApp((s) => {
    if (mode !== "inline" || !s.layout) return null;
    const item = s.items.find((i) => i.kind === "app-view" && i.refId === viewId && !i.archived);
    return item && findLeafOfItem(s.layout, item.id) ? item.id : null;
  });
  const live = mode === "tab" || tabItemId === null;

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    let mounted: string | null = null;
    const open = () => rpc().call("apps.view", { viewId }).then((r: MethodResult<"apps.view">) => {
      if (cancelled) { if (r.state === "ready") void rpc().call("apps.release", { url: r.view.url }).catch(() => {}); return; }
      if (r.state === "ready") { mounted = r.view.url; setState({ kind: "ready", view: r.view }); }
      else setState(r.state === "hidden" ? { kind: "hidden" } : { kind: "unavailable", reason: r.reason });
    }).catch((e: unknown) => { if (!cancelled) setState({ kind: "unavailable", reason: e instanceof Error ? e.message : String(e) }); });
    void open();
    /* A server switched off, its views turned off, the server removed: the view goes with the
       decision, now, not on the next relaunch. Asked again on every change to the Connections; an
       answer that is still "ready" leaves the frame as it is and lets the spare address go. */
    const off = rpc().on("mcp.changed", () => {
      void rpc().call("apps.view", { viewId }).then((r) => {
        if (cancelled) return;
        if (r.state === "ready") { void rpc().call("apps.release", { url: r.view.url }).catch(() => {}); return; }
        if (mounted) { void rpc().call("apps.release", { url: mounted }).catch(() => {}); mounted = null; }
        setState(r.state === "hidden" ? { kind: "hidden" } : { kind: "unavailable", reason: r.reason });
      }).catch(() => {});
    });
    return () => {
      cancelled = true;
      off();
      if (mounted) void rpc().call("apps.release", { url: mounted }).catch(() => {});
    };
  }, [viewId, live, attempt]);

  const serverName = state.kind === "ready" ? state.view.serverName : viewRef?.serverName ?? "MCP server";
  const tool = viewRef?.tool ?? (state.kind === "ready" && typeof state.view.tool.name === "string" ? state.view.tool.name : "");
  const openTab = () => {
    const ref: AppViewRef | null = viewRef ?? (state.kind === "ready" ? { viewId, serverId: state.view.serverId, serverName: state.view.serverName, tool } : null);
    const sessionId = state.kind === "ready" ? state.view.sessionId : null;
    if (ref && sessionId) void openAppView(sessionId, ref);
  };

  if (state.kind === "hidden") return null;
  if (mode === "inline" && !live) {
    return (
      <section className="app-view" data-mode="inline" data-elsewhere="" aria-label={`View from ${serverName}`}>
        <div className="app-view-head">
          <Icon name="app-view" size={14} className="app-view-mark" />
          <span className="app-view-name">{serverName}</span>
          <span className="app-view-where">Open in a tab</span>
          <span className="app-view-actions">
            <button type="button" className="icon-btn" aria-label="Go to the tab" title="Go to the tab" onClick={() => tabItemId && void openItem(tabItemId)}>
              <Icon name="panelRight" size={14} />
            </button>
          </span>
        </div>
      </section>
    );
  }
  if (state.kind === "unavailable") {
    return (
      <section className="app-view" data-mode={mode} data-state="unavailable" aria-label={`View from ${serverName}`}>
        <p className="app-view-note">{state.reason}</p>
        <button type="button" className="btn-quiet" onClick={() => { setState({ kind: "loading" }); setAttempt((n) => n + 1); }}>Try again</button>
      </section>
    );
  }
  return (
    <section className="app-view" data-mode={mode} data-state={state.kind}
      data-border={state.kind === "ready" && state.view.prefersBorder === false ? "none" : undefined} aria-label={`View from ${serverName}`}>
      {state.kind === "ready"
        ? <ViewFrame key={state.view.url} view={state.view} mode={mode} serverName={serverName} tool={tool} onOpenTab={mode === "inline" ? openTab : undefined} />
        : <div className="app-view-loading" style={mode === "inline" ? { height: INLINE_FIRST } : undefined}>Loading the view from {serverName}…</div>}
    </section>
  );
}

/** The live frame and its bridge, for one address. Keyed on the address: a new one is a new frame. */
function ViewFrame({ view, mode, serverName, tool, onOpenTab }: { view: AppViewData; mode: "inline" | "tab"; serverName: string; tool: string; onOpenTab?: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [asked, setAsked] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const bridge = useRef<ViewBridge | null>(null);
  const displayMode = useRef<DisplayMode>("inline");

  const dimensions = useCallback(() => {
    const box = frame.current?.getBoundingClientRect();
    const width = Math.round(box?.width ?? 0);
    return mode === "tab"
      ? { width, height: Math.round(box?.height ?? 0) }
      : { width, maxHeight: expanded ? INLINE_EXPANDED_MAX : INLINE_COMPACT_MAX };
  }, [mode, expanded]);
  const dimensionsNow = useRef(dimensions);
  dimensionsNow.current = dimensions;

  useLayoutEffect(() => {
    const b = new ViewBridge({
      target: () => frame.current?.contentWindow ?? null,
      origin: view.origin,
      input: view.input,
      result: view.result,
      onSize: ({ height }) => { if (height !== undefined) setAsked(height); },
      initialize: ({ availableDisplayModes }) => {
        // A tab is the view's whole pane — "fullscreen" in the spec's words — where the view says it
        // can be shown that way; otherwise it is the inline view, given more room.
        const shown: DisplayMode = mode === "tab" && availableDisplayModes.includes("fullscreen") ? "fullscreen" : "inline";
        displayMode.current = shown;
        const hostCapabilities: HostCapabilities = { sandbox: { permissions: {}, csp: view.csp } };
        return {
          displayMode: shown,
          hostCapabilities,
          hostContext: {
            toolInfo: { tool: view.tool },
            theme: hostTheme(), styles: hostStyles(),
            displayMode: shown, availableDisplayModes: [shown],
            containerDimensions: dimensionsNow.current(),
            locale: navigator.language,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            userAgent: "Realm",
            platform: "desktop",
            deviceCapabilities: { touch: false, hover: true },
          },
        };
      },
    });
    bridge.current = b;
    window.addEventListener("message", b.receive);
    const stopTheme = onThemeChange(() => b.setContext({ theme: hostTheme(), styles: hostStyles() }));
    return () => {
      window.removeEventListener("message", b.receive);
      stopTheme();
      b.teardown(mode === "tab" ? "the tab was closed" : "the view left the transcript");
      bridge.current = null;
    };
  }, [view, mode]);

  // The room the view has, again, whenever it changes: the column was resized, or it was expanded.
  useEffect(() => {
    const el = frame.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let last = "";
    const tell = () => {
      const next = dimensions();
      const key = JSON.stringify(next);
      if (key === last) return;
      last = key;
      bridge.current?.setContext({ containerDimensions: next });
    };
    tell();
    const ro = new ResizeObserver(tell);
    ro.observe(el);
    return () => ro.disconnect();
  }, [dimensions]);

  const overflows = asked !== null && asked > INLINE_COMPACT_MAX;
  const height = mode === "tab" ? undefined : clamp(asked ?? INLINE_FIRST, INLINE_MIN, expanded ? INLINE_EXPANDED_MAX : INLINE_COMPACT_MAX);
  return (
    <>
      {mode === "inline" && (
        <div className="app-view-head">
          <Icon name="app-view" size={14} className="app-view-mark" />
          <span className="app-view-name" title={tool ? `${serverName}: ${tool}` : serverName}>{serverName}</span>
          <span className="app-view-actions">
            {overflows && (
              <button type="button" className="icon-btn" aria-expanded={expanded}
                aria-label={expanded ? "Show less of the view" : "Show all of the view"} title={expanded ? "Show less of the view" : "Show all of the view"}
                onClick={() => setExpanded(!expanded)}>
                <Icon name={expanded ? "chevronUp" : "chevronDown"} size={14} />
              </button>
            )}
            {onOpenTab && (
              <button type="button" className="icon-btn" aria-label="Open in a tab" title="Open in a tab beside the session" onClick={onOpenTab}>
                <Icon name="panelRight" size={14} />
              </button>
            )}
          </span>
        </div>
      )}
      <iframe ref={frame} className="app-view-frame" src={view.url} sandbox={VIEW_SANDBOX} referrerPolicy="no-referrer"
        title={tool ? `${serverName}: ${tool}` : `View from ${serverName}`} style={height !== undefined ? { height } : undefined}
        {...(mode === "inline" ? { loading: "lazy" as const } : {})} />
    </>
  );
}
