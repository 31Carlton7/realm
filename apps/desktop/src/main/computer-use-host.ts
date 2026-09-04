import {
  parseKeySpec,
  type ComputerAction, type ComputerActResult, type ComputerAppsResult,
  type ComputerElement, type ComputerGrants, type ComputerRefusal, type ComputerSnapshotResult,
} from "@realm/contracts";

/**
 * The computer-use op executor: the main-process half of the `realm-computer` tools, mirroring
 * `browser-agent-host.ts`. Everything native lives behind the injected `request` seam (the Swift
 * helper client), so the decisions here — how a tree renders, how an action translates, which
 * failures become which refusal — are testable without a Mac, a grant, or a child process.
 *
 * The server cannot reach the machine; only main can. This is what it can be asked to do.
 */

export type ComputerUseHostDeps = {
  /** One call into the native helper. Rejections carry the helper's tag on `.cause`. */
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** False when this build has no compiled helper (non-mac, or no Swift toolchain at build time). */
  available(): boolean;
};

/** The helper's own tags, which are the ones worth reporting to the agent verbatim. Anything else
 *  degrades to an untagged failure rather than being guessed at from message text. */
const REFUSALS = new Set<string>([
  "no_accessibility", "stale_snapshot", "no_element", "occluded", "not_frontmost", "forbidden_app", "secure_field",
]);

export class ComputerUseHost {
  constructor(private readonly d: ComputerUseHostDeps) {}

  /** One bridge op. Throws with an agent-readable message; the bridge relays it. */
  async handleOp(op: string, params: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case "computerGrants": {
        // Answerable without the helper: "no helper" is itself the honest answer to "may I?".
        if (!this.d.available()) return { accessibility: false, screenRecording: false } satisfies ComputerGrants;
        return this.d.request<ComputerGrants>("ping");
      }
      case "computerListApps": {
        this.requireHelper();
        return this.d.request<ComputerAppsResult>("listApps");
      }
      case "computerSnapshot": {
        this.requireHelper();
        const raw = await this.d.request<Omit<ComputerSnapshotResult, "text">>("snapshot", {
          ...(typeof params.bundleId === "string" ? { bundleId: params.bundleId } : {}),
          ...(typeof params.pid === "number" ? { pid: params.pid } : {}),
          screenshot: params.screenshot !== false,
        });
        return { ...raw, text: renderElements(raw.elements) } satisfies ComputerSnapshotResult;
      }
      case "computerAct": {
        this.requireHelper();
        const snapshotId = String(params.snapshotId ?? "");
        // Schema-validated server-side; this cast is the two processes' contract, exactly as it is
        // for `browser_act`.
        return this.act(snapshotId, params.action as ComputerAction);
      }
      default:
        throw new Error(`unknown computer host op "${op}"`);
    }
  }

  private requireHelper(): void {
    if (!this.d.available()) {
      throw new Error("computer control is unavailable in this build — the native accessibility helper was not compiled");
    }
  }

  private async act(snapshotId: string, action: ComputerAction): Promise<ComputerActResult> {
    if (!snapshotId) return { ok: false, error: "no snapshot id — take a computer_snapshot before acting", refused: "stale_snapshot" };
    let params: Record<string, unknown>;
    try {
      params = actionToHelperParams(snapshotId, action);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    try {
      return await this.d.request<ComputerActResult>("act", params);
    } catch (e) {
      const error = e as Error & { cause?: unknown };
      const tag = typeof error.cause === "string" && REFUSALS.has(error.cause) ? (error.cause as ComputerRefusal) : undefined;
      return { ok: false, error: error.message, ...(tag ? { refused: tag } : {}) };
    }
  }
}

/**
 * Translate one validated action into the helper's flat parameter shape.
 *
 * The only real work is the key chord: the agent writes `super+c`, the helper wants a key name and a
 * modifier list, and an unparseable chord is refused HERE rather than being passed through — the
 * helper would map an unknown name to no keycode and the agent would get "no key named …" from two
 * processes away, long after the useful context is gone.
 */
export function actionToHelperParams(snapshotId: string, action: ComputerAction): Record<string, unknown> {
  const base = { snapshotId, kind: action.kind };
  switch (action.kind) {
    case "click":
      if (action.index === undefined && (action.x === undefined || action.y === undefined)) {
        throw new Error("a click needs either an element index or both x and y");
      }
      return {
        ...base, ...(action.index !== undefined ? { index: action.index } : { x: action.x, y: action.y }),
        button: action.button, clickCount: action.clickCount, modifiers: action.modifiers,
      };
    case "type":
      return { ...base, ...(action.index !== undefined ? { index: action.index } : {}), text: action.text };
    case "key": {
      const chord = parseKeySpec(action.key);
      if (!chord) {
        throw new Error(`"${action.key}" is not a key chord — write modifiers joined with "+" and a single character or a named key, like "cmd+c", "shift+Tab" or "Return"`);
      }
      return { ...base, ...(action.index !== undefined ? { index: action.index } : {}), key: chord.key, modifiers: chord.modifiers };
    }
    case "scroll":
      return { ...base, ...(action.index !== undefined ? { index: action.index } : {}), dx: action.dx, dy: action.dy };
    case "setValue":
      return { ...base, index: action.index, text: action.text };
    case "drag":
      return { ...base, index: action.index, toIndex: action.toIndex, modifiers: action.modifiers };
    case "menu":
      return { ...base, index: action.index };
  }
}

/**
 * Render an app's elements as the listing the agent reads — the accessibility-tree counterpart of
 * `browser-agent.ts`'s `formatLine`, and deliberately the same shape so an agent that has driven a
 * page already knows how to read one:
 *
 *     [12] AXButton "Save" (940,612 68×22) {press}
 *     [13] AXTextField "Title" = "untitled" (120,84 300×24) {focused}
 *
 * The index is what `computer_act` takes. Flags carry only what changes what the agent should do:
 * whether it can be pressed, whether it is disabled, where focus is, and — loudest — whether it is a
 * password field, which is refused in every mode and should not be attempted.
 */
export function renderElements(elements: ComputerElement[]): string {
  return elements.map(formatElementLine).join("\n");
}

export function formatElementLine(element: ComputerElement): string {
  const parts = [`[${element.index}]`, element.role || "AXUnknown"];
  if (element.subrole) parts.push(element.subrole);
  if (element.name) parts.push(`"${element.name}"`);
  // Only when it says something the name does not: a checkbox's "1", a field's contents. A value
  // identical to the name is the same fact twice.
  if (element.value && element.value !== element.name) parts.push(`= "${element.value}"`);
  parts.push(`(${element.x},${element.y} ${element.w}×${element.h})`);
  const flags = elementFlags(element);
  if (flags.length > 0) parts.push(`{${flags.join(" ")}}`);
  return parts.join(" ");
}

function elementFlags(element: ComputerElement): string[] {
  const flags: string[] = [];
  if (element.role === "AXSecureTextField") flags.push("password");
  if (!element.enabled) flags.push("disabled");
  if (element.focused) flags.push("focused");
  if (element.actions.includes("AXPress")) flags.push("press");
  if (element.actions.includes("AXShowMenu")) flags.push("menu");
  if (element.actions.includes("AXConfirm")) flags.push("confirm");
  return flags;
}
