import { z } from "zod";
import {
  COMPUTER_FORBIDDEN_BUNDLE_IDS, COMPUTER_KEY_NAMES, COMPUTER_MODIFIERS, COMPUTER_PROVIDER_NAME, ComputerActionSchema, fenceUntrusted,
  type ComputerAction, type ComputerActResult, type ComputerAppsResult, type ComputerElement, type ComputerSnapshotResult,
} from "@realm/contracts";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProviderCallContext, RealmToolProvider } from "../mcp/gateway";
import { clip, err, ok, parseArgs } from "../mcp/tool-result";
import type { McpService } from "../mcp/service";
import type { BrowserHostBridge } from "../browsers/host-bridge";
import type { BrowserPermissionBroker } from "../browsers/permissions";
import type { ComputerAppAllowlist } from "./allowlist";
import type { ActObservation, ActObserver, ObservedElement } from "../mcp/act-observer";
import type { LayaAssist } from "../laya/assist";
import { plainRole } from "../laya/shadow";
import { runPath, type ExecIO, type ExecResult, type ExecStopReason, type WalkTree } from "../simulators/executor";

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
 *  5. **A permission card per application** — and `bypassPermissions` does NOT skip it
 *     (`promptUnderBypass`). That mode means "stop asking about ordinary actions", and it earns that
 *     meaning from the blast radius being a page in Realm's own pane. Approving TextEdit must not
 *     license Mail, so the grant is keyed on the bundle id. Answering "always" writes the app to the
 *     space's allowlist (`allowlist.ts`), which is what the card is asked once per app instead of
 *     once per app per session forever; the user curates and revokes that list in the space's
 *     settings. It cannot hold a forbidden app, and layer 3 is checked before it is read.
 *  6. **Two independent checks before any synthetic input lands**, both in the helper: the target app
 *     must actually come to the front, and the point must belong to it at the instant of the click.
 *  7. **It is visible while it happens.** Main puts an item in the menu bar for the duration of
 *     every act (`computer-driving.ts`). Not a gate — nothing is refused by it — but the act itself
 *     requires the target app to be frontmost, so this is the only layer the user can see at the
 *     moment it runs, Realm's own window being behind something by then.
 *  8. **App text is untrusted data.** A snapshot is other applications' content — an email body, a
 *     document, a web page inside someone else's browser — so it is fenced before it enters a tool
 *     result, and where a permission card names an element the label is attributed to the app rather
 *     than spoken in Realm's voice.
 *
 * What this model does NOT have, stated plainly: any bound on WHAT may be done to an app once the
 * app itself is approved. A grant is per application, not per action — an allowlisted TextEdit may
 * be typed into as well as clicked, and the only per-action refusals are the hard ones in layer 3.
 */
export type ComputerAgentToolsDeps = {
  mcp: Pick<McpService, "providerEnabled">;
  bridge: Pick<BrowserHostBridge, "call">;
  broker: Pick<BrowserPermissionBroker, "gate">;
  allowlist: Pick<ComputerAppAllowlist, "allows" | "add">;
  /**
   * Told about every act that got past the permission gate, just before it runs — the Laya shadow
   * (`laya/shadow.ts`) in the real server, nothing in most tests. It hears the step and never answers
   * it: the act goes ahead whatever it does, and it is never waited on. Given one, the provider also
   * keeps the elements of each app's latest snapshot, since those are what the agent chose from.
   */
  observe?: ActObserver;
  /** Laya's Assist: a click on an element the agent describes, resolved against the snapshot it is
   *  holding, on the same terms as the simulator's (`laya/assist.ts`). Absent or locked, a described
   *  target is refused with what to do instead. */
  assist?: LayaAssist;
};

export function createComputerAgentProvider(d: ComputerAgentToolsDeps): RealmToolProvider {
  // snapshotId → the app it belongs to, scoped to the session that took it.
  //
  // The server needs this for two things it cannot get any other way: naming the app on the
  // permission card, and keying the grant per app. It also gives a real property — a session can
  // only act on a snapshot it took, so an id that leaked into a transcript or was guessed is
  // refused rather than driving whatever it happens to match.
  const snapshots = new SnapshotOwners();
  const trees = new SnapshotTrees();
  return {
    name: COMPUTER_PROVIDER_NAME,
    async tools(ctx: ProviderCallContext): Promise<Tool[]> {
      if (!d.mcp.providerEnabled(ctx.spaceId, COMPUTER_PROVIDER_NAME)) return [];
      // The `target` field only while Assist can act on it — never a field whose every use is refused.
      return d.assist?.gate().available ? TOOLS.map(withComputerTarget) : TOOLS;
    },
    async call(ctx: ProviderCallContext, tool: string, args: unknown): Promise<CallToolResult> {
      if (!d.mcp.providerEnabled(ctx.spaceId, COMPUTER_PROVIDER_NAME)) {
        return err(`computer control is off for this space. The user turns it on under the space's MCP settings, next to Realm's other built-in tools — it is off by default because it reaches every app on the Mac.`);
      }
      const handler = HANDLERS[tool];
      if (!handler) return err(`unknown tool "${tool}" — this provider has: ${TOOLS.map((t) => t.name).join(", ")}`);
      try {
        return await handler({ ...d, snapshots, trees }, ctx, args ?? {});
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
            modifiers: { type: "array", items: { type: "string", enum: [...COMPUTER_MODIFIERS] } },
            text: { type: "string" },
            key: { type: "string", description: `a key chord: modifiers joined with "+" then a single character or a named key, e.g. "cmd+c" or "shift+Tab". Named keys: ${[...COMPUTER_KEY_NAMES].join(", ")}` },
            dx: { type: "number" },
            dy: { type: "number", description: "vertical scroll amount in pixels" },
          },
          required: ["kind"],
        },
        intent: { type: "string", description: "what this step is for, in a few words — e.g. \"open the Wi-Fi settings\"" },
      },
      required: ["snapshotId", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "computer_do",
    description:
      'Get something done in a Mac app in one call: give the labels to click, in order, as the app shows them — ["File", "Export as PDF…"] — and Realm clicks each one on the app\'s live accessibility tree, waiting for the app to answer before the next. Much faster than a snapshot and an action for every step. With text, the text is typed at the end into the field the walk ended on or the only field there is. It stops rather than guesses — at a label it cannot find, a click that changed nothing, or any step that buys, deletes, sends, signs out or asks for a password, which you take yourself by [N] — and says where and why. Returns a snapshot of where it ended, with the snapshotId computer_act takes. The user is asked to approve the first action against each app, as for computer_act.',
    inputSchema: {
      type: "object",
      properties: {
        bundleId: { type: "string", description: "the app's bundle id from computer_list_apps" },
        intent: { type: "string", description: "what the walk is for, in a few words — the user sees it with the step" },
        path: { type: "array", items: { type: "string" }, description: 'the labels to click, in order, as the app shows them — ["Format", "Font", "Bold"]. Up to 12.' },
        text: { type: "string", description: "text to type once the walk is done, into the field it ended on or the only field there is" },
        until: { type: "string", description: "a label the final snapshot must show for the walk to count as done" },
      },
      required: ["bundleId", "intent"],
      additionalProperties: false,
    },
  },
];

/* ---------------------------------- arg schemas ---------------------------------- */

const SnapshotArgs = z.object({ bundleId: z.string().min(1).optional(), screenshot: z.boolean().default(false) });
/** `intent` is optional where the simulator's input tools require it: required, it would turn every
 *  call from an agent that has not learned the field into a refusal — a change to the act path in
 *  the name of a feature that promises never to touch it. It is the goal Laya's `target` question is
 *  asked against, so a step without one is logged without that question. */
const ActArgs = z.object({
  snapshotId: z.string().min(1), action: ComputerActionSchema, intent: z.string().optional(),
  /** Assist: the element in words, for a click that names no index or point. */
  target: z.string().trim().min(1).max(200).optional(),
});

/** A walk's longest path, and a label's longest words — as for simulator_do. */
const MAX_PATH = 12;
const MAX_LABEL = 120;
const DoArgs = z.object({
  bundleId: z.string().trim().min(1).max(256),
  intent: z.string().trim().min(1, 'intent says in a few words what the walk is for, such as "export the note as a PDF"').max(200),
  path: z.array(z.string().trim().min(1).max(MAX_PATH * (MAX_LABEL + 3))).max(MAX_PATH, `a path is at most ${MAX_PATH} steps — walk the first part, then the rest`).default([]),
  text: z.string().min(1).max(1_000).optional(),
  until: z.string().trim().min(1).max(MAX_LABEL).optional(),
}).refine((a) => a.path.length > 0 || a.text !== undefined, { message: "give a path to walk or text to type", path: ["path"] });

/* ---------------------------------- handlers ---------------------------------- */

type Deps = ComputerAgentToolsDeps & { snapshots: SnapshotOwners; trees: SnapshotTrees };
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
    const args = parseArgs(SnapshotArgs, rawArgs);
    if ("error" in args) return args.error;
    // No grant pre-check: the helper refuses an ungranted snapshot itself, with the same advice, and
    // it has to — it is the only side that can see the trust state at the moment of the walk. Asking
    // first would be a second round-trip to restate what the answer already carries.
    const snap = (await d.bridge.call("computerSnapshot", {
      ...(args.value.bundleId ? { bundleId: args.value.bundleId } : {}),
      screenshot: args.value.screenshot,
    })) as ComputerSnapshotResult;
    d.snapshots.remember(ctx.sessionId, snap.snapshotId, { bundleId: snap.bundleId, appName: snap.appName });
    // Kept for the observer and for Assist: both read what the agent was shown, never a re-read.
    if (d.observe || d.assist) d.trees.remember(ctx.sessionId, snap.bundleId, snap.snapshotId, snap.elements.map(observed));

    const head = [
      `Snapshot ${snap.snapshotId} of ${clip(snap.appName, 60)} (${snap.bundleId}) — ${snap.elements.length} element(s).`,
      snap.truncated ? "The tree was larger than the budget, so this is the first part of it: scroll or narrow what you are looking at rather than assuming an element is absent." : "",
      "Act with computer_act using this snapshotId and an element's [N].",
    ].filter(Boolean).join(" ");
    // Everything below is other applications' content. It is fenced for the same reason page text
    // is: an agent reading a mail window must not act on instructions it finds in the mail. The
    // subject says so rather than taking the default — the app's own name is deliberately NOT in it,
    // since that name comes from the application being fenced.
    const content: CallToolResult["content"] = [{ type: "text", text: `${head}\n${fenceUntrusted(snap.text || "(no addressable elements)", "ANOTHER APPLICATION'S WINDOW CONTENT")}` }];
    if (snap.screenshot) content.push({ type: "image", data: snap.screenshot, mimeType: "image/jpeg" });
    else if (args.value.screenshot) content.push({ type: "text", text: "(no image: Screen Recording is not granted for Realm)" });
    return { content, isError: false };
  },

  computer_act: async (d, ctx, rawArgs) => {
    const args = parseArgs(ActArgs, rawArgs);
    if ("error" in args) return args.error;
    const { snapshotId } = args.value;
    let action = args.value.action;

    // The session may only act on a snapshot it took. This is what makes the card able to name the
    // app; it also means a snapshot id from somewhere else drives nothing.
    const app = d.snapshots.lookup(ctx.sessionId, snapshotId);
    if (!app) {
      return err(`refused: this session has no snapshot "${snapshotId}". Take a computer_snapshot and act on the id it returns.`);
    }

    // Before the allowlist is read and before a card can be raised: a forbidden app must not reach a
    // prompt that could be answered "always", which would then be a stored approval for something no
    // approval covers. The helper refuses again in the last process before an event is posted — this
    // copy is about what the user is asked, not about what is finally allowed.
    if ((COMPUTER_FORBIDDEN_BUNDLE_IDS as readonly string[]).includes(app.bundleId)) return err(FORBIDDEN_REFUSAL);

    /* Assist: a click the agent DESCRIBED. Resolved against the snapshot it is holding — the helper
       re-resolves the index against the live element at act time, as for any index — and BEFORE the
       card, so the card names what Laya picked. Unsure, sensitive or unanswered is nothing clicked and
       this snapshot's own indices handed back. */
    let pickedBy: { words: string; confidence: number; threshold: number } | null = null;
    if (args.value.target !== undefined) {
      const words = clip(args.value.target, 80);
      const gate = d.assist?.gate();
      if (!d.assist || !gate?.available) {
        return err(`a target in words needs Laya's Assist, which is not on here (${gate?.reason ?? "Laya is not part of this Realm"}). Use an element's [N] from computer_snapshot.`);
      }
      if (action.kind !== "click" || action.index !== undefined || action.x !== undefined || action.y !== undefined) {
        return err("a target in words is for a click that names no index and no point — give one of the three, not two.");
      }
      const elements = d.trees.lookup(ctx.sessionId, app.bundleId, snapshotId);
      const outcome = await d.assist.resolve(args.value.target, args.value.intent ?? args.value.target, elements, "computer_act");
      if (outcome.kind !== "pick") {
        const line = (e: ObservedElement) => `[${e.id}] ${e.label.trim() ? `"${clip(e.label.trim(), 60)}"` : "(no name)"}`;
        const why = outcome.why === "sensitive"
          ? `"${words}" looks like a step Laya never chooses on its own (it reads as "${outcome.matched ?? "sensitive"}")${outcome.best ? `; its pick was ${line(outcome.best.element)}` : ""}. If that is the step you mean, click it by its [N].`
          : outcome.why === "unsure"
            ? `Laya was not sure which element "${words}" means${outcome.best ? ` — its best guess, ${line(outcome.best.element)}, scored ${outcome.best.confidence.toFixed(2)}` : ""}, and Assist acts only at ${gate.threshold!.toFixed(2)} or above.`
            : outcome.why === "no-candidates" ? `nothing in this snapshot looks like "${words}".` : "Laya did not answer in time.";
        const list = outcome.candidates.slice(0, 8).map(line).join("; ");
        return err(`nothing was clicked: ${why}${list ? ` The likeliest in snapshot ${snapshotId}: ${list}. Click one by its [N] with this snapshotId.` : ""}`);
      }
      action = { ...action, index: Number(outcome.element.id) };
      pickedBy = { words, confidence: outcome.confidence, threshold: gate.threshold! };
    }

    const title = describeAct(action, app.appName);
    // Keyed on the bundle id, not the tool: "the user said this session may drive TextEdit" must not
    // read as "may drive anything". `promptUnderBypass` keeps that true in bypassPermissions too —
    // see the safety model above.
    const gate = await d.broker.gate(
      ctx.sessionId, `computer_act:${app.bundleId}`, title,
      { app: app.appName, bundleId: app.bundleId, action },
      "computer_act",
      {
        promptUnderBypass: true,
        preapproved: d.allowlist.allows(ctx.spaceId, app.bundleId),
        onAlwaysAllow: () => d.allowlist.add(ctx.spaceId, app.bundleId),
      },
    );
    if (!gate.allowed) return err(gate.reason);

    // After the gate, so only a step that is really about to happen is reported; before the act, so
    // what is reported is what the agent chose from. The observer's return — a callback for the
    // screen after the act — is dropped: this tool does not re-read the screen, and reading it here
    // would replace the snapshot the agent is holding.
    if (d.observe) {
      const elements = d.trees.lookup(ctx.sessionId, app.bundleId, snapshotId);
      try {
        d.observe({
          surface: "computer", spaceId: ctx.spaceId, sessionId: ctx.sessionId, tool: "computer_act",
          intent: args.value.intent ?? "", elements, chosen: chosenOf(action, elements),
          ...(pickedBy ? { chosenBy: "laya" as const } : {}),
        });
      } catch { /* an observer never changes an act */ }
    }

    // `appName` is for main's menu-bar indicator, which has no other way to learn which application
    // is being driven — the snapshot-to-app map that answers that lives in this process.
    const result = (await d.bridge.call("computerAct", { snapshotId, action, appName: app.appName })) as ComputerActResult;
    if (result.ok) {
      return ok(pickedBy
        ? `${result.detail} — Laya's pick for "${pickedBy.words}" (${pickedBy.confidence.toFixed(2)}; Assist acts at ${pickedBy.threshold.toFixed(2)} or above).`
        : result.detail);
    }
    if (result.refused === "secure_field") {
      return err("refused: that is a password field. Realm never types into one, in any mode — tell the user what to enter and let them type it themselves.");
    }
    if (result.refused === "forbidden_app") return err(FORBIDDEN_REFUSAL);
    if (result.refused === "stale_snapshot" || result.refused === "no_element") {
      return err(`${result.error}. Take a fresh computer_snapshot: the app has changed since the one you are holding.`);
    }
    if (result.refused === "occluded" || result.refused === "not_frontmost") {
      return err(`${result.error}. Nothing was clicked. Ask the user to bring the app forward, or try again once it is.`);
    }
    return err(result.error);
  },

  /**
   * A walk: the labels to click, in order, carried out here on the app's live tree
   * (`simulators/executor.ts`), one snapshot a look, one card for the app. It never scrolls to find a
   * label — the Mac's helper scrolls at a point, and which list a label is in is the agent's to say —
   * so a walk is for what is on screen as it goes: menus, sidebars, toolbars, sheets, buttons.
   */
  computer_do: async (d, ctx, rawArgs) => {
    const args = parseArgs(DoArgs, rawArgs);
    if ("error" in args) return args.error;
    const a = args.value;
    const path = a.path.flatMap((p) => p.split("›").map((part) => part.trim()).filter(Boolean));
    if (path.length > MAX_PATH) return err(`a path is at most ${MAX_PATH} steps — walk the first part, then the rest.`);
    const long = path.find((label) => label.length > MAX_LABEL);
    if (long) return err(`"${clip(long, 40)}" is not a label — a label is a few words, ${MAX_LABEL} characters at most.`);
    // Before any snapshot or card, as for computer_act: a forbidden app reaches no prompt at all.
    if ((COMPUTER_FORBIDDEN_BUNDLE_IDS as readonly string[]).includes(a.bundleId)) return err(FORBIDDEN_REFUSAL);

    // The first look names the app on the card and is the tree the walk starts from.
    const first = await look(d, ctx, a.bundleId);
    const steps = path.length > 0 ? path.map((l) => `"${clip(l, 30)}"`).join(" › ") : "";
    const title = `${steps ? `Click ${steps}` : ""}${steps && a.text !== undefined ? ", then type" : a.text !== undefined ? `Type "${clip(a.text, 40)}"` : ""} in ${clip(first.appName || "an app on this Mac", 40)}`;
    const gate = await d.broker.gate(
      ctx.sessionId, `computer_act:${first.bundleId}`, title,
      { app: first.appName, bundleId: first.bundleId, intent: a.intent, path, ...(a.text !== undefined ? { text: a.text } : {}) },
      "computer_do",
      { promptUnderBypass: true, preapproved: d.allowlist.allows(ctx.spaceId, first.bundleId), onAlwaysAllow: () => d.allowlist.add(ctx.spaceId, first.bundleId) },
    );
    if (!gate.allowed) return err(gate.reason);

    let latest = first;
    let fresh = true; // the first look is the walk's first read; every read after it is a new snapshot
    const act = async (action: ComputerAction): Promise<{ ok: boolean; detail: string }> => {
      const r = (await d.bridge.call("computerAct", { snapshotId: latest.snapshotId, action, appName: latest.appName })) as ComputerActResult;
      return r.ok ? { ok: true, detail: r.detail } : { ok: false, detail: actRefusal(r) };
    };
    const assist = d.assist;
    const io: ExecIO = {
      read: async () => {
        if (!fresh) latest = await look(d, ctx, a.bundleId);
        fresh = false;
        return walkTree(latest);
      },
      tap: (el) => act({ kind: "click", index: Number(el.path), button: "left", clickCount: 1, modifiers: [] }),
      scroll: async () => ({ ok: false, detail: "a walk in a Mac app does not scroll" }),
      type: (text) => act({ kind: "type", text }),
      ...(assist?.gate().available ? { laya: (label: string, elements: readonly ObservedElement[]) => assist.resolve(label, label, elements, "computer_act") } : {}),
      observe: ({ elements, chosen, by }) => {
        if (!d.observe) return;
        const seen = elements.map((e) => ({ id: e.path, role: e.role, label: e.label, ...(e.value ? { value: e.value } : {}) }));
        try {
          d.observe({
            surface: "computer", spaceId: ctx.spaceId, sessionId: ctx.sessionId, tool: "computer_do", intent: a.intent,
            elements: seen, chosen: { element: seen.find((e) => e.id === chosen.path)! }, ...(by === "laya" ? { chosenBy: "laya" as const } : {}),
          });
        } catch { /* an observer never changes a walk */ }
      },
      now: () => performance.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    const result = await runPath(io, {
      path, maxScrolls: 0, settle: { tapTimeoutMs: 3_000, pollMs: 100 },
      ...(a.text !== undefined ? { text: a.text } : {}),
      ...(a.until !== undefined ? { until: a.until } : {}),
    });
    return macWalked(latest, result);
  },
};

/** One snapshot of an app, remembered as `computer_snapshot` remembers one: this session's to act on. */
async function look(d: Deps, ctx: ProviderCallContext, bundleId: string): Promise<ComputerSnapshotResult> {
  const snap = (await d.bridge.call("computerSnapshot", { bundleId, screenshot: false })) as ComputerSnapshotResult;
  d.snapshots.remember(ctx.sessionId, snap.snapshotId, { bundleId: snap.bundleId, appName: snap.appName });
  if (d.observe || d.assist) d.trees.remember(ctx.sessionId, snap.bundleId, snap.snapshotId, snap.elements.map(observed));
  return snap;
}

/** A snapshot as a walk reads it: each element by its [N], with its subrole when it has one — which
 *  is where the Mac says a text field is a secure one. */
function walkTree(snap: ComputerSnapshotResult): WalkTree {
  return {
    screen: { width: 0, height: 0 }, units: "points", app: snap.appName, screenChecks: false,
    elements: snap.elements.map((e) => ({
      path: String(e.index), label: e.name, value: e.value, role: e.subrole ? `${e.role}/${e.subrole}` : e.role,
      id: null, enabled: e.enabled, frame: { x: e.x, y: e.y, width: e.w, height: e.h }, depth: e.depth, focused: e.focused,
    })),
  };
}

/** What the helper said instead of acting, as the walk reports it. */
function actRefusal(r: Extract<ComputerActResult, { ok: false }>): string {
  if (r.refused === "secure_field") return "that is a password field, and Realm never types into one";
  if (r.refused === "forbidden_app") return "that application can never be driven";
  return r.error;
}

/** What to do after each way a walk stops, in this provider's words. */
const MAC_AFTER_STOP: Record<ExecStopReason, string> = {
  "not-found": "Click one of those by its [N] with computer_act, or walk again with the label as the snapshot below shows it.",
  sensitive: "A walk never takes that kind of step. If it is the step you mean, take it yourself with computer_act by its [N].",
  "no-change": "The snapshot below is what the click left; carry on from it with computer_act, or walk again.",
  "tap-failed": "Nothing further was sent.",
  "not-there": "The snapshot below is where it ended instead.",
  "which-field": "End the path on the field to type into, or type into it with computer_act by its [N].",
};

/**
 * A walk's answer: where it went and how long it took, or where it stopped and why with the likeliest
 * elements by [N] — then the snapshot it ended on, which is this session's latest for the app, so the
 * agent's next computer_act needs no snapshot of its own.
 */
function macWalked(snap: ComputerSnapshotResult, r: ExecResult): CallToolResult {
  const app = clip(snap.appName || snap.bundleId, 60);
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const trail = r.steps.map((s) => {
    if (s.how === "typed") return s.label;
    const words = `"${clip(s.matched.trim() || s.label, 50)}"`;
    return `${words}${s.how === "close" ? ` (for "${clip(s.label, 40)}")` : s.how === "laya" ? ` (Laya's pick for "${clip(s.label, 40)}")` : ""}`;
  }).join(" → ");
  let head: string;
  if (r.stop === null) {
    head = `Walked ${trail} in ${app} in ${secs(r.ms)}.`;
  } else {
    const picks = r.stop.candidates.map((e) => `[${e.path}] ${e.label.trim() ? `"${clip(e.label.trim(), 50)}"` : "(no name)"} ${plainRole(e.role.split("/")[0]!)}`);
    head = `${r.steps.length > 0 ? `Walked ${trail}, then stopped` : "Stopped"} at "${clip(r.stop.label, 60)}" in ${app} after ${secs(r.ms)}: ${r.stop.detail}.`
      + `${picks.length > 0 ? ` The likeliest: ${picks.join("; ")}.` : ""} ${MAC_AFTER_STOP[r.stop.why]}`;
  }
  const body = `Snapshot ${snap.snapshotId} of ${app} (${snap.bundleId}) — ${snap.elements.length} element(s). Act with computer_act using this snapshotId and an element's [N].`;
  return {
    content: [{ type: "text", text: `${head}\n${body}\n${fenceUntrusted(snap.text || "(no addressable elements)", "ANOTHER APPLICATION'S WINDOW CONTENT")}` }],
    isError: r.stop !== null,
  };
}

/* ---------------------------------- helpers ---------------------------------- */

const FORBIDDEN_REFUSAL =
  "refused: that application can never be driven. Realm will not drive itself, System Settings, a password prompt, or a terminal — no permission lifts this, including the space's allowed-apps list.";

const NO_ACCESSIBILITY =
  "macOS has not granted Realm the Accessibility permission, so it cannot read or drive other applications. The user grants it in Realm's Settings, under Permissions — it needs a real click from them and cannot be turned on from here.";

const MAX_REMEMBERED_SNAPSHOTS = 256;

/**
 * Which session owns which snapshot, and which app it describes.
 *
 * Bounded by insertion order rather than by session lifetime: the helper itself keeps only the newest
 * snapshot per app, so an entry evicted here was almost certainly already dead over there, and both
 * sides refuse the same way — "take a fresh snapshot". The cap stops this growing for the life of
 * the process on a session that snapshots in a loop.
 */
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

/** NUL cannot occur in either id, so no pair of them can collide by concatenation. */
const key = (sessionId: string, snapshotId: string): string => `${sessionId}\0${snapshotId}`;

const MAX_REMEMBERED_TREES = 64;

/**
 * The elements of each session's latest snapshot of each app, for the observer — kept only when
 * there is one.
 *
 * The latest per app is all that can matter: the helper keeps only the newest snapshot of an app, so
 * an act on an older one is refused as stale before it could be reported. That bounds this at one
 * tree (at most 500 elements, labels clipped) per session and app, and the LRU cap bounds the
 * sessions.
 */
class SnapshotTrees {
  private readonly byApp = new Map<string, { snapshotId: string; elements: ObservedElement[] }>();

  remember(sessionId: string, bundleId: string, snapshotId: string, elements: ObservedElement[]): void {
    const k = key(sessionId, bundleId);
    this.byApp.delete(k);
    this.byApp.set(k, { snapshotId, elements });
    while (this.byApp.size > MAX_REMEMBERED_TREES) this.byApp.delete(this.byApp.keys().next().value!);
  }

  lookup(sessionId: string, bundleId: string, snapshotId: string): ObservedElement[] {
    const tree = this.byApp.get(key(sessionId, bundleId));
    return tree && tree.snapshotId === snapshotId ? tree.elements : [];
  }
}

/** An element as an observer sees it: its index as the id (the number the agent used), and its text. */
function observed(e: ComputerElement): ObservedElement {
  return { id: String(e.index), role: e.role, label: clip(e.name, 200), ...(e.value ? { value: clip(e.value, 200) } : {}) };
}

/** What the act addressed: the element at its index, the point it names, or nothing (a key, a scroll
 *  or a typed string sent to whatever has focus). A drag names the element it picks up. */
/** computer_act as listed while Assist can act: the same tool, plus a click target in words. */
function withComputerTarget(t: Tool): Tool {
  if (t.name !== "computer_act") return t;
  return { ...t, inputSchema: { ...t.inputSchema, properties: { ...(t.inputSchema.properties ?? {}), target: {
    type: "string",
    description: "for a click that names no index or point: describe the element in a few words, such as \"the Save button\" — Laya, on this Mac, picks it from this snapshot when it is confident enough; otherwise nothing is clicked and you get the likeliest [N]s back",
  } } } };
}

function chosenOf(action: ComputerAction, elements: ObservedElement[]): ActObservation["chosen"] {
  if (action.index !== undefined) {
    const element = elements.find((e) => e.id === String(action.index));
    return element ? { element } : null;
  }
  if (action.kind === "click" && action.x !== undefined && action.y !== undefined) return { point: { x: action.x, y: action.y } };
  return null;
}

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
