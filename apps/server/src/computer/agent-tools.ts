import { z } from "zod";
import {
  COMPUTER_PROVIDER_NAME, ComputerActionSchema,
  type ComputerAction, type ComputerActResult, type ComputerAppsResult,
  type ComputerGrants, type ComputerSnapshotResult,
} from "@realm/contracts";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProviderCallContext, RealmToolProvider } from "../mcp/gateway";
import { clip, err, ok } from "../mcp/tool-result";
import type { McpService } from "../mcp/service";
import type { BrowserHostBridge } from "../browsers/host-bridge";
import type { BrowserPermissionBroker } from "../browsers/permissions";
import { fenceUntrusted } from "../browsers/guards";

export { COMPUTER_PROVIDER_NAME };

/**
 * The `realm-computer` gateway provider: the agent tool surface over the Mac's own applications,
 * through the accessibility APIs. Registered in-process on the MCP gateway like `realm-browser`, so
 * tools arrive as `realm-computer__computer_snapshot` and the rest.
 *
 * It is the same shape as the browser tools — snapshot, address an element by index, act, with the
 * index re-resolved against the live element at act time — because it is the same problem, and an
 * agent that can drive a page should not have to learn a second idiom to drive an app.
 *
 * **The safety model, in full, outermost first.** This is the first thing in Realm that can drive the
 * whole machine, so the layers are enumerated rather than left to be inferred:
 *
 *  1. **macOS TCC.** Nothing works until the user grants Accessibility, which is a real system
 *     dialog and a real toggle in System Settings, revocable at any time. Screen Recording is
 *     separate and optional; without it snapshots carry no image and everything else still works.
 *  2. **Off until a space asks for it.** Unlike every other provider, `realm-computer` is disabled
 *     until the space turns it on (`OPT_IN_PROVIDERS` in `McpService`). A space that was never given
 *     computer use has no such tools in its list at all.
 *  3. **Hard refusals that no mode lifts**, enforced in the native helper where they cannot be
 *     routed around: Realm never drives itself (its own windows are where permission cards appear),
 *     nor System Settings (where every TCC grant lives, including the one that permits this), nor the
 *     password prompt, the file-grant dialog, Keychain Access, or a terminal. Typing into a password
 *     field is refused against the element's LIVE role, not the snapshot's.
 *  4. **Read-only mode refuses mutation.** A `plan` session cannot act, exactly as it cannot act on
 *     a page.
 *  5. **A permission card per application, per session** — and `bypassPermissions` does NOT skip it
 *     (`promptUnderBypass`). That mode means "stop asking about ordinary actions", and it earns that
 *     meaning from the blast radius being a page in Realm's own pane. Approving TextEdit must not
 *     license Mail, so the grant is keyed on the bundle id; answering "always" covers that app for
 *     the rest of the session and nothing else.
 *  6. **Two independent checks before any synthetic input lands**, both in the helper: the target app
 *     must actually come to the front, and the point must belong to it at the instant of the click.
 *  7. **App text is untrusted data.** A snapshot is other applications' content — an email body, a
 *     document, a web page inside someone else's browser — so it is fenced before it enters a tool
 *     result, and where a permission card names an element the label is attributed to the app rather
 *     than spoken in Realm's voice.
 *
 * What this model does NOT have, stated plainly: a durable per-application allowlist the user
 * curates ahead of time. The per-app card is a session-scoped stand-in — it asks before the first
 * action against each app rather than letting the user decide in advance which apps are eligible.
 */
export type ComputerAgentToolsDeps = {
  mcp: Pick<McpService, "providerEnabled">;
  bridge: Pick<BrowserHostBridge, "call">;
  broker: Pick<BrowserPermissionBroker, "gate">;
};

export function createComputerAgentProvider(d: ComputerAgentToolsDeps): RealmToolProvider {
  // snapshotId → the app it belongs to, scoped to the session that took it.
  //
  // The server needs this for two things it cannot get any other way: naming the app on the
  // permission card, and keying the grant per app. It also gives a real property — a session can
  // only act on a snapshot it took, so an id that leaked into a transcript or was guessed is
  // refused rather than driving whatever it happens to match.
  const snapshots = new SnapshotOwners();
  return {
    name: COMPUTER_PROVIDER_NAME,
    async tools(ctx: ProviderCallContext): Promise<Tool[]> {
      if (!d.mcp.providerEnabled(ctx.spaceId, COMPUTER_PROVIDER_NAME)) return [];
      return TOOLS;
    },
    async call(ctx: ProviderCallContext, tool: string, args: unknown): Promise<CallToolResult> {
      if (!d.mcp.providerEnabled(ctx.spaceId, COMPUTER_PROVIDER_NAME)) {
        return err(`computer control is off for this space. The user turns it on under the space's MCP settings, next to Realm's other built-in tools — it is off by default because it reaches every app on the Mac.`);
      }
      const handler = HANDLERS[tool];
      if (!handler) return err(`unknown tool "${tool}" — this provider has: ${TOOLS.map((t) => t.name).join(", ")}`);
      try {
        return await handler({ ...d, snapshots }, ctx, args ?? {});
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

/* ---------------------------------- tool definitions ---------------------------------- */

const TOOLS: Tool[] = [
  {
    name: "computer_list_apps",
    description:
      "List the applications running on this Mac that can be driven, with the bundle id to pass to computer_snapshot. Also reports whether macOS has granted Realm the Accessibility and Screen Recording permissions this needs. Realm, System Settings, password prompts and terminals are never listed and can never be driven. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "computer_snapshot",
    description:
      "Read an app's accessibility tree: every visible, addressable element as a line \"[N] AXRole \\\"name\\\" (x,y w×h) {flags}\". The [N] is what computer_act takes. Call this before every batch of actions and again after anything that changes the screen — indices are only valid for the snapshot that produced them, and acting on a stale one is refused rather than guessed at. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        bundleId: { type: "string", description: "the app's bundle id from computer_list_apps; omit to snapshot whatever is frontmost" },
        screenshot: { type: "boolean", description: "also return an image of the app's windows (default false — the tree is what you act on; ask for this when the tree is ambiguous or you need to see layout). Needs the Screen Recording permission." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "computer_act",
    description:
      "Act on the app you last snapshotted: click, type, press a key, scroll, set a field's value directly, drag one element onto another, or open an element's context menu. Give the [N] from your most recent computer_snapshot; the element's position is re-read at the moment of acting. The user is asked to approve the first action against each app. Realm never types into password fields — hand those to the user.",
    inputSchema: {
      type: "object",
      properties: {
        snapshotId: { type: "string", description: "from the computer_snapshot you are acting on" },
        action: {
          type: "object",
          description:
            "One action. kind: click {index|x+y, button?, clickCount?, modifiers?} | type {index?, text} | key {index?, key} | scroll {index?, dx?, dy?} | setValue {index, text} | drag {index, toIndex} | menu {index}. Omitting index on type/key/scroll means the app's current focus.",
          properties: {
            kind: { type: "string", enum: ["click", "type", "key", "scroll", "setValue", "drag", "menu"] },
            index: { type: "number", description: "element index from computer_snapshot" },
            toIndex: { type: "number", description: "the drop target, for kind=drag" },
            x: { type: "number" },
            y: { type: "number" },
            button: { type: "string", enum: ["left", "right", "middle"] },
            clickCount: { type: "number", description: "2 for a double-click, 3 for a triple" },
            modifiers: { type: "array", items: { type: "string", enum: ["command", "control", "option", "shift", "function"] } },
            text: { type: "string" },
            key: { type: "string", description: 'a key chord: modifiers joined with "+" then a single character or a named key, e.g. "cmd+c", "shift+Tab", "Return", "Escape", "pagedown"' },
            dx: { type: "number" },
            dy: { type: "number", description: "pixels; negative scrolls the content up" },
          },
          required: ["kind"],
        },
      },
      required: ["snapshotId", "action"],
      additionalProperties: false,
    },
  },
];

/* ---------------------------------- arg schemas ---------------------------------- */

const SnapshotArgs = z.object({ bundleId: z.string().min(1).optional(), screenshot: z.boolean().default(false) });
const ActArgs = z.object({ snapshotId: z.string().min(1), action: ComputerActionSchema });

/* ---------------------------------- handlers ---------------------------------- */

type Deps = ComputerAgentToolsDeps & { snapshots: SnapshotOwners };
type Handler = (d: Deps, ctx: ProviderCallContext, args: unknown) => Promise<CallToolResult>;

const HANDLERS: Record<string, Handler> = {
  computer_list_apps: async (d) => {
    const result = (await d.bridge.call("computerListApps", {})) as ComputerAppsResult;
    if (!result.accessibility) return err(NO_ACCESSIBILITY);
    if (result.apps.length === 0) return ok("No driveable applications are running.");
    // App names come from macOS's own bundle metadata rather than from a document, but they are
    // still text this process did not author — clipped, and not spoken as Realm's own words.
    const lines = result.apps.map((a) => `${a.bundleId} — ${clip(a.name, 60)}${a.frontmost ? " (frontmost)" : ""}${a.hidden ? " (hidden)" : ""}`);
    const screen = result.screenRecording ? "" : "\n\nScreen Recording is not granted, so computer_snapshot cannot return images. The accessibility tree — which is what you act on — works without it.";
    return ok(`Applications on this Mac:\n${lines.join("\n")}${screen}`);
  },

  computer_snapshot: async (d, ctx, rawArgs) => {
    const args = parse(SnapshotArgs, rawArgs);
    if ("error" in args) return args.error;
    const grants = (await d.bridge.call("computerGrants", {})) as ComputerGrants;
    if (!grants.accessibility) return err(NO_ACCESSIBILITY);

    const snap = (await d.bridge.call("computerSnapshot", {
      ...(args.value.bundleId ? { bundleId: args.value.bundleId } : {}),
      screenshot: args.value.screenshot,
    })) as ComputerSnapshotResult;
    d.snapshots.remember(ctx.sessionId, snap.snapshotId, { bundleId: snap.bundleId, appName: snap.appName });

    const head = [
      `Snapshot ${snap.snapshotId} of ${clip(snap.appName, 60)} (${snap.bundleId}) — ${snap.elements.length} element(s).`,
      snap.truncated ? "The tree was larger than the budget, so this is the first part of it: scroll or narrow what you are looking at rather than assuming an element is absent." : "",
      "Act with computer_act using this snapshotId and an element's [N].",
    ].filter(Boolean).join(" ");
    // Everything below is other applications' content. It is fenced for the same reason page text
    // is: an agent reading a mail window must not act on instructions it finds in the mail.
    const content: CallToolResult["content"] = [{ type: "text", text: `${head}\n${fenceUntrusted(snap.text || "(no addressable elements)")}` }];
    if (snap.screenshot) content.push({ type: "image", data: snap.screenshot, mimeType: "image/jpeg" });
    else if (args.value.screenshot) content.push({ type: "text", text: "(no image: Screen Recording is not granted for Realm)" });
    return { content, isError: false };
  },

  computer_act: async (d, ctx, rawArgs) => {
    const args = parse(ActArgs, rawArgs);
    if ("error" in args) return args.error;
    const { snapshotId, action } = args.value;

    // The session may only act on a snapshot it took. This is what makes the card able to name the
    // app; it also means a snapshot id from somewhere else drives nothing.
    const app = d.snapshots.lookup(ctx.sessionId, snapshotId);
    if (!app) {
      return err(`refused: this session has no snapshot "${snapshotId}". Take a computer_snapshot and act on the id it returns.`);
    }

    const title = describeAct(action, app.appName);
    // Keyed on the bundle id, not the tool: "the user said this session may drive TextEdit" must not
    // read as "may drive anything". `promptUnderBypass` keeps that true in bypassPermissions too —
    // see the safety model above.
    const gate = await d.broker.gate(
      ctx.sessionId, `computer_act:${app.bundleId}`, title,
      { app: app.appName, bundleId: app.bundleId, action },
      "computer_act", { promptUnderBypass: true },
    );
    if (!gate.allowed) return err(gate.reason);

    const result = (await d.bridge.call("computerAct", { snapshotId, action })) as ComputerActResult;
    if (result.ok) return ok(result.detail);
    if (result.refused === "secure_field") {
      return err("refused: that is a password field. Realm never types into one, in any mode — tell the user what to enter and let them type it themselves.");
    }
    if (result.refused === "forbidden_app") {
      return err("refused: that application can never be driven. Realm will not drive itself, System Settings, a password prompt, or a terminal — no permission lifts this.");
    }
    if (result.refused === "stale_snapshot" || result.refused === "no_element") {
      return err(`${result.error}. Take a fresh computer_snapshot: the app has changed since the one you are holding.`);
    }
    if (result.refused === "occluded" || result.refused === "not_frontmost") {
      return err(`${result.error}. Nothing was clicked. Ask the user to bring the app forward, or try again once it is.`);
    }
    return err(result.error);
  },
};

/* ---------------------------------- helpers ---------------------------------- */

const NO_ACCESSIBILITY =
  "macOS has not granted Realm the Accessibility permission, so it cannot read or drive other applications. The user grants it in Realm's Settings, under Permissions — it needs a real click from them and cannot be turned on from here.";

/**
 * Which session owns which snapshot, and which app it describes.
 *
 * Bounded by insertion order rather than by session lifetime: the helper itself keeps only the newest
 * snapshot per app, so an entry evicted here was almost certainly already dead over there, and both
 * sides refuse the same way — "take a fresh snapshot". A cap avoids growing this for the life of the
 * process on a session that snapshots in a loop.
 */
const MAX_REMEMBERED_SNAPSHOTS = 256;

class SnapshotOwners {
  private readonly byKey = new Map<string, { bundleId: string; appName: string }>();

  remember(sessionId: string, snapshotId: string, app: { bundleId: string; appName: string }): void {
    this.byKey.set(key(sessionId, snapshotId), app);
    while (this.byKey.size > MAX_REMEMBERED_SNAPSHOTS) {
      const oldest = this.byKey.keys().next();
      if (oldest.done) break;
      this.byKey.delete(oldest.value);
    }
  }

  lookup(sessionId: string, snapshotId: string): { bundleId: string; appName: string } | null {
    return this.byKey.get(key(sessionId, snapshotId)) ?? null;
  }
}

/** `\0` cannot occur in either id, so no pair of ids can collide by concatenation. */
const key = (sessionId: string, snapshotId: string): string => `${sessionId} ${snapshotId}`;

/**
 * The permission card's line. It names the app — which is the decision the user is actually making —
 * and what is about to happen to it.
 *
 * Typed text is shown, and clipped: the user approving "type into Mail" deserves to know what. It is
 * the AGENT's text, not the app's, so it needs no attribution; the app's own labels are not used here
 * at all, which is why nothing on this card can be influenced by what is on screen.
 */
function describeAct(action: ComputerAction, appName: string): string {
  const where = clip(appName || "an app on this Mac", 40);
  switch (action.kind) {
    case "click": {
      const what = action.clickCount === 2 ? "Double-click" : action.clickCount === 3 ? "Triple-click" : action.button === "right" ? "Right-click" : "Click";
      return `${what} in ${where}`;
    }
    case "type": return `Type "${clip(action.text, 60)}" into ${where}`;
    case "key": return `Press ${clip(action.key, 30)} in ${where}`;
    case "scroll": return `Scroll in ${where}`;
    case "setValue": return `Set a field in ${where} to "${clip(action.text, 60)}"`;
    case "drag": return `Drag one element onto another in ${where}`;
    case "menu": return `Open a context menu in ${where}`;
  }
}

function parse<S extends z.ZodTypeAny>(schema: S, raw: unknown): { value: z.infer<S> } | { error: CallToolResult } {
  const r = schema.safeParse(raw);
  return r.success ? { value: r.data } : { error: err(`invalid arguments: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`) };
}
