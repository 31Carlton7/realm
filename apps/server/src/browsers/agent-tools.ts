import { z } from "zod";
import {
  BROWSER_READ_ONLY_TOOLS, BrowserActionSchema, BrowserReadKindSchema, CREDENTIAL_2FA_NOTE,
  DOWNLOAD_DIRNAME, DOWNLOAD_MAX_BYTES,
  type BrowserAction, type BrowserActResult, type BrowserCredential, type BrowserDescribeResult,
  type BrowserDownloadResult, type BrowserNavigateResult, type BrowserReadResult,
  type BrowserScreenshotResult, type BrowserSnapshotResult, type Browser,
} from "@realm/contracts";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProviderCallContext, RealmToolProvider } from "../mcp/gateway";
import { clip, err, ok, parseArgs } from "../mcp/tool-result";
import type { RpcServer } from "../rpc/server";
import type { BrowsersStore } from "../store/browsers";
import type { McpService } from "../mcp/service";
import type { BrowserService } from "./service";
import type { BrowserHostBridge } from "./host-bridge";
import type { BrowserPermissionBroker } from "./permissions";
import { join } from "node:path";
import type { ProjectsStore } from "../store/projects";
import { fenceUntrusted, isOAuthConsentUrl } from "./guards";

export const BROWSER_PROVIDER_NAME = "realm-browser";

/**
 * The `realm-browser` gateway provider (Plan 11 W3): the agent tool surface over the space's browser
 * panes. Registered on the MCP gateway as an in-process provider, so every agent reaches it through
 * the same `realm` endpoint it already connects to — tools arrive as
 * `realm-browser__browser_snapshot` etc.
 *
 * The permission split, which is the point of this file:
 *   - **Read-only** (`browser_list`, `browser_snapshot`, `browser_read`, `browser_screenshot`) runs
 *     free in every mode.
 *   - **Mutating** (`browser_open`, `browser_navigate`, `browser_act`, a `browser_batch` containing
 *     any mutating action) goes through `BrowserPermissionBroker.gate` — the session's NORMAL
 *     permission flow (ApprovalCard), honoring its permission mode.
 *   - **Hard blocks** are refusals, not prompts, and apply in every mode including
 *     `bypassPermissions`: typing into a password field (detected at act time in the executor, where
 *     the DOM is fresh), agent navigation to an OAuth consent URL (`isOAuthConsentUrl` — a heuristic
 *     with documented limits), and downloads (cancelled at the Electron session level in main).
 *
 * The injection stance: page content is data. Everything a page influenced (snapshot, page text,
 * console, network, titles) is fenced by `fenceUntrusted` before it enters a tool result, and where a
 * permission prompt needs an element's label, the label is explicitly attributed to the page
 * (`the element the page labels …`) rather than laundered into Realm's own voice.
 */
export type BrowserAgentToolsDeps = {
  browsers: Pick<BrowsersStore, "get" | "list">;
  /** Plan 23: resolves a space's project, whose root is the only place a download may land. A space
   *  with no project has no destination and `browser_download` refuses — deliberately, rather than
   *  inventing a Realm-owned directory no other surface shows the user. */
  projects: Pick<ProjectsStore, "list">;
  browserService: Pick<BrowserService, "open">;
  mcp: Pick<McpService, "providerEnabled">;
  bridge: Pick<BrowserHostBridge, "call">;
  broker: Pick<BrowserPermissionBroker, "gate">;
  rpc: Pick<RpcServer, "broadcast">;
  /**
   * Plan 11 W5: per-session mutation constraints — a delegated browser-agent child's
   * `allowedOrigins`/`maxActs` (see `BrowserAgentService.checkMutation`). Consulted before every
   * mutating tool runs (batch steps included), BEFORE the permission gate so the user is never
   * prompted for an action the constraint would refuse anyway. Returns a refusal sentence or null;
   * non-child sessions always pass. Optional — a harness without browser agents behaves as before.
   */
  constraints?: { checkMutation(sessionId: string, tool: string, url?: string): string | null };
};

export function createBrowserAgentProvider(d: BrowserAgentToolsDeps): RealmToolProvider {
  return {
    name: BROWSER_PROVIDER_NAME,
    async tools(ctx: ProviderCallContext): Promise<Tool[]> {
      if (!d.mcp.providerEnabled(ctx.spaceId, BROWSER_PROVIDER_NAME)) return [];
      return TOOLS;
    },
    async call(ctx: ProviderCallContext, tool: string, args: unknown): Promise<CallToolResult> {
      if (!d.mcp.providerEnabled(ctx.spaceId, BROWSER_PROVIDER_NAME))
        return err(`the ${BROWSER_PROVIDER_NAME} tools are disabled for this space — mcp.setProviderEnabled turns them back on.`);
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

/* ---------------------------------- tool definitions ---------------------------------- */

const READ_ONLY_TOOLS = new Set<string>(BROWSER_READ_ONLY_TOOLS);

const TOOLS: Tool[] = [
  {
    name: "browser_list",
    description: "List this space's browser panes (id, url, whether the pane is open in the app). Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_open",
    description: "Open a new browser pane at a URL. Returns its browserId for the other tools. Asks the user for permission.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "http(s) URL to open" } }, required: ["url"], additionalProperties: false },
  },
  {
    name: "browser_navigate",
    description: "Navigate an existing browser pane to a URL. Honors the space's origin allowlist. Asks the user for permission.",
    inputSchema: { type: "object", properties: { browserId: { type: "string" }, url: { type: "string" } }, required: ["browserId", "url"], additionalProperties: false },
  },
  {
    name: "browser_snapshot",
    description: "The primary way to read a page for acting on it: a fused DOM+accessibility snapshot of the visible, interactive elements — each line is one element with a stable [ref=N] to use with browser_act. Elements changed since your previous snapshot are marked [new]. Read-only.",
    inputSchema: { type: "object", properties: { browserId: { type: "string" } }, required: ["browserId"], additionalProperties: false },
  },
  {
    name: "browser_read",
    description: "Read a pane's page text (article-first), console output, or a network request summary. Read-only.",
    inputSchema: { type: "object", properties: { browserId: { type: "string" }, kind: { type: "string", enum: ["text", "console", "network"], description: "what to read (default: text)" } }, required: ["browserId"], additionalProperties: false },
  },
  {
    name: "browser_screenshot",
    description: "Screenshot the pane's current viewport. Prefer browser_snapshot for acting; use this to check visual state. A screenshot is also attached automatically to any failed browser_act. Read-only.",
    inputSchema: { type: "object", properties: { browserId: { type: "string" } }, required: ["browserId"], additionalProperties: false },
  },
  {
    name: "browser_act",
    description: "Act on a page element by its [ref=N] from browser_snapshot: click, type, press a key, or scroll. Coordinates are re-resolved from the ref at act time. Asks the user for permission. Typing into password fields is always refused — hand those to the user.",
    inputSchema: {
      type: "object",
      properties: {
        browserId: { type: "string" },
        action: {
          type: "object",
          description: "One action. kind: click {ref, button?, clickCount?, modifiers?} | type {ref, text, method?: keys|insertText, submit?} | key {key, ref?} | scroll {ref?, deltaX?, deltaY?}",
          properties: {
            kind: { type: "string", enum: ["click", "type", "key", "scroll"] },
            ref: { type: "number", description: "element ref from browser_snapshot" },
            button: { type: "string", enum: ["left", "middle", "right"] },
            clickCount: { type: "number" },
            modifiers: { type: "array", items: { type: "string", enum: ["alt", "ctrl", "meta", "shift"] } },
            text: { type: "string" },
            method: { type: "string", enum: ["keys", "insertText"] },
            submit: { type: "boolean" },
            key: { type: "string", description: "named key for kind=key, e.g. Enter, Tab, Escape" },
            deltaX: { type: "number" },
            deltaY: { type: "number" },
          },
          required: ["kind"],
        },
      },
      required: ["browserId", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_credentials",
    description:
      "List the sign-ins the user has saved in Realm's Settings for this machine: id, origin, username and label. Never returns passwords — Realm cannot give you one. Use an id with browser_fill_credential. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_fill_credential",
    description:
      "Type a saved sign-in into a field, without ever seeing it. Give the [ref=N] of the username or password field and a credentialId from browser_credentials. Realm checks the pane's current origin against the one the credential was saved for and refuses if they differ, asks the user to approve this specific fill, and requires Touch ID — every time. You never receive the value and cannot read it back. Two-factor prompts (Duo, Okta, an emailed code) are not automated: hand those to the user.",
    inputSchema: {
      type: "object",
      properties: {
        browserId: { type: "string" },
        ref: { type: "number", description: "the field's ref from browser_snapshot" },
        credentialId: { type: "string", description: "id from browser_credentials" },
      },
      required: ["browserId", "ref", "credentialId"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_download",
    description:
      `Download the file behind a link or button by its [ref=N], into the space project's ${DOWNLOAD_DIRNAME}/ directory. Asks the user for permission. Only document, image, archive and media types are saved — never anything executable — only from the origin the pane is already on, and only up to ${Math.round(DOWNLOAD_MAX_BYTES / 1024 / 1024)} MB. Returns the project-relative path, which you can then read with your own file tools. Batch this when fetching several files: one prompt covers the batch.`,
    inputSchema: {
      type: "object",
      properties: {
        browserId: { type: "string" },
        ref: { type: "number", description: "ref of the download link or button, from browser_snapshot" },
      },
      required: ["browserId", "ref"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_batch",
    description: "Run several browser tool calls in sequence, stopping at the first failure. Runs without a prompt ONLY when every action is read-only; a batch containing any mutating action asks the user once for the whole batch.",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          minItems: 1, maxItems: 20,
          items: {
            type: "object",
            properties: { tool: { type: "string", description: "one of the realm-browser tools (not browser_batch)" }, arguments: { type: "object" } },
            required: ["tool"],
          },
        },
      },
      required: ["actions"],
      additionalProperties: false,
    },
  },
];

/* ---------------------------------- arg schemas ---------------------------------- */

const OpenArgs = z.object({ url: z.string().min(1) });
const NavigateArgs = z.object({ browserId: z.string().min(1), url: z.string().min(1) });
const BrowserIdArgs = z.object({ browserId: z.string().min(1) });
const ReadArgs = z.object({ browserId: z.string().min(1), kind: BrowserReadKindSchema.default("text") });
const ActArgs = z.object({ browserId: z.string().min(1), action: BrowserActionSchema });
const DownloadArgs = z.object({ browserId: z.string().min(1), ref: z.number().int().positive() });
const FillCredentialArgs = z.object({
  browserId: z.string().min(1),
  ref: z.number().int().positive(),
  credentialId: z.string().min(1),
});
const BatchArgs = z.object({
  actions: z.array(z.object({ tool: z.string().min(1), arguments: z.record(z.unknown()).default({}) })).min(1).max(20),
});

/* ---------------------------------- handlers ---------------------------------- */

type Deps = BrowserAgentToolsDeps;
type Handler = (d: Deps, ctx: ProviderCallContext, args: unknown) => Promise<CallToolResult>;

const HANDLERS: Record<string, Handler> = {
  browser_list: async (d, ctx) => {
    const rows = d.browsers.list(ctx.spaceId);
    if (rows.length === 0) return ok("No browser panes in this space. Use browser_open(url) to open one.");
    const lines = await Promise.all(rows.map(async (row) => {
      const live = await describeSafe(d, row.id);
      const state = live === null ? "app not connected" : live.open ? `open, url: ${live.url || "(blank)"}` : "pane not open in the app";
      return `browserId: ${row.id} — ${state}${row.url && (!live?.open) ? ` (last url: ${row.url})` : ""}`;
    }));
    return ok(`Browser panes in this space:\n${lines.join("\n")}`);
  },

  browser_open: async (d, ctx, rawArgs) => {
    const args = parseArgs(OpenArgs, rawArgs); if ("error" in args) return args.error;
    const url = normalizeToolUrl(args.value.url);
    if (!url) return err(`"${args.value.url}" is not an http(s) URL.`);
    const oauth = refuseOAuth(url); if (oauth) return oauth;
    const limited = d.constraints?.checkMutation(ctx.sessionId, "browser_open", url); if (limited) return err(limited);
    const title = `Open a browser pane at ${url}`;
    const gate = await d.broker.gate(ctx.sessionId, "browser_open", title, { url });
    if (!gate.allowed) return err(gate.reason);
    const opened = d.browserService.open({ spaceId: ctx.spaceId, url });
    d.rpc.broadcast("browser.agentOpened", { spaceId: ctx.spaceId, browserId: opened.browserId, itemId: opened.itemId });
    d.rpc.broadcast("browser.action", { spaceId: ctx.spaceId, browserId: opened.browserId, text: title, ok: true, ts: Date.now() });
    return ok(`Opened browser pane ${opened.browserId} at ${url}. The page renders in the app's pane; use browser_snapshot to read it once loaded.`);
  },

  browser_navigate: async (d, ctx, rawArgs) => {
    const args = parseArgs(NavigateArgs, rawArgs); if ("error" in args) return args.error;
    const row = requireRow(d, ctx, args.value.browserId); if ("error" in row) return row.error;
    const url = normalizeToolUrl(args.value.url);
    if (!url) return err(`"${args.value.url}" is not an http(s) URL.`);
    const oauth = refuseOAuth(url); if (oauth) return oauth;
    const limited = d.constraints?.checkMutation(ctx.sessionId, "browser_navigate", url); if (limited) return err(limited);
    const title = `Navigate the browser pane to ${url}`;
    const gate = await d.broker.gate(ctx.sessionId, "browser_navigate", title, { browserId: row.value.id, url });
    if (!gate.allowed) return err(gate.reason);
    return runTracked(d, ctx.spaceId, row.value.id, title, async () => {
      const result = (await d.bridge.call("navigate", { browserId: row.value.id, url })) as BrowserNavigateResult;
      if (!result.url) return err(`navigation to ${url} was refused — the pane is not open in the app, or the space's origin allowlist blocks that origin.`);
      return ok(`Navigating to ${result.url}. Use browser_snapshot once loaded.`);
    });
  },

  browser_snapshot: async (d, ctx, rawArgs) => {
    const args = parseArgs(BrowserIdArgs, rawArgs); if ("error" in args) return args.error;
    const row = requireRow(d, ctx, args.value.browserId); if ("error" in row) return row.error;
    const snap = (await d.bridge.call("snapshot", { browserId: row.value.id })) as BrowserSnapshotResult;
    const head = `Snapshot of ${snap.url} — ${snap.elementCount} interactive element(s). Lines are "[ref=N] role \\"name\\" …"; changed-since-last-snapshot lines end with [new].`;
    return ok(`${head}\n${fenceUntrusted(`title: ${snap.title}\n${snap.text}`)}`);
  },

  browser_read: async (d, ctx, rawArgs) => {
    const args = parseArgs(ReadArgs, rawArgs); if ("error" in args) return args.error;
    const row = requireRow(d, ctx, args.value.browserId); if ("error" in row) return row.error;
    const result = (await d.bridge.call("read", { browserId: row.value.id, kind: args.value.kind })) as BrowserReadResult;
    return ok(`${args.value.kind} of browser ${row.value.id}:\n${fenceUntrusted(result.text || "(empty)")}`);
  },

  browser_screenshot: async (d, ctx, rawArgs) => {
    const args = parseArgs(BrowserIdArgs, rawArgs); if ("error" in args) return args.error;
    const row = requireRow(d, ctx, args.value.browserId); if ("error" in row) return row.error;
    const shot = (await d.bridge.call("screenshot", { browserId: row.value.id })) as BrowserScreenshotResult;
    return { content: [{ type: "image", data: shot.data, mimeType: shot.mimeType }], isError: false };
  },

  browser_act: async (d, ctx, rawArgs) => {
    const args = parseArgs(ActArgs, rawArgs); if ("error" in args) return args.error;
    const row = requireRow(d, ctx, args.value.browserId); if ("error" in row) return row.error;
    const limited = d.constraints?.checkMutation(ctx.sessionId, "browser_act"); if (limited) return err(limited);
    const title = await describeAct(d, row.value.id, args.value.action);
    const gate = await d.broker.gate(ctx.sessionId, "browser_act", title, { browserId: row.value.id, action: args.value.action });
    if (!gate.allowed) return err(gate.reason);
    return runTracked(d, ctx.spaceId, row.value.id, title, () => runAct(d, row.value.id, args.value.action));
  },

  browser_credentials: async (d, ctx) => {
    const rows = await listCredentials(d);
    if (rows.length === 0) {
      return ok("No saved sign-ins. The user adds them in Realm's Settings → Sign-ins; there is no way for you to create one, and no tool that could.");
    }
    // The user's own words from Settings, not page-authored text, so no `fenceUntrusted` — but still
    // clipped, because a long label in a tool result is a long label in the model's context.
    const lines = rows.map((c) => `credentialId: ${c.id} — ${c.origin}${c.username ? ` · ${c.username}` : ""}${c.label ? ` · ${clip(c.label, 60)}` : ""}`);
    return ok(`Saved sign-ins (no passwords — Realm cannot show you one):\n${lines.join("\n")}\n\n${CREDENTIAL_2FA_NOTE}`);
  },

  browser_fill_credential: async (d, ctx, rawArgs) => {
    const args = parseArgs(FillCredentialArgs, rawArgs); if ("error" in args) return args.error;
    const row = requireRow(d, ctx, args.value.browserId); if ("error" in row) return row.error;
    const limited = d.constraints?.checkMutation(ctx.sessionId, "browser_fill_credential"); if (limited) return err(limited);

    // The card is built from the CREDENTIAL's stored metadata (the user's own words, typed in
    // Settings) and the pane's live URL — never the page's text, and never the value. If the id is
    // unknown, say so now: a prompt for a credential that does not exist teaches nothing.
    const credential = (await listCredentials(d)).find((c) => c.id === args.value.credentialId);
    if (!credential) {
      return err("refused: no saved sign-in has that id. browser_credentials lists what exists; the user enrolls new ones in Realm's Settings → Sign-ins.");
    }
    const live = await describeSafe(d, row.value.id);
    const title = `Fill the saved sign-in for ${credential.origin}${credential.username ? ` (${credential.username})` : ""}${credential.label ? ` — ${clip(credential.label, 40)}` : ""} into the page on ${hostOf(live?.url)}`;
    // `alwaysPrompt`: this card appears for every fill in every mode, and answering "always" to it
    // licenses nothing. See `GateOptions`.
    const gate = await d.broker.gate(
      ctx.sessionId, "browser_fill_credential", title,
      // The input echoed onto the permission event — the card's "what was asked for" detail. Origin,
      // username and label, exactly as the spec requires, and structurally nothing else.
      { browserId: row.value.id, ref: args.value.ref, origin: credential.origin, username: credential.username, label: credential.label },
      "browser_fill_credential", { alwaysPrompt: true },
    );
    if (!gate.allowed) return err(gate.reason);

    return runTracked(d, ctx.spaceId, row.value.id, title, async () => {
      const result = (await d.bridge.call("fillCredential", {
        browserId: row.value.id, ref: args.value.ref, credentialId: credential.id,
      })) as BrowserActResult;
      // No screenshot on failure, unlike `runAct`. A shot taken microseconds after a fill can contain
      // the filled field, and some sites render the value in plain text on the way to masking it.
      if (!result.ok) return err(`the sign-in was not filled: ${result.error}`);
      return ok(`${result.detail}. ${CREDENTIAL_2FA_NOTE}`);
    });
  },

  browser_download: async (d, ctx, rawArgs) => {
    const args = parseArgs(DownloadArgs, rawArgs); if ("error" in args) return args.error;
    const row = requireRow(d, ctx, args.value.browserId); if ("error" in row) return row.error;
    const limited = d.constraints?.checkMutation(ctx.sessionId, "browser_download"); if (limited) return err(limited);
    const dest = downloadDir(d, ctx.spaceId);
    if (!dest) return err(noDestination);
    const title = await describeDownload(d, row.value.id, args.value.ref);
    // Ordinary mode parity, UNLIKE browser_fill_credential: `bypassPermissions` skips this card. A
    // download is not a secret leaving the machine, and the guards that actually matter — path
    // confinement, the extension allowlist, the size cap, the one-shot grant — are unconditional and
    // never consult a mode. A second always-prompt tool would only train prompt-fatigue on the one
    // workflow that legitimately needs twenty in a row.
    const gate = await d.broker.gate(ctx.sessionId, "browser_download", title, { browserId: row.value.id, ref: args.value.ref });
    if (!gate.allowed) return err(gate.reason);
    return runTracked(d, ctx.spaceId, row.value.id, title, () => runDownload(d, row.value.id, args.value.ref, dest));
  },

  browser_batch: async (d, ctx, rawArgs) => {
    const args = parseArgs(BatchArgs, rawArgs); if ("error" in args) return args.error;
    // Validate every action BEFORE running any: a batch is a plan, and a half-executed plan whose
    // second half was never valid is the worst of both worlds.
    const validated: { tool: string; arguments: unknown }[] = [];
    for (const a of args.value.actions) {
      if (a.tool === "browser_batch") return err("browser_batch cannot nest.");
      // Refused at VALIDATION time, before the batch's single prompt is raised — not merely absent
      // from `runBatchMutation`. A credential fill gets its own card naming its own origin and its
      // own Touch ID check; "one prompt per fill, no batching" is the requirement, and a batch is by
      // construction one prompt for many steps.
      if (a.tool === "browser_fill_credential") return err("browser_fill_credential cannot run inside browser_batch — a credential fill is approved one at a time, on its own card. Call it directly.");
      if (!HANDLERS[a.tool]) return err(`unknown tool "${a.tool}" in batch.`);
      validated.push(a);
    }
    const mutating = validated.filter((a) => !READ_ONLY_TOOLS.has(a.tool));
    if (mutating.length > 0) {
      // ONE prompt for the whole batch, naming its mutating steps. The steps then execute through
      // `runBatchMutation`, which repeats every validation and hard block but not the prompt — the
      // plain handlers would each prompt again.
      const title = `Run ${validated.length} browser action(s), including: ${mutating.map((m) => m.tool).join(", ")}`;
      const gate = await d.broker.gate(ctx.sessionId, "browser_batch", title, { actions: validated });
      if (!gate.allowed) return err(gate.reason);
    }
    const parts: string[] = [];
    for (const [i, a] of validated.entries()) {
      const result = READ_ONLY_TOOLS.has(a.tool)
        ? await HANDLERS[a.tool]!(d, ctx, a.arguments)
        : await runBatchMutation(d, ctx, a.tool, a.arguments);
      const text = result.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
      parts.push(`--- step ${i + 1}: ${a.tool} ${result.isError ? "FAILED" : "ok"} ---\n${text}`);
      if (result.isError) {
        parts.push(`(batch stopped at step ${i + 1})`);
        return { content: [{ type: "text", text: parts.join("\n") }], isError: true };
      }
    }
    return ok(parts.join("\n"));
  },
};

/**
 * A mutating step inside an ALREADY-GATED batch: same validation, same hard blocks (OAuth refusal,
 * password refusal in the executor), no second prompt. This function must contain every mutating
 * tool's core — a mutating step routed through the plain handler would double-prompt, and one routed
 * around the hard blocks would be the security bug this file exists to prevent.
 */
async function runBatchMutation(d: Deps, ctx: ProviderCallContext, tool: string, rawArgs: unknown): Promise<CallToolResult> {
  if (tool === "browser_open") {
    const args = parseArgs(OpenArgs, rawArgs); if ("error" in args) return args.error;
    const url = normalizeToolUrl(args.value.url);
    if (!url) return err(`"${args.value.url}" is not an http(s) URL.`);
    const oauth = refuseOAuth(url); if (oauth) return oauth;
    const limited = d.constraints?.checkMutation(ctx.sessionId, "browser_open", url); if (limited) return err(limited);
    const opened = d.browserService.open({ spaceId: ctx.spaceId, url });
    d.rpc.broadcast("browser.agentOpened", { spaceId: ctx.spaceId, browserId: opened.browserId, itemId: opened.itemId });
    d.rpc.broadcast("browser.action", { spaceId: ctx.spaceId, browserId: opened.browserId, text: `Open a browser pane at ${url}`, ok: true, ts: Date.now() });
    return ok(`Opened browser pane ${opened.browserId} at ${url}.`);
  }
  if (tool === "browser_navigate") {
    const args = parseArgs(NavigateArgs, rawArgs); if ("error" in args) return args.error;
    const row = requireRow(d, ctx, args.value.browserId); if ("error" in row) return row.error;
    const url = normalizeToolUrl(args.value.url);
    if (!url) return err(`"${args.value.url}" is not an http(s) URL.`);
    const oauth = refuseOAuth(url); if (oauth) return oauth;
    const limited = d.constraints?.checkMutation(ctx.sessionId, "browser_navigate", url); if (limited) return err(limited);
    return runTracked(d, ctx.spaceId, row.value.id, `Navigate the browser pane to ${url}`, async () => {
      const result = (await d.bridge.call("navigate", { browserId: row.value.id, url })) as BrowserNavigateResult;
      if (!result.url) return err(`navigation to ${url} was refused (pane not open, or origin allowlist).`);
      return ok(`Navigating to ${result.url}.`);
    });
  }
  if (tool === "browser_act") {
    const args = parseArgs(ActArgs, rawArgs); if ("error" in args) return args.error;
    const row = requireRow(d, ctx, args.value.browserId); if ("error" in row) return row.error;
    const limited = d.constraints?.checkMutation(ctx.sessionId, "browser_act"); if (limited) return err(limited);
    const title = await describeAct(d, row.value.id, args.value.action);
    return runTracked(d, ctx.spaceId, row.value.id, title, () => runAct(d, row.value.id, args.value.action));
  }
  if (tool === "browser_download") {
    // Every check the plain handler makes, minus the prompt. "Every study guide in the class" is
    // twenty downloads and batching is the point of supporting it — but a batched step that reached
    // the bridge without re-resolving the destination, or without the constraint check, would be the
    // security bug this function exists to prevent.
    const args = parseArgs(DownloadArgs, rawArgs); if ("error" in args) return args.error;
    const row = requireRow(d, ctx, args.value.browserId); if ("error" in row) return row.error;
    const limited = d.constraints?.checkMutation(ctx.sessionId, "browser_download"); if (limited) return err(limited);
    const dest = downloadDir(d, ctx.spaceId);
    if (!dest) return err(noDestination);
    const title = await describeDownload(d, row.value.id, args.value.ref);
    return runTracked(d, ctx.spaceId, row.value.id, title, () => runDownload(d, row.value.id, args.value.ref, dest));
  }
  return err(`"${tool}" is not a known mutating browser tool.`);
}

/**
 * Wrap one mutating operation with W4's watching broadcasts: `browser.driving` true before it runs,
 * false once it settles — in a `finally`, so a bridge timeout or thrown failure can NEVER leave the
 * dot stuck on — and then one `browser.action` carrying `text`, the SAME attributed description the
 * permission card showed (never raw page text outside its `the page labels "…"` framing). The action
 * broadcast comes AFTER settle, whatever the outcome: a throw is reported as `ok: false` and then
 * rethrown for the provider's error path.
 */
async function runTracked(d: Deps, spaceId: string, browserId: string, text: string, fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  d.rpc.broadcast("browser.driving", { spaceId, browserId, driving: true });
  let ok = false;
  try {
    const result = await fn();
    ok = !result.isError;
    return result;
  } finally {
    d.rpc.broadcast("browser.driving", { spaceId, browserId, driving: false });
    d.rpc.broadcast("browser.action", { spaceId, browserId, text, ok, ts: Date.now() });
  }
}

/** Execute one act op; on failure, attach a screenshot — the one place vision reliably pays for
 *  itself (the plan's rule). The password hard block arrives from the EXECUTOR as `refused` — it is
 *  checked there, at act time against the live DOM, so no permission mode and no stale snapshot can
 *  route typing into a secret field. */
async function runAct(d: Deps, browserId: string, action: BrowserAction): Promise<CallToolResult> {
  const result = (await d.bridge.call("act", { browserId, action })) as BrowserActResult;
  if (result.ok) return ok(result.detail);
  if (result.refused === "password") {
    return err("refused: that element is a password field. Realm never types into password fields in any mode — tell the user what to enter and let them do it in the pane.");
  }
  const content: CallToolResult["content"] = [{ type: "text", text: `act failed: ${result.error}` }];
  try {
    const shot = (await d.bridge.call("screenshot", { browserId })) as BrowserScreenshotResult;
    content.push({ type: "image", data: shot.data, mimeType: shot.mimeType });
  } catch { /* the failure stands on its own; the screenshot was a bonus */ }
  return { content, isError: true };
}

/**
 * The permission prompt line for an act. Page-derived text (the element's accessible name) is
 * explicitly attributed to the page — never presented as Realm's own words — and clipped hard: the
 * prompt must describe the action, not give the page a channel into the approval UI.
 */
async function describeAct(d: Deps, browserId: string, action: BrowserAction): Promise<string> {
  const live = await describeSafe(d, browserId, "ref" in action ? action.ref : undefined);
  const host = hostOf(live?.url);
  const el = live?.element ? ` the ${live.element.role || live.element.tag || "element"} the page labels "${clip(live.element.name, 60)}"` : ` element ref=${"ref" in action ? action.ref ?? "?" : "?"}`;
  switch (action.kind) {
    case "click": return `Click${el} on ${host}`;
    case "type": return `Type "${clip(action.text, 60)}" into${el} on ${host}`;
    case "key": return `Press ${action.key} on ${host}`;
    case "scroll": return `Scroll the page on ${host}`;
  }
}

/**
 * Execute one download. The hard blocks (path confinement, the extension allowlist, the size cap,
 * the one-shot grant) all live in Electron main's governor and apply regardless of what happens
 * here — this is only result-shaping.
 *
 * On the filename, which is page-authored (`Content-Disposition`, or the URL): it is NOT wrapped in
 * `fenceUntrusted`. That fence is a multi-line preamble built for blocks of page text and reads as
 * nonsense around a single token mid-sentence. What actually makes this name safe is that it is the
 * name main WROTE — already through `safeAttachmentName`, which reduces it to `[\w.\- ]` and 120
 * characters, so it cannot carry a newline, a bracket, or a fence marker of its own. `clip` is the
 * belt: a bound on length that does not depend on remembering what the sanitizer guarantees.
 */
async function runDownload(d: Deps, browserId: string, ref: number, dir: string): Promise<CallToolResult> {
  const result = (await d.bridge.call("download", { browserId, ref, dir })) as BrowserDownloadResult;
  if (!result.ok) return err(`download failed: ${result.error}`);
  const name = clip(result.name.replace(/\s+/g, " "), 120);
  return ok(`Saved "${name}" (${Math.round(result.bytes / 1024)} KB) into ${DOWNLOAD_DIRNAME}/ in the space's project. Read it at the project-relative path ${clip(result.relPath, 200)}.`);
}

/** The permission card for a download. The link's accessible name is page-derived and attributed as
 *  such — never laundered into Realm's own voice — and the destination is named so the user knows
 *  where a file is about to appear. */
async function describeDownload(d: Deps, browserId: string, ref: number): Promise<string> {
  const live = await describeSafe(d, browserId, ref);
  const el = live?.element ? ` the page labels "${clip(live.element.name, 60)}"` : ` ref=${ref}`;
  return `Download the file behind${el} from ${hostOf(live?.url)} into ${DOWNLOAD_DIRNAME}/`;
}

/**
 * Where downloads land for a space: the first project's root. `null` when the space has no project.
 *
 * Exported because the USER's own downloads (Plan 23 W4, via the pane's blocked-download bar) must
 * land in exactly the same place as the agent's, resolved by exactly the same rule. Two resolvers
 * would eventually disagree, and the one that drifted would be writing files somewhere nobody looks.
 */
export function spaceDownloadDir(projects: Pick<ProjectsStore, "list">, spaceId: string): string | null {
  const project = projects.list(spaceId)[0];
  return project ? join(project.rootPath, DOWNLOAD_DIRNAME) : null;
}

const downloadDir = (d: Deps, spaceId: string): string | null => spaceDownloadDir(d.projects, spaceId);

const noDestination =
  "refused: this space has no project, so there is nowhere for a download to land where the user would see it. Add a project to the space first (its folder is where downloads go, and they show up in the diff pane).";

/* ---------------------------------- small helpers ---------------------------------- */

/** Enrolled sign-ins from Electron main. Metadata only — there is no bridge op that returns a value,
 *  so there is nothing here to strip. An app that is not running answers with an empty list rather
 *  than a bridge error: "no sign-ins are available" is true either way, and the distinction is not
 *  one the agent could act on. */
async function listCredentials(d: Deps): Promise<BrowserCredential[]> {
  try {
    const result = (await d.bridge.call("credentials", {})) as { credentials?: BrowserCredential[] };
    return Array.isArray(result?.credentials) ? result.credentials : [];
  } catch {
    return [];
  }
}


/** The browser must exist AND belong to the calling session's space — a browserId from another space
 *  is refused exactly like one that never existed (no cross-space discovery through error shapes). */
function requireRow(d: Deps, ctx: ProviderCallContext, browserId: string): { value: Browser } | { error: CallToolResult } {
  const row = d.browsers.get(browserId);
  if (!row || row.spaceId !== ctx.spaceId) return { error: err(`no browser "${browserId}" in this space — browser_list shows what exists.`) };
  return { value: row };
}

/** Tool URLs are stricter than the address bar: an agent gets full http(s) URLs only — no scheme
 *  guessing on its behalf, and never file:, data:, chrome: or javascript:. */
function normalizeToolUrl(input: string): string | null {
  const s = input.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try { return new URL(s).toString(); } catch { return null; }
}

function refuseOAuth(url: string): CallToolResult | null {
  if (!isOAuthConsentUrl(url)) return null;
  return err("refused: that looks like an OAuth consent/authorization URL. Realm never drives consent screens in any mode — ask the user to complete the sign-in themselves in the browser pane.");
}

async function describeSafe(d: Deps, browserId: string, ref?: number): Promise<BrowserDescribeResult | null> {
  try { return (await d.bridge.call("describe", { browserId, ...(ref !== undefined ? { ref } : {}) })) as BrowserDescribeResult; }
  catch { return null; }
}

function hostOf(url: string | undefined): string {
  if (!url) return "the current page";
  try { return new URL(url).host || "the current page"; } catch { return "the current page"; }
}

