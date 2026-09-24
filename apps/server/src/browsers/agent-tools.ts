import { z } from "zod";
import {
  BROWSER_READ_ONLY_TOOLS, BrowserActionSchema, BrowserReadKindSchema, CREDENTIAL_2FA_NOTE,
  DOWNLOAD_DIRNAME, DOWNLOAD_MAX_BYTES, UPLOAD_MAX_FILES, formatUploadSize,
  type BrowserAction, type BrowserActResult, type BrowserCredential, type BrowserDescribeResult,
  type BrowserDismissDialogResult, type BrowserDownloadResult, type BrowserNavigateResult,
  type BrowserReadResult, type BrowserScreenshotResult, type BrowserSnapshotResult,
  type BrowserUploadResult, type Browser,
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
import { fenceUntrusted } from "@realm/contracts";
import { isOAuthConsentUrl } from "./guards";
import { resolveUploadPaths, type ResolvedUploadFile } from "./upload-paths";

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
  /**
   * Plan 26: the space's own folder — the default root a `browser_upload` may read from. Anything
   * outside it is still uploadable, but only with its full path quoted on the approval card, so the
   * user is told when an agent reaches past the space they are working in.
   *
   * Optional, and its absence means "no default root": every path is then treated as outside and
   * shown in full. That is the safe direction — a harness that cannot say where the space lives
   * should show more, not less.
   */
  documents?: { rootForSpace(spaceId: string): string | null };
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
  /**
   * The consent-page gate for ACTS (`signin.ts`). Optional so a harness built without it behaves as
   * this file did before — which, for consent pages, was to allow the click.
   */
  signIn?: { allowsAct(spaceId: string, browserId: string, url: string | undefined): boolean };
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
      `Download the file behind a link or button by its [ref=N], into the space project's ${DOWNLOAD_DIRNAME}/ directory. Asks the user for permission. Any file type is saved, but only from the origin the pane is already on, and only up to ${Math.round(DOWNLOAD_MAX_BYTES / 1024 / 1024)} MB. Returns the project-relative path, which you can then read with your own file tools. Batch this when fetching several files: one prompt covers the batch.`,
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
    name: "browser_upload",
    description:
      "Attach files from this Mac to a page — the only way to do it, because typing a path into a file input does nothing and Realm never opens macOS's file panel (it is modal: once up, nothing here can dismiss it). " +
      "Give the [ref=N] of the file input itself, of the button or label that opens the picker, or of a drag-and-drop zone; Realm sets the files on the input directly, or intercepts the picker before the click and fills it, or synthesizes a real drop. " +
      "Paths are absolute and on this machine. Anything outside the space's folder is quoted in full on the approval card; keys and secrets (~/.ssh, ~/.aws, keychains, *.pem, .env) are refused outright, whatever the user approves. " +
      `The page's own accept= and multiple are enforced, so a wrong file fails here with a reason instead of being silently dropped by the site. Up to ${UPLOAD_MAX_FILES} files in one call, under one approval. Returns the names actually attached. Asks the user for permission.`,
    inputSchema: {
      type: "object",
      properties: {
        browserId: { type: "string" },
        ref: { type: "number", description: "ref of the file input, the button/label that opens the picker, or the dropzone — from browser_snapshot" },
        paths: {
          type: "array", minItems: 1, maxItems: UPLOAD_MAX_FILES,
          items: { type: "string", description: "absolute path of a file on this Mac" },
        },
      },
      required: ["browserId", "ref", "paths"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_dismiss_dialog",
    description:
      "Cancel a file chooser a click opened — the way back from a click that turned out to open a picker you did not want. Realm intercepts every chooser an agent's click opens, so nothing is on screen; this tells the page nothing was picked and clears it. " +
      "browser_snapshot says when one is open. Does nothing (and says so) when none is. Asks the user for permission.",
    inputSchema: { type: "object", properties: { browserId: { type: "string" } }, required: ["browserId"], additionalProperties: false },
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
const UploadArgs = z.object({
  browserId: z.string().min(1),
  ref: z.number().int().positive(),
  paths: z.array(z.string().min(1)).min(1).max(UPLOAD_MAX_FILES),
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
    /* No ticker entry. The ticker reports what an agent DID inside a pane, and this is the act that
       created the pane — "Open a browser pane at https://…" printed inside that very pane, with a
       timestamp, restates the address bar an inch above it. `browser.agentOpened` already tells the
       renderer the pane exists, which is the part it cannot infer. */
    d.rpc.broadcast("browser.agentOpened", { spaceId: ctx.spaceId, browserId: opened.browserId, itemId: opened.itemId });
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
    const consent = await refuseConsentAct(d, ctx, row.value.id); if (consent) return consent;
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
    // confinement, the origin match, the size cap, the one-shot grant — are unconditional and
    // never consult a mode. A second always-prompt tool would only train prompt-fatigue on the one
    // workflow that legitimately needs twenty in a row.
    const gate = await d.broker.gate(ctx.sessionId, "browser_download", title, { browserId: row.value.id, ref: args.value.ref });
    if (!gate.allowed) return err(gate.reason);
    return runTracked(d, ctx.spaceId, row.value.id, title, () => runDownload(d, row.value.id, args.value.ref, dest));
  },

  /**
   * Put files into a page (Plan 26).
   *
   * The sequence is the feature: RESOLVE the paths (realpath, stat, secret refusal, containment)
   * BEFORE the card is raised, then show the user exactly what was resolved, then hand main a list
   * it cannot widen. A card that said "upload 5 files" and let the executor work out which ones
   * would be a card about nothing.
   *
   * Refusals that happen before the prompt — a path that does not exist, a private key, a directory,
   * a file over the cap — are refusals, not prompts. Asking the user to approve an upload that is
   * going to fail teaches them that the card is noise, and asking them to approve `~/.ssh/id_rsa` is
   * worse than that.
   */
  browser_upload: async (d, ctx, rawArgs) => {
    const args = parseArgs(UploadArgs, rawArgs); if ("error" in args) return args.error;
    const row = requireRow(d, ctx, args.value.browserId); if ("error" in row) return row.error;
    const limited = d.constraints?.checkMutation(ctx.sessionId, "browser_upload"); if (limited) return err(limited);

    const resolved = await resolveUploadPaths(args.value.paths, d.documents?.rootForSpace(ctx.spaceId) ?? null);
    if (!resolved.ok) return err(resolved.error);
    const files = resolved.files;

    const live = await describeSafe(d, row.value.id, args.value.ref);
    const title = describeUpload(files, live, args.value.ref);
    /*
     * Ordinary mode parity, like `browser_download` and unlike `browser_fill_credential`:
     * `bypassPermissions` skips this card. The guards that actually bound an upload — the secret-path
     * refusal, the symlink-resolved containment, the size caps, the page's own accept= — are
     * unconditional and never consult a mode, and the motivating workflow (a project gallery) is
     * several uploads in a row. What the card is for is the one thing no rule can decide: whether
     * THESE files should go to THIS site.
     *
     * `input` carries the structured list the card draws from (`browser_upload` has a view in
     * tool-view.ts) — names, sizes, and the full resolved path for anything outside the space folder,
     * which is the spec's "quoting the full path".
     */
    const gate = await d.broker.gate(ctx.sessionId, "browser_upload", title, {
      browserId: row.value.id, ref: args.value.ref,
      origin: hostOf(live?.url),
      element: live?.element ? clip(live.element.name, 60) : "",
      files: files.map((f) => ({ name: f.name, size: formatUploadSize(f.bytes), ...(f.outsideRoot ? { path: f.path } : {}) })),
    });
    if (!gate.allowed) return err(gate.reason);
    return runTracked(d, ctx.spaceId, row.value.id, title, () => runUpload(d, row.value.id, args.value.ref, files));
  },

  /**
   * Cancel an intercepted file chooser.
   *
   * Gated like every other tool that touches a page, rather than run free: the split this file
   * documents is read-only vs mutating, and this dispatches into the page. Under `bypassPermissions`
   * — which is where an agent doing this kind of work usually is — there is no card at all, so the
   * recovery path this exists for costs nothing; under `default` the user sees one line naming the
   * site, which is a fair price for an agent reaching into their pane.
   */
  browser_dismiss_dialog: async (d, ctx, rawArgs) => {
    const args = parseArgs(BrowserIdArgs, rawArgs); if ("error" in args) return args.error;
    const row = requireRow(d, ctx, args.value.browserId); if ("error" in row) return row.error;
    const limited = d.constraints?.checkMutation(ctx.sessionId, "browser_dismiss_dialog"); if (limited) return err(limited);
    const live = await describeSafe(d, row.value.id);
    const title = `Cancel the file chooser on ${hostOf(live?.url)}`;
    const gate = await d.broker.gate(ctx.sessionId, "browser_dismiss_dialog", title, { browserId: row.value.id });
    if (!gate.allowed) return err(gate.reason);
    return runTracked(d, ctx.spaceId, row.value.id, title, () => runDismissDialog(d, row.value.id));
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
      // Refused here for the same reason, and at the same point: a batch is by construction ONE
      // prompt for many steps, and an upload's card is the list of files and the site they are going
      // to. Approving "run 4 browser actions, including: browser_upload" would be approving an
      // upload whose files the user never saw. One call per destination; batching several files into
      // one call is what `paths` is for, and that is still one prompt.
      if (a.tool === "browser_upload") return err("browser_upload cannot run inside browser_batch — its approval names the files and the site, so it is asked one upload at a time. Pass several paths to one browser_upload call instead; that is still one prompt.");
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
    // Same as `browser_open` above: opening the pane IS the visible event, so it gets no tick.
    d.rpc.broadcast("browser.agentOpened", { spaceId: ctx.spaceId, browserId: opened.browserId, itemId: opened.itemId });
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
    const consent = await refuseConsentAct(d, ctx, row.value.id); if (consent) return consent;
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
  if (tool === "browser_dismiss_dialog") {
    // Batchable, unlike `browser_upload`: it carries no payload and names no destination, so the
    // batch's one prompt says everything its own card would have. "Click, then cancel the chooser
    // that opens" is a plan, and plans are what a batch is for.
    const args = parseArgs(BrowserIdArgs, rawArgs); if ("error" in args) return args.error;
    const row = requireRow(d, ctx, args.value.browserId); if ("error" in row) return row.error;
    const limited = d.constraints?.checkMutation(ctx.sessionId, "browser_dismiss_dialog"); if (limited) return err(limited);
    const live = await describeSafe(d, row.value.id);
    return runTracked(d, ctx.spaceId, row.value.id, `Cancel the file chooser on ${hostOf(live?.url)}`, () => runDismissDialog(d, row.value.id));
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
 * Execute one download. The hard blocks (path confinement, the origin match, the size cap, the
 * one-shot grant) all live in Electron main's governor and apply regardless of what happens
 * here — this is only result-shaping. There is no file-type test anywhere in the path: any type the
 * site serves is saved, which is why the permission card below has to name the destination.
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

/**
 * Execute one upload. Every rule that decides which bytes may go has already run server-side
 * (`resolveUploadPaths`) and the user has approved this exact list — what happens across the bridge
 * is route selection and the attach, and this function only shapes the answer.
 *
 * The success line reports the names the INPUT holds afterwards, read back off `input.files` by the
 * executor rather than echoed from the request. That is the whole point of returning a post-state:
 * an agent can confirm the upload landed without spending a screenshot on it, and a site that
 * silently swapped the input out shows up as a name list that does not match.
 *
 * File names here are page-adjacent but not page-authored — they are the basenames of paths the USER
 * approved, and the executor clips each one — so they are not fenced, only clipped again as a bound
 * that does not depend on remembering what the far side guarantees.
 */
async function runUpload(d: Deps, browserId: string, ref: number, files: ResolvedUploadFile[]): Promise<CallToolResult> {
  const result = (await d.bridge.call("upload", {
    browserId, ref,
    // Only the three fields the executor needs. `requested` and `outsideRoot` were the CARD's
    // business and stop here — nothing across the bridge has any use for the path the agent typed.
    files: files.map((f) => ({ path: f.path, name: f.name, bytes: f.bytes })),
  })) as BrowserUploadResult;
  if (!result.ok) return err(`upload failed: ${result.error}`);
  const names = result.names.map((n) => clip(n.replace(/\s+/g, " "), 120));
  const how = result.method === "input" ? "set directly on the page's file input"
    : result.method === "chooser" ? "given to the file chooser the page opened (no macOS panel appeared)"
    : "dropped onto the page's drop zone";
  const state = result.value === null
    ? "The input could not be read back afterwards — take a browser_snapshot to see what the page did with them."
    : result.value === ""
      ? "The input reports holding nothing, so the page cleared it — check the site's own error message with browser_read."
      : `The input now holds: ${clip(result.value, 300)}.`;
  return ok(`Attached ${names.length} file(s) — ${how}: ${names.join(", ")}. ${state}`);
}

async function runDismissDialog(d: Deps, browserId: string): Promise<CallToolResult> {
  const result = (await d.bridge.call("dismissDialog", { browserId })) as BrowserDismissDialogResult;
  return ok(result.dismissed
    ? `${result.detail}. Nothing was uploaded.`
    : `${result.detail}. Nothing to cancel — if a macOS file panel is genuinely on screen, it was opened outside Realm's control and only the user can dismiss it.`);
}

/**
 * The permission line for an upload.
 *
 * Three things the spec requires it carry, and they are in the order a reader needs them: WHAT is
 * leaving (names and sizes — the decision), WHERE it is going (the element as the PAGE labels it,
 * attributed as such, plus the host), and whether anything came from outside the space folder.
 *
 * The outside-root count rather than the paths themselves: a full path is long, this is one line in
 * a `<span>`, and the card draws the paths in full underneath (`tool-view.ts`). The line's job is to
 * make a reader who is about to press Enter stop and look, and "1 from outside this space's folder"
 * does that where ninety characters of `/Users/…` would just be clipped.
 */
function describeUpload(files: ResolvedUploadFile[], live: BrowserDescribeResult | null, ref: number): string {
  const listed = files.slice(0, UPLOAD_TITLE_FILES).map((f) => `${clip(f.name, 40)} (${formatUploadSize(f.bytes)})`);
  const rest = files.length - listed.length;
  const what = `${listed.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`;
  const el = live?.element ? ` the ${live.element.role || live.element.tag || "element"} the page labels "${clip(live.element.name, 40)}"` : ` element ref=${ref}`;
  const outside = files.filter((f) => f.outsideRoot).length;
  const warn = outside === 0 ? "" : ` — ${outside} from OUTSIDE this space's folder`;
  return `Upload ${files.length} file(s) to${el} on ${hostOf(live?.url)}: ${what}${warn}`;
}

/** How many file names the permission LINE spells out before it starts counting. Three names and
 *  their sizes is already most of the width a card's head has; the rest are drawn in full in the
 *  card's body, where there is room for them. */
const UPLOAD_TITLE_FILES = 3;

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

/**
 * Refuse to ACT on a pane that is sitting on a consent screen.
 *
 * `refuseOAuth` below guards the two tools that carry a URL, and its own comment says what it cannot
 * see: "a same-site link the agent CLICKS (click targets come from the page, not from tool args —
 * `browser_act` has no URL to test)". The gap that admission leaves is the whole point of the guard,
 * because the act it exists to prevent is pressing the button — and any pane that reached a consent
 * screen by a redirect, a click, or the user's own address bar could be acted on freely, in every
 * mode.
 *
 * So the URL is fetched rather than read off the arguments: `describe` already runs on this path for
 * the permission card's title, and where the pane IS is a fact about the pane, not about what the
 * caller said. A pane whose URL cannot be read at all is treated as fine — this is a guard against
 * the common case, not a boundary, exactly as `isOAuthConsentUrl` says of itself.
 *
 * `SignInTickets` is what can say yes: see `signin.ts` for why provenance, and not a mode, is what
 * makes one of these clicks defensible.
 */
async function refuseConsentAct(d: Deps, ctx: ProviderCallContext, browserId: string): Promise<CallToolResult | null> {
  if (!d.signIn) return null;
  const url = (await describeSafe(d, browserId))?.url;
  if (d.signIn.allowsAct(ctx.spaceId, browserId, url)) return null;
  return err(
    "refused: this pane is showing an OAuth consent screen, and Realm does not press Authorize on a user's behalf. "
    + "A grant made here is durable and no per-action approval can express it. Tell the user what is being asked for and let them click it in the pane. "
    + "(Realm can finish a sign-in it started itself, when the space has that switched on.)",
  );
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

