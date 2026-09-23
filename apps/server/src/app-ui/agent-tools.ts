import { z } from "zod";
import { BrowserActionSchema, type BrowserActResult, type BrowserSnapshotResult } from "@realm/contracts";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProviderCallContext, RealmToolProvider } from "../mcp/gateway";
import { err, ok, parseArgs } from "../mcp/tool-result";
import type { McpService } from "../mcp/service";
import type { BrowserHostBridge } from "../browsers/host-bridge";
import type { BrowserPermissionBroker } from "../browsers/permissions";

export const APP_PROVIDER_NAME = "realm-app";

/**
 * The `realm-app` gateway provider: Realm's own interface, as something an agent can read and press.
 *
 * ## The case against this, stated first
 *
 * An agent reaching Realm's RPC can create a space, set a model, change a permission mode and open a
 * pane directly. Clicking the buttons that do those things is slower, more fragile, and — this is
 * the part that matters — reaches things RPC deliberately does not expose, because every approval in
 * Realm ends up as a button in this window. A tool that can press buttons can press those.
 *
 * So the provider exists for the work that genuinely has no other door: seeing what the user is
 * looking at, reproducing something in the running app, and driving a screen that has no RPC behind
 * it. It is not the way to do something the app already has a method for, and its description says
 * so, because an agent that reaches for a click when a tool exists has chosen the fragile route.
 *
 * ## Why it is off until a space asks
 *
 * `realm-computer` is the precedent and the reasoning transfers exactly: it is "the one provider a
 * space has to switch ON" because it reaches every app on the Mac. This one reaches the app the user
 * is reading, in the window where they answer questions. Default-on would mean every space that
 * exists today silently gained it.
 *
 * ## The refusals
 *
 *   - **Realm's own granting surfaces** are refused in main, against the live DOM, in every mode —
 *     the permission card and the bypass confirmation carry `NO_AGENT_ATTR`. `app-drive.ts` holds
 *     the reasoning; the refusal arrives here as `realm_protected` and is turned into a sentence
 *     that tells the agent to ask rather than retry.
 *   - **Every act is gated** through the session's normal permission flow, and keyed on the tool
 *     rather than on anything finer. There is no "this button but not that one" to key on: the
 *     window is one surface, and a grant for part of it is a grant for the whole of it. Saying so
 *     plainly is better than a key that implies a bound it cannot hold.
 *
 * The snapshot is Realm's own interface rather than a web page, so it is NOT fenced as untrusted:
 * it is this app's text, rendered from this app's state, in the user's own session. Fencing it would
 * teach an agent to distrust the one surface it can trust, and `fenceUntrusted` means something
 * precise — that a third party wrote this — which is not true here.
 */
export type AppUiToolsDeps = {
  mcp: Pick<McpService, "providerEnabled">;
  bridge: Pick<BrowserHostBridge, "call">;
  broker: Pick<BrowserPermissionBroker, "gate">;
};

export function createAppUiProvider(d: AppUiToolsDeps): RealmToolProvider {
  return {
    name: APP_PROVIDER_NAME,
    async tools(ctx: ProviderCallContext): Promise<Tool[]> {
      if (!d.mcp.providerEnabled(ctx.spaceId, APP_PROVIDER_NAME)) return [];
      return TOOLS;
    },
    async call(ctx: ProviderCallContext, tool: string, args: unknown): Promise<CallToolResult> {
      if (!d.mcp.providerEnabled(ctx.spaceId, APP_PROVIDER_NAME))
        return err(`the ${APP_PROVIDER_NAME} tools are disabled for this space — mcp.setProviderEnabled turns them back on.`);
      const handler = HANDLERS[tool];
      if (!handler) return err(`unknown tool "${tool}" — this provider has: ${TOOLS.map((t) => t.name).join(", ")}`);
      try {
        return await handler(d, ctx, args ?? {});
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

const TOOLS: Tool[] = [
  {
    name: "app_snapshot",
    description:
      "Read Realm's OWN interface — the window the user is looking at — as a list of elements, each with a [ref=N] for app_act. Use it to see what is on their screen, or to check that something you changed actually renders. It is not the way to perform an action Realm has a tool or setting for: those are direct, and a click is a guess about layout. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "app_act",
    description:
      "Click, type, press a key or scroll in Realm's own window, addressing an element by the [ref=N] app_snapshot gave you. Snapshot first, act, then snapshot again to confirm what changed. Realm refuses — in every permission mode — any element inside its own permission card or permission-mode confirmation: it will not let you approve your own request. Asks the user for permission.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "object",
          description: "one action: {kind:'click',ref} · {kind:'type',ref,text} · {kind:'key',key,ref?} · {kind:'scroll',deltaY?,deltaX?,ref?}",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];

type Handler = (d: AppUiToolsDeps, ctx: ProviderCallContext, args: unknown) => Promise<CallToolResult>;

const HANDLERS: Record<string, Handler> = {
  app_snapshot: async (d) => {
    const snap = (await d.bridge.call("appSnapshot", {})) as BrowserSnapshotResult;
    const head = `Realm's own interface (${snap.elementCount} element${snap.elementCount === 1 ? "" : "s"}):`;
    return ok(`${head}\n${snap.text}`);
  },

  app_act: async (d, ctx, raw) => {
    const args = parseArgs(z.object({ action: BrowserActionSchema }), raw);
    if ("error" in args) return args.error;
    const title = describe(args.value.action);
    /* Keyed on the tool, not on the element. The window is one surface — a grant for a click in it
       is a grant for a click anywhere in it, because the refs come from a snapshot the agent takes
       itself and nothing holds one still. A finer key would imply a bound this cannot hold. */
    const gate = await d.broker.gate(ctx.sessionId, "app_act", title, { action: args.value.action }, "app_act");
    if (!gate.allowed) return err(gate.reason);

    /* No `driving` broadcast, unlike the browser and terminal tools, and the asymmetry is the point:
       those two mark a pane from the renderer because the thing being driven is one pane inside a
       window nobody is otherwise touching. Here the thing being driven IS the window, and `markAct`
       has already drawn the frame — and the agent cursor with it — into this very document. A
       renderer overlay beside that would be a second frame saying the same thing. */
    const result = (await d.bridge.call("appAct", { action: args.value.action })) as BrowserActResult;
    if (result.ok) return ok(result.detail);
    // The one refusal that is a hard block rather than a failure, and it must not read as something
    // to retry differently: there is no way to press that button from here.
    if (result.refused === "realm_protected") return err(`refused: ${result.error}`);
    return err(result.error);
  },
};

/** What the permission card says. The element is named by its ref rather than by a label, because
 *  the label would be Realm's own interface text quoted back at the user who is reading it on
 *  screen — the ref is what actually distinguishes one click from another here. */
function describe(action: z.infer<typeof BrowserActionSchema>): string {
  switch (action.kind) {
    case "click": return `Click element ${action.ref} in Realm's own window`;
    case "type": return `Type into element ${action.ref} in Realm's own window`;
    case "key": return `Press ${action.key} in Realm's own window`;
    case "scroll": return "Scroll Realm's own window";
  }
}
