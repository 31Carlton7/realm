import { MCP_APPS_PROTOCOL } from "@realm/contracts";

/**
 * Realm's half of the MCP Apps bridge: JSON-RPC 2.0 over postMessage with one view's frame.
 *
 * A message is the view's only when BOTH hold: it came from this frame's window (`event.source`), and
 * from the origin this view was served on (`event.origin`). The first keeps out every other frame in
 * the window — another view, a guide, anything a view nests inside itself. The second keeps out what
 * the source check alone cannot: a document that replaced the view inside the same frame. Everything
 * Realm sends goes to that origin by name, never `*`, so a frame that has navigated elsewhere hears
 * nothing.
 *
 * Nothing is sent before the view says it is ready (`ui/notifications/initialized`), as the spec
 * requires. Then the call's arguments and result go over once each, and from there the bridge only
 * answers. What a view may ASK — call a tool, put words to the agent, open a page — goes to `hold`,
 * which holds it for the user's click; with no `hold` wired every such request is refused and the
 * host does not advertise it. Requests outside the spec's list are refused as unknown methods.
 */

export type JsonRpcId = string | number;
export type HostContext = Record<string, unknown>;
export type HostCapabilities = Record<string, unknown>;
export type DisplayMode = "inline" | "fullscreen";

/** A request a view makes that only the user can grant. */
export type HeldRequest =
  | { kind: "tool"; name: string; arguments: Record<string, unknown> }
  | { kind: "message"; text: string }
  | { kind: "link"; url: string };

export type BridgeDeps = {
  /** The frame's window — read when a message arrives and when one is sent, because it is null until
   *  the frame loads and after it goes. */
  target: () => Window | null;
  /** The origin this view was served on. */
  origin: string;
  /** The `ui/initialize` answer: the host's context and what it can do, given what the view declared
   *  it can be shown as. */
  initialize: (app: { availableDisplayModes: string[] }) => { hostContext: HostContext; hostCapabilities: HostCapabilities; displayMode: DisplayMode };
  /** The call the view was drawn for, sent once it is ready. */
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  onSize?: (size: { width?: number; height?: number }) => void;
  /** Where a request needing the user's click goes. Resolves with what the view is answered;
   *  rejects with the sentence it is refused with. Absent: such requests are refused outright. */
  hold?: (req: HeldRequest) => Promise<Record<string, unknown>>;
};

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
/** The spec's implementation-defined error, for a refusal. */
const REFUSED = -32000;

type Incoming = { id?: JsonRpcId; method?: string; params?: unknown; result?: unknown; error?: unknown };

/** A JSON-RPC 2.0 message, or null. Shape only: what a method's params mean is each handler's. */
export function parseMessage(data: unknown): Incoming | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const m = data as Record<string, unknown>;
  if (m.jsonrpc !== "2.0") return null;
  if (m.id !== undefined && typeof m.id !== "string" && typeof m.id !== "number") return null;
  if (m.method !== undefined && (typeof m.method !== "string" || m.method.length === 0 || m.method.length > 200)) return null;
  if (m.params !== undefined && (m.params === null || typeof m.params !== "object")) return null;
  return m as Incoming;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The text of a `ui/message`'s content — an array of blocks per the SDK, one block per the spec's
 *  own example — or null when it carries none Realm can take. */
export function messageText(params: unknown): string | null {
  if (!isObject(params) || params.role !== "user") return null;
  const blocks = Array.isArray(params.content) ? params.content : [params.content];
  const text = blocks.filter((b): b is { type: "text"; text: string } => isObject(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text).join("\n\n").trim();
  return text || null;
}

/** An address a view may ask to have opened: http or https, and nothing else. */
export function linkOf(params: unknown): string | null {
  if (!isObject(params) || typeof params.url !== "string") return null;
  try { const u = new URL(params.url); return u.protocol === "https:" || u.protocol === "http:" ? u.href : null; } catch { return null; }
}

export class ViewBridge {
  private initialized = false;
  private sentData = false;
  private displayMode: DisplayMode = "inline";
  private holding = false;
  private nextId = 1;
  private closed = false;

  constructor(private readonly d: BridgeDeps) {}

  /** The window's `message` listener. True when the message was this view's (whatever it said). */
  receive = (e: { source: unknown; origin: string; data: unknown }): boolean => {
    const frame = this.d.target();
    if (this.closed || !frame || e.source !== frame || e.origin !== this.d.origin) return false;
    const m = parseMessage(e.data);
    if (!m || !m.method) return true; // not ours to answer: a response to the teardown, or noise
    if (m.id !== undefined) void this.request(m.id, m.method, m.params);
    else this.notification(m.method, m.params);
    return true;
  };

  /** A change to what the view was told — the theme, the room it has. Sent once it is listening. */
  setContext(changed: HostContext): void {
    if (!this.initialized || this.closed) return;
    if (typeof changed.displayMode === "string") this.displayMode = changed.displayMode as DisplayMode;
    this.send({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: changed });
  }

  /** The view is going away: it is told, and nothing it says after is heard. */
  teardown(reason: string): void {
    if (this.initialized && !this.closed) this.send({ jsonrpc: "2.0", id: `teardown-${this.nextId++}`, method: "ui/resource-teardown", params: { reason } });
    this.closed = true;
  }

  private async request(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    try {
      this.respond(id, await this.answer(method, params));
    } catch (e) {
      const err = e as { code?: number; message?: string };
      this.send({ jsonrpc: "2.0", id, error: { code: typeof err.code === "number" ? err.code : REFUSED, message: err.message ?? String(e) } });
    }
  }

  private async answer(method: string, params: unknown): Promise<Record<string, unknown>> {
    switch (method) {
      case "ui/initialize": {
        const declared = isObject(params) && isObject(params.appCapabilities) && Array.isArray(params.appCapabilities.availableDisplayModes)
          ? params.appCapabilities.availableDisplayModes.filter((m): m is string => typeof m === "string") : [];
        const { hostContext, hostCapabilities, displayMode } = this.d.initialize({ availableDisplayModes: declared });
        this.displayMode = displayMode;
        return { protocolVersion: MCP_APPS_PROTOCOL, hostInfo: { name: "Realm", version: "2" }, hostCapabilities, hostContext };
      }
      case "ping": return {};
      // The host decides where a view is shown, and says so: the mode it is in now, whatever was asked.
      case "ui/request-display-mode": return { mode: this.displayMode };
      case "tools/call": {
        if (!isObject(params) || typeof params.name !== "string" || (params.arguments !== undefined && !isObject(params.arguments))) throw { code: INVALID_PARAMS, message: "tools/call needs a tool name and object arguments" };
        return this.held({ kind: "tool", name: params.name, arguments: (params.arguments as Record<string, unknown> | undefined) ?? {} });
      }
      case "ui/message": {
        const text = messageText(params);
        if (!text) throw { code: INVALID_PARAMS, message: "Realm takes a message of text from the user role" };
        return this.held({ kind: "message", text });
      }
      case "ui/open-link": {
        const url = linkOf(params);
        if (!url) throw { code: INVALID_PARAMS, message: "Invalid URL" };
        return this.held({ kind: "link", url });
      }
      default: throw { code: METHOD_NOT_FOUND, message: `Realm does not take ${method} from a view` };
    }
  }

  /** One request held for the user at a time: a view that asks again while one waits is refused,
   *  so a burst of requests cannot queue up clicks behind the one on screen. */
  private async held(req: HeldRequest): Promise<Record<string, unknown>> {
    if (!this.d.hold) throw { code: METHOD_NOT_FOUND, message: "Realm shows this view read-only" };
    if (this.holding) throw { code: REFUSED, message: "Another request from this view is waiting for the user" };
    this.holding = true;
    try { return await this.d.hold(req); }
    catch (e) { throw { code: REFUSED, message: e instanceof Error ? e.message : String(e) }; }
    finally { this.holding = false; }
  }

  private notification(method: string, params: unknown): void {
    if (method === "ui/notifications/initialized") {
      this.initialized = true;
      // Once, and in the spec's order: the arguments, then the result they produced.
      if (this.sentData) return;
      this.sentData = true;
      this.send({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: this.d.input } });
      this.send({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: this.d.result });
    } else if (method === "ui/notifications/size-changed" && isObject(params)) {
      const size = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
      this.d.onSize?.({ width: size(params.width), height: size(params.height) });
    }
    // `notifications/message` (a view's log) and `ui/notifications/request-teardown` are heard and
    // left: a view's log goes nowhere a person reads, and a view does not close itself.
  }

  private respond(id: JsonRpcId, result: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  private send(message: Record<string, unknown>): void {
    if (this.closed) return;
    this.d.target()?.postMessage(message, this.d.origin);
  }
}
