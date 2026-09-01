/**
 * The browser agent op executor (Plan 11 W3), Electron-free: everything Electron lives behind the
 * injected `CdpBinding` factory (browser-pane.ts) and the pane-host callbacks. One instance per
 * window process; state is per browser id — a live CDP attachment, the console/network ring buffers
 * (filled from CDP events from the moment of first attach), the download-block notes, and the
 * previous snapshot's fingerprint index that `*[new]` markers diff against.
 */
import type { BrowserAction, BrowserDescribeResult, BrowserReadKind } from "@realm/contracts";
import { buildSnapshot, performAct, readPageText, type CdpSend, type SnapshotIndex } from "./browser-agent";

/** The thin CDP surface browser-pane.ts implements over `webContents.debugger`. `onEvent`'s
 *  unsubscribe is never needed here — a binding dies with its view, taking the listener with it. */
export type CdpBinding = {
  send: CdpSend;
  onEvent(cb: (method: string, params: unknown) => void): void;
};

export type BrowserAgentHostDeps = {
  /** Attach (or fail with null) to the live view for this browser id. Called once per attachment;
   *  the host caches the binding until an op fails against a dead view. */
  attach(browserId: string): CdpBinding | null;
  /** Is the pane's view currently alive? Gates the cache — a destroyed view's binding is dropped. */
  hasView(browserId: string): boolean;
  /** BrowserPaneHost.navigate — the SAME normalization + allowlist every other navigation obeys. */
  navigate(browserId: string, url: string): string | null;
  /** Trustworthy page identity (webContents.getURL/getTitle — never page-authored text). */
  pageState(browserId: string): { url: string; title: string } | null;
};

const CONSOLE_MAX = 200;
const NETWORK_MAX = 150;

type Attached = {
  binding: CdpBinding;
  consoleLines: string[];
  network: Map<string, { method: string; url: string; status?: number; mimeType?: string; failed?: string }>;
  networkOrder: string[];
  lastSnapshot: SnapshotIndex | null;
};

export class BrowserAgentHost {
  private readonly attached = new Map<string, Attached>();

  constructor(private readonly d: BrowserAgentHostDeps) {}

  /** A download was blocked on this browser's view (main cancels ALL downloads on the browser
   *  partition — the W3 hard block). Lands in the console buffer so `browser_read console` shows it. */
  noteBlockedDownload(browserId: string, url: string): void {
    const entry = this.attached.get(browserId);
    if (entry) pushRing(entry.consoleLines, `[realm] download blocked (downloads are disabled for agent-driven browsing): ${url}`, CONSOLE_MAX);
  }

  /** The pane's view is gone — drop its attachment and buffers. Snapshot indexes die with the view:
   *  a fresh view is a fresh page, and stale [new] markers would lie about it. */
  release(browserId: string): void {
    this.attached.delete(browserId);
  }

  /** One bridge op. Throws with an agent-readable message on failure; the bridge relays it. */
  async handleOp(op: string, params: Record<string, unknown>): Promise<unknown> {
    const browserId = String(params.browserId ?? "");
    switch (op) {
      case "describe": {
        const state = this.d.pageState(browserId);
        if (!state || !this.d.hasView(browserId)) return { open: false, url: "", title: "", element: null } satisfies BrowserDescribeResult;
        let element: BrowserDescribeResult["element"] = null;
        if (typeof params.ref === "number") element = await this.describeElement(browserId, params.ref).catch(() => null);
        return { open: true, url: state.url, title: state.title, element } satisfies BrowserDescribeResult;
      }
      case "navigate": {
        // Straight to the pane host: normalization and the per-space origin allowlist live there,
        // shared with the address bar and page-initiated navigations. Null = refused/no view.
        return { url: this.d.navigate(browserId, String(params.url ?? "")) };
      }
      case "snapshot": {
        const entry = this.ensure(browserId);
        const result = await buildSnapshot(entry.binding.send, entry.lastSnapshot);
        entry.lastSnapshot = result.index;
        const { index: _index, ...wire } = result;
        return wire;
      }
      case "read": {
        const kind = String(params.kind ?? "text") as BrowserReadKind;
        const entry = this.ensure(browserId);
        if (kind === "console") return { text: entry.consoleLines.join("\n") };
        if (kind === "network") return { text: this.formatNetwork(entry) };
        return { text: await readPageText(entry.binding.send) };
      }
      case "act": {
        const entry = this.ensure(browserId);
        // The action was schema-validated server-side; this cast is the two processes' contract.
        return performAct(entry.binding.send, params.action as BrowserAction);
      }
      case "screenshot": {
        const entry = this.ensure(browserId);
        const shot = (await entry.binding.send("Page.captureScreenshot", { format: "jpeg", quality: 70 })) as { data?: string };
        if (!shot.data) throw new Error("screenshot produced no data");
        return { data: shot.data, mimeType: "image/jpeg" };
      }
      default:
        throw new Error(`unknown browser host op "${op}"`);
    }
  }

  /** Get-or-create the attachment. A cached binding whose view died is dropped and re-attached —
   *  and if no view exists, the op fails with the one message that tells the agent what to do. */
  private ensure(browserId: string): Attached {
    const cached = this.attached.get(browserId);
    if (cached && this.d.hasView(browserId)) return cached;
    this.attached.delete(browserId);
    if (!this.d.hasView(browserId)) throw new Error(`browser ${browserId}'s pane is not open in the app — the user must open (or reopen) the browser pane before tools can drive it`);
    const binding = this.d.attach(browserId);
    if (!binding) throw new Error(`could not attach the debugger to browser ${browserId}`);
    const entry: Attached = { binding, consoleLines: [], network: new Map(), networkOrder: [], lastSnapshot: null };
    binding.onEvent((method, rawParams) => this.onCdpEvent(entry, method, rawParams));
    this.attached.set(browserId, entry);
    // Enable the event domains the buffers feed on. Fire-and-forget: an enable that fails costs a
    // buffer, not the attachment.
    for (const cmd of ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable", "DOM.enable"]) {
      void binding.send(cmd).catch(() => {});
    }
    return entry;
  }

  private onCdpEvent(entry: Attached, method: string, rawParams: unknown): void {
    const p = rawParams as Record<string, unknown>;
    if (method === "Runtime.consoleAPICalled") {
      const type = String(p.type ?? "log");
      const args = (p.args as { value?: unknown; description?: string }[] | undefined) ?? [];
      const text = args.map((a) => (a.value !== undefined ? String(a.value) : a.description ?? "")).join(" ");
      pushRing(entry.consoleLines, `[${type}] ${text}`, CONSOLE_MAX);
    } else if (method === "Log.entryAdded") {
      const e = p.entry as { level?: string; text?: string; url?: string } | undefined;
      if (e) pushRing(entry.consoleLines, `[${e.level ?? "log"}] ${e.text ?? ""}${e.url ? ` (${e.url})` : ""}`, CONSOLE_MAX);
    } else if (method === "Network.requestWillBeSent") {
      const id = String(p.requestId ?? "");
      const req = p.request as { method?: string; url?: string } | undefined;
      if (!id || !req?.url || req.url.startsWith("data:")) return;
      if (!entry.network.has(id)) {
        entry.network.set(id, { method: req.method ?? "GET", url: req.url });
        entry.networkOrder.push(id);
        while (entry.networkOrder.length > NETWORK_MAX) entry.network.delete(entry.networkOrder.shift()!);
      }
    } else if (method === "Network.responseReceived") {
      const row = entry.network.get(String(p.requestId ?? ""));
      const res = p.response as { status?: number; mimeType?: string } | undefined;
      if (row && res) { row.status = res.status; row.mimeType = res.mimeType; }
    } else if (method === "Network.loadingFailed") {
      const row = entry.network.get(String(p.requestId ?? ""));
      if (row) row.failed = String(p.errorText ?? "failed");
    }
  }

  private describeElement(browserId: string, ref: number): Promise<BrowserDescribeResult["element"]> {
    const entry = this.ensure(browserId);
    return (async () => {
      const { node } = (await entry.binding.send("DOM.describeNode", { backendNodeId: ref })) as { node?: { nodeName?: string; attributes?: string[] } };
      const attrs: Record<string, string> = {};
      const flat = node?.attributes ?? [];
      for (let i = 0; i + 1 < flat.length; i += 2) attrs[flat[i]!.toLowerCase()] = flat[i + 1]!;
      let role = "";
      let name = "";
      const ax = (await entry.binding.send("Accessibility.getPartialAXTree", { backendNodeId: ref, fetchRelatives: false }).catch(() => null)) as { nodes?: { role?: { value?: unknown }; name?: { value?: unknown } }[] } | null;
      const axNode = ax?.nodes?.[0];
      if (axNode) { role = String(axNode.role?.value ?? ""); name = String(axNode.name?.value ?? ""); }
      return {
        role: role || (node?.nodeName ?? "").toLowerCase(),
        name: name || attrs["aria-label"] || attrs.placeholder || attrs.title || "",
        tag: (node?.nodeName ?? "").toLowerCase(),
        inputType: attrs.type ?? null,
      };
    })();
  }

  private formatNetwork(entry: Attached): string {
    return entry.networkOrder
      .map((id) => entry.network.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => (r.failed ? `FAIL ${r.method} ${r.url} — ${r.failed}` : `${r.status ?? "…"} ${r.method} ${r.url}${r.mimeType ? ` (${r.mimeType})` : ""}`))
      .join("\n");
  }
}

function pushRing(list: string[], line: string, max: number): void {
  list.push(line);
  while (list.length > max) list.shift();
}
