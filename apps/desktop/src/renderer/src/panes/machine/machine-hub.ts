/**
 * One live RFB connection per machineId, outliving every pane that shows it (Plan 25 W3).
 *
 * The hub is not optional, and the reason is structural: `PaneHost` does not render panes in
 * inactive pane groups AT ALL, so a machine pane will be unmounted while its machine is connected —
 * a space switch, a tab switch, a layout reshape. An RFB client owned by the component would
 * reconnect every time, and a reconnect is a full framebuffer request over somebody's network.
 *
 * Modelled on `TerminalHub`, with the differences that matter written down:
 *
 *   - **`detach` does NOT disconnect.** The connection stays up and keeps decoding, so a machine you
 *     come back to shows the current screen rather than a grey rectangle filling in. This is the
 *     property the whole hub exists for.
 *   - **There is no `MachineBuffer`,** and that is a decision rather than an omission. A terminal's
 *     scrollback is a STREAM, and a pane that missed some of it has lost content forever — hence
 *     `TerminalBuffer`. A framebuffer is a current STATE, and RFB already holds the latest pixels in
 *     the canvas. The canvas is the buffer; a second copy would be a stale one.
 *   - **`isConnected`/`onConnect` in place of `hasData`/`onFirstData`,** because the thing a pane
 *     waits for is a screen rather than a first byte.
 */
import type { EventName, EventPayload } from "@realm/contracts";
import { rpc } from "../../rpc/client";

/** The subset of noVNC's `RFB` this depends on. A seam, so no test ever loads `@novnc/novnc` — the
 *  library wants a real canvas, a real WebSocket and a real decoder, and none of those is a thing a
 *  unit test should be arranging to say something about attach and detach. */
export type RfbLike = {
  disconnect(): void;
  focus(): void;
  blur(): void;
  addEventListener(type: "connect" | "disconnect" | "credentialsrequired" | "desktopname", fn: (e: Event) => void): void;
  /**
   * noVNC's own knobs, the two this sets.
   *
   * `scaleViewport` is TRUE, and it took reading noVNC's source to get right. Its `Display` maps a
   * click as `clientToElement(...)` — CSS offsets inside the canvas's bounding rect — and then
   * divides by its OWN `_scale`, which only `scaleViewport` ever sets. Leave it false while CSS-
   * scaling the canvas from outside and the picture is correct while every click is wrong by exactly
   * the scale factor: the failure with no visible symptom.
   *
   * So there is still exactly one scaler, and `fit.ts` still owns the geometry — it just drives
   * noVNC's rather than competing with it. `autoscale` fits the canvas to its CONTAINER, and the
   * container is sized to `fit.cssWidth × fit.cssHeight`, so the ratio noVNC derives IS the ratio
   * `fitFramebuffer` computed. The two agree by construction rather than by being checked.
   */
  viewOnly: boolean;
  scaleViewport: boolean;
  /** Send a chord the platform would otherwise eat (⌘Q, ⌘Tab). Keysyms, not key names. */
  sendKey(keysym: number, code: string | null, down?: boolean): void;
  clipboardPasteFrom(text: string): void;
};

export type MachineFactory = (container: HTMLElement, url: string) => RfbLike;

export type HubTransport = {
  on<E extends EventName>(event: E, fn: (payload: EventPayload<E>) => void): () => void;
};

export type MachineEntry = {
  readonly machineId: string;
  readonly host: HTMLDivElement;
  readonly rfb: RfbLike;
  /** Move the host element into `container`. Idempotent, and a no-op when it is already there. */
  attach(container: HTMLElement): void;
  /** Take the host out of the DOM. Disconnects NOTHING — see the class comment. */
  detach(): void;
};

export class MachineHub {
  private entries = new Map<string, MachineEntry & { subs: (() => void)[] }>();
  private connected = new Set<string>();
  private connectListeners = new Map<string, Set<() => void>>();
  /** The URL each entry was built for. A `machine.status` carrying a DIFFERENT one means the server
   *  restarted its relay or the machine was stopped and started, and the old socket is dead — so the
   *  entry is torn down rather than left showing the last frame it happened to receive. */
  private urls = new Map<string, string>();
  private unsubscribe: (() => void) | null = null;

  constructor(private transport: HubTransport, private factory: MachineFactory, private doc: Document = document) {}

  private ensureSubscription(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.transport.on("machine.status", (s) => {
      // A machine that stopped, failed, or came back on a new relay URL has no live socket behind
      // whatever this hub is holding. Dropping it here rather than in the pane means it happens even
      // while the pane is unmounted, which is exactly when nobody would otherwise notice.
      if (s.status === "running" || s.status === "booting") {
        if (s.wsUrl && this.urls.get(s.machineId) && this.urls.get(s.machineId) !== s.wsUrl) this.dispose(s.machineId);
        return;
      }
      this.dispose(s.machineId);
    });
  }

  has(machineId: string): boolean { return this.entries.has(machineId); }
  isConnected(machineId: string): boolean { return this.connected.has(machineId); }

  /** Fires once, when this machine's connection reports a screen. Never fires if it already has —
   *  check `isConnected` first, exactly like `onFirstData`. */
  onConnect(machineId: string, fn: () => void): () => void {
    if (this.connected.has(machineId)) return () => {};
    const s = this.connectListeners.get(machineId) ?? new Set();
    s.add(fn); this.connectListeners.set(machineId, s);
    return () => s.delete(fn);
  }

  /**
   * The connection for this machine, built on first ask.
   *
   * `url` is the loopback relay's, token and all. It is passed in rather than looked up because the
   * pane already has it from `machine.status` — and because a hub that fetched it would be a second
   * place that decides when a machine is reachable.
   */
  acquire(machineId: string, url: string): MachineEntry {
    this.ensureSubscription();
    const existing = this.entries.get(machineId);
    if (existing && this.urls.get(machineId) === url) return existing;
    if (existing) this.dispose(machineId);

    const host = this.doc.createElement("div");
    host.className = "machine-host";
    const rfb = this.factory(host, url);
    // Driven BY `fit.ts` rather than competing with it: the host element is sized to the fit's own
    // CSS box, and noVNC scales the canvas to fill it — which is the same ratio, and which is also
    // what keeps its click mapping in step with `toFramebuffer`. See the note on `RfbLike`.
    rfb.scaleViewport = true;

    const onConnect = () => {
      this.connected.add(machineId);
      const fns = this.connectListeners.get(machineId);
      this.connectListeners.delete(machineId);
      if (fns) for (const fn of fns) fn();
    };
    const onDisconnect = () => { this.connected.delete(machineId); };
    rfb.addEventListener("connect", onConnect);
    rfb.addEventListener("disconnect", onDisconnect);

    const entry = {
      machineId, host, rfb,
      subs: [] as (() => void)[],
      attach: (container: HTMLElement) => { if (host.parentElement !== container) container.appendChild(host); },
      // Out of the DOM, still connected, still decoding. The one line this whole class is for.
      detach: () => { host.remove(); },
    };
    this.entries.set(machineId, entry);
    this.urls.set(machineId, url);
    return entry;
  }

  /** Really disconnect — a stop, a delete, a relay that moved. */
  dispose(machineId: string): void {
    const e = this.entries.get(machineId);
    if (!e) return;
    for (const off of e.subs) off();
    e.host.remove();
    // Never left decoding: an RFB client with no host in the DOM still holds a socket and still
    // paints every update into a canvas nobody will ever see.
    try { e.rfb.disconnect(); } catch { /* already gone */ }
    this.entries.delete(machineId);
    this.urls.delete(machineId);
    this.connected.delete(machineId);
    this.connectListeners.delete(machineId);
  }

  disposeAll(): void {
    for (const id of [...this.entries.keys()]) this.dispose(id);
    this.unsubscribe?.(); this.unsubscribe = null;
  }
}

let singleton: MachineHub | null = null;

/**
 * The app's hub, built on first use.
 *
 * `@novnc/novnc` is imported HERE rather than at the top of the module, and lazily: it is 635KB, and
 * a session that never opens a machine should never pay for it. The import is synchronous inside the
 * factory rather than a top-level `await import`, so the pane's mount does not have to be async and
 * the hub does not have to hold a promise — Vite splits it into its own chunk either way.
 */
export function getMachineHub(): MachineHub {
  return (singleton ??= new MachineHub(rpc(), defaultFactory));
}

/** Test seam: substitute a fake-backed hub (pass null to reset). No test loads noVNC — it wants a
 *  real canvas, a real WebSocket and a real decoder, none of which says anything about attach. */
export function setMachineHubForTests(hub: MachineHub | null): void { singleton = hub; }

/**
 * noVNC's constructor, once it has been fetched.
 *
 * Held here rather than imported at the top of the module so Vite splits it into its own chunk: it
 * is 635KB, and a session that never opens a machine should never download or parse it. The pane
 * awaits `loadRfb()` before it acquires, which keeps the hub itself synchronous — an async `acquire`
 * would put a promise between "the pane mounted" and "the host element exists", and the attach/
 * detach dance is hard enough to reason about without one.
 */
let RfbCtor: (new (target: HTMLElement, url: string, options?: object) => RfbLike) | null = null;

export async function loadRfb(): Promise<void> {
  if (RfbCtor) return;
  // `@novnc/novnc` has a single-string exports map (`"exports": "./core/rfb.js"`), so the bare
  // specifier is the only one that resolves — a deep path fails at build rather than at runtime.
  const mod = await import("@novnc/novnc");
  RfbCtor = (mod as unknown as { default: new (t: HTMLElement, u: string, o?: object) => RfbLike }).default;
}

export const defaultFactory: MachineFactory = (container, url) => {
  if (!RfbCtor) throw new Error("noVNC has not been loaded — await loadRfb() before acquiring");
  return new RfbCtor(container, url, {
    /* No `credentials`, and there is nowhere to put any: the relay has already authenticated the far
       end, and the renderer is handed a socket past the password. This is the property the whole
       server-side handshake exists for, and its shape here is an option that is simply absent. */
  });
};
