import { z } from "zod";
import {
  BROWSER_READ_ONLY_TOOLS, BrowserActionSchema, BrowserGeneratedCredentialSchema, BrowserReadKindSchema,
  CREDENTIAL_2FA_NOTE, DOWNLOAD_DIRNAME, DOWNLOAD_MAX_BYTES, GENERATED_CREDENTIAL_NOTE,
  GENERATED_PASSWORD_LENGTH, GENERATED_PASSWORD_MAX_LENGTH, GENERATED_PASSWORD_MIN_LENGTH,
  SCREENSHOT_DIRNAME, UPLOAD_MAX_FILES, formatUploadSize, loadErrorLine, normalizeOrigin,
  type BrowserAction, type BrowserLoadError, type BrowserActResult, type BrowserCredential, type BrowserDescribeResult,
  type BrowserDismissDialogResult, type BrowserDownloadResult, type BrowserFillCredentialResult,
  type BrowserNavigateResult, type BrowserReadResult, type BrowserScreenshotResult,
  type BrowserSnapshotResult, type BrowserUploadResult, type Browser,
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
import type { ActObservation, ActObserver, ObservedElement } from "../mcp/act-observer";
import type { LayaAssist } from "../laya/assist";
import { findLabel, fold, likeliest, runPath, type ExecIO, type WalkTree } from "../simulators/executor";
import { isOAuthConsentUrl } from "./guards";
import { resolveUploadPaths, type ResolvedUploadFile } from "./upload-paths";
import { observedOf, observedPage, pageRole, pageWalked, siteName, walkElementOf, walkTreeOf } from "./walk";

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
 *   - **Mutating** (`browser_open`, `browser_navigate`, `browser_act`, `browser_do`, a `browser_batch`
 *     containing any mutating action) goes through `BrowserPermissionBroker.gate` — the session's
 *     NORMAL permission flow (ApprovalCard), honoring its permission mode.
 *   - **Hard blocks** are refusals, not prompts, and apply in every mode including
 *     `bypassPermissions`: typing into a password field (detected at act time in the executor, where
 *     the DOM is fresh), agent navigation to an OAuth consent URL (`isOAuthConsentUrl` — a heuristic
 *     with documented limits), and downloads (cancelled at the Electron session level in main).
 *
 * The injection stance: page content is data. Everything a page influenced (snapshot, page text,
 * console, network, titles) is fenced by `fenceUntrusted` before it enters a tool result, and where a
 * permission prompt needs an element's label, the label is explicitly attributed to the page
 * (`the element the page labels …`) rather than laundered into Realm's own voice.
 *
 * `browser_do` walks a path of labels in one call (`walk.ts`, over the walk in
 * `simulators/executor.ts`). It asks `browser_act`'s own card, and every click is still an act: the
 * same op, the same hard blocks, the consent-screen guard before each one, one of a delegated agent's
 * acts each. It never takes a step the sensitive rule flags.
 */
export type BrowserAgentToolsDeps = {
  browsers: Pick<BrowsersStore, "get" | "list">;
  /** Plan 23: resolves a space's project. Its root is where a download lands when the space has one. */
  projects: Pick<ProjectsStore, "list">;
  /** The space's own folder, where a download lands when the space has no project (`spaceDownloadDir`).
   *  Required, so a harness cannot quietly drop the fallback and leave most spaces unable to download. */
  spaces: { get(id: string): { folderPath: string } | null | undefined };
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
  /**
   * The profile a space belongs to (Plan 27 Phase 2). Saved sign-ins are kept per profile in main, and
   * the credential tools name the session's profile on every call, so an agent in a Work space is
   * offered Work's sign-ins and nothing of Personal's. Absent, or null for a space that is gone: the
   * tools then name no profile, and main answers as for a profile with nothing saved.
   */
  profileOf?: (spaceId: string) => string | null;
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
  /**
   * Which simulator, if any, serve-sim is streaming at a URL (`simulators/agent-tools.ts`) — asked
   * before a pane is opened or pointed at one, so that pane can be refused. See
   * `refuseSimulatorStream`. Optional: a harness without it opens every URL as this file always did.
   */
  simulatorStreams?: { streamAt(spaceId: string, url: string): Promise<string | null> };
  /**
   * Told about every act that got past its gate, just before it is sent — `browser_act`'s, each one
   * inside a `browser_batch`, and each click of a `browser_do` walk. The Laya shadow (`laya/shadow.ts`)
   * in the real server, nothing in most tests. It hears the step and never answers it: the act goes
   * ahead whatever it does, and it is never waited on. Given one, the provider also keeps the elements
   * of each session's latest snapshot of each page, since those are what the agent chose from.
   */
  observe?: ActObserver;
  /** Laya's Assist, where it has earned one (`laya/assist.ts`): a walk asks it for a label nothing on
   *  the page matches, while — and only while — its gate is open. */
  assist?: LayaAssist;
  /** The clock a walk waits on. A test seam: `performance.now` and a real timer otherwise. */
  clock?: { now(): number; sleep(ms: number): Promise<void> };
};

export function createBrowserAgentProvider(d: BrowserAgentToolsDeps): RealmToolProvider {
  const reads = new PageReads();
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
        return await handler({ ...d, reads }, ctx, args ?? {});
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
        intent: { type: "string", description: "what this step is for, in a few words — e.g. \"open the pricing page\"" },
      },
      required: ["browserId", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_do",
    description:
      'Get somewhere on a page in one call: give the labels to click, in order, as the page shows them — ["Docs", "Getting started"] — and Realm clicks each one by its ref on the page\'s live snapshot, waiting for the page to settle before the next — one call where clicking through takes a browser_snapshot and a browser_act for every step. A label further down the page is found and scrolled to. With text, the text is typed at the end into the field the walk ended on, or the only field on the page, and never submitted. It stops rather than guesses — at a label it cannot find, a click that changed nothing, or any step that buys, pays, deletes, sends, posts, submits, signs out or asks for a password, which you take yourself with browser_act by its ref — and says where and why. Returns a fresh snapshot of where it ended, with the refs browser_act takes. Asks the user for permission, as browser_act does.',
    inputSchema: {
      type: "object",
      properties: {
        browserId: { type: "string" },
        intent: { type: "string", description: "what the walk is for, in a few words — the user sees it with the step" },
        path: { type: "array", items: { type: "string" }, description: 'the labels to click, in order, as the page shows them — ["Pricing", "Enterprise"]. Up to 12.' },
        text: { type: "string", description: "text to type once the walk is done, into the field it ended on or the only field on the page — never submitted" },
        until: { type: "string", description: "words the final page must show — a link, button or field on it, or words in its title or text — for the walk to count as done" },
      },
      required: ["browserId", "intent"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_credentials",
    description:
      "List the sign-ins saved on this machine — the user's own, from Realm's Settings, plus any Realm generated for an earlier browser_fill_credential: id, origin, username, label. Never returns passwords — Realm cannot give you one. Use an id with browser_fill_credential. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_fill_credential",
    description:
      "Type a password into a field without ever seeing it — either one the user saved, or a new one Realm generates for this page. Give the [ref=N] of the username or password field, plus EITHER credentialId (from browser_credentials) OR generate (to have Realm mint a strong password, save it under Settings → Sign-ins, and fill it). " +
      "Both work the same way: Realm checks the pane's current origin, refuses if it is not the page the sign-in belongs to, asks the user to approve this specific fill, and requires Touch ID — every time. You never receive the value and cannot read it back, so generate is the way to set a password on a sign-up form: never put one in your reply for the user to copy. " +
      "A generated fill returns its new credentialId, which you use to fill the same value again (a confirm-password field, or signing in later). Two-factor prompts (Duo, Okta, an emailed code) are not automated: hand those to the user.",
    inputSchema: {
      type: "object",
      properties: {
        browserId: { type: "string" },
        ref: { type: "number", description: "the field's ref from browser_snapshot" },
        credentialId: { type: "string", description: "id from browser_credentials — omit when generating" },
        generate: {
          type: "object",
          description: "ask Realm to mint a new password for the page this pane is on, instead of filling a saved one. The origin is Realm's to decide: it comes from the pane, never from you.",
          properties: {
            username: { type: "string", description: "the account this password is for, shown on the approval card and in Settings" },
            label: { type: "string", description: "a short note for the user, shown beside the sign-in in Settings" },
            length: { type: "number", description: `how many characters (${GENERATED_PASSWORD_MIN_LENGTH}–${GENERATED_PASSWORD_MAX_LENGTH}, default ${GENERATED_PASSWORD_LENGTH}) — lower it only when the site caps the length` },
            symbols: { type: "boolean", description: "include punctuation (default true) — turn it off only when the site rejects it" },
          },
          additionalProperties: false,
        },
      },
      required: ["browserId", "ref"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_download",
    description:
      `Download the file behind a link or button by its [ref=N], into ${DOWNLOAD_DIRNAME}/ in the space's project, or in the space's own folder when it has no project. Asks the user for permission. Any file type is saved, but only from the origin the pane is already on, and only up to ${Math.round(DOWNLOAD_MAX_BYTES / 1024 / 1024)} MB. Returns the path relative to that folder, which you can then read with your own file tools. Batch this when fetching several files: one prompt covers the batch.`,
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
/** `intent` is optional, as it is on `computer_act`: required, every call from an agent that has not
 *  learned the field would become a refusal — a change to the act path for a feature that promises
 *  never to touch it. It is the goal Laya's `target` question is asked against. */
const ActArgs = z.object({ browserId: z.string().min(1), action: BrowserActionSchema, intent: z.string().optional() });
/** A walk's longest path, and a label's longest words — as for simulator_do and computer_do. */
const MAX_PATH = 12;
const MAX_LABEL = 120;
const DoArgs = z.object({
  browserId: z.string().min(1),
  intent: z.string().trim().min(1, 'intent says in a few words what the walk is for, such as "open the getting-started guide"').max(200),
  path: z.array(z.string().trim().min(1).max(MAX_PATH * (MAX_LABEL + 3))).max(MAX_PATH, `a path is at most ${MAX_PATH} steps — walk the first part, then the rest`).default([]),
  text: z.string().min(1).max(1_000).optional(),
  until: z.string().trim().min(1).max(MAX_LABEL).optional(),
}).refine((a) => a.path.length > 0 || a.text !== undefined, { message: "give a path to walk or text to type", path: ["path"] });
const DownloadArgs = z.object({ browserId: z.string().min(1), ref: z.number().int().positive() });
const FillCredentialArgs = z.object({
  browserId: z.string().min(1),
  ref: z.number().int().positive(),
  credentialId: z.string().min(1).optional(),
  generate: BrowserGeneratedCredentialSchema.optional(),
}).refine((args) => (args.credentialId === undefined) !== (args.generate === undefined), {
  // Exactly one, never both: the two mean different things about where the value comes from, and a
  // call that named both would be one whose author had not decided.
  message: "give either credentialId (to fill a saved sign-in) or generate (to have Realm mint a new password for this page) — exactly one",
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

type Deps = BrowserAgentToolsDeps & { reads: PageReads };
type Handler = (d: Deps, ctx: ProviderCallContext, args: unknown) => Promise<CallToolResult>;

const HANDLERS: Record<string, Handler> = {
  browser_list: async (d, ctx) => {
    const rows = d.browsers.list(ctx.spaceId);
    if (rows.length === 0) return ok("No browser panes in this space. Use browser_open(url) to open one.");
    const lines = await Promise.all(rows.map(async (row) => {
      const live = await describeSafe(d, row.id);
      const state = live === null ? "app not connected"
        : live.open ? `open, url: ${live.url || "(blank)"}${live.loadError ? ` — did not load (${live.loadError.name})` : ""}`
        : "pane not open in the app";
      return `browserId: ${row.id} — ${state}${row.url && (!live?.open) ? ` (last url: ${row.url})` : ""}`;
    }));
    return ok(`Browser panes in this space:\n${lines.join("\n")}`);
  },

  browser_open: async (d, ctx, rawArgs) => {
    const args = parseArgs(OpenArgs, rawArgs); if ("error" in args) return args.error;
    const url = normalizeToolUrl(args.value.url);
    if (!url) return err(`"${args.value.url}" is not an http(s) URL.`);
    const oauth = refuseOAuth(url); if (oauth) return oauth;
    const stream = await refuseSimulatorStream(d, ctx, url); if (stream) return stream;
    const limited = d.constraints?.checkMutation(ctx.sessionId, "browser_open", url); if (limited) return err(limited);
    const title = `Open a browser pane at ${url}`;
    const gate = await d.broker.gate(ctx.sessionId, "browser_open", title, { url });
    if (!gate.allowed) return err(gate.reason);
    const opened = d.browserService.open({ spaceId: ctx.spaceId, url });
    /* No ticker entry. The ticker reports what an agent DID inside a pane, and this is the act that
       created the pane — "Open a browser pane at https://…" printed inside that very pane, with a
       timestamp, restates the address bar an inch above it. `browser.agentOpened` already tells the
       renderer the pane exists, which is the part it cannot infer. */
    d.rpc.broadcast("browser.agentOpened", { spaceId: ctx.spaceId, browserId: opened.browserId, itemId: opened.itemId, openedBy: ctx.sessionId });
    return ok(`Opened browser pane ${opened.browserId} at ${url}. The page renders in the app's pane; use browser_snapshot to read it once loaded.`);
  },

  browser_navigate: async (d, ctx, rawArgs) => {
    const args = parseArgs(NavigateArgs, rawArgs); if ("error" in args) return args.error;
    const row = requireRow(d, ctx, args.value.browserId); if ("error" in row) return row.error;
    const url = normalizeToolUrl(args.value.url);
    if (!url) return err(`"${args.value.url}" is not an http(s) URL.`);
    const oauth = refuseOAuth(url); if (oauth) return oauth;
    const stream = await refuseSimulatorStream(d, ctx, url); if (stream) return stream;
    const limited = d.constraints?.checkMutation(ctx.sessionId, "browser_navigate", url); if (limited) return err(limited);
    const title = `Navigate the browser pane to ${url}`;
    const gate = await d.broker.gate(ctx.sessionId, "browser_navigate", title, { browserId: row.value.id, url });
    if (!gate.allowed) return err(gate.reason);
    d.reads.forget(ctx.sessionId, row.value.id);
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
    // What the agent is shown is what its next act chooses from, and the page its last act left.
    if (d.observe) d.reads.remember(ctx.sessionId, row.value.id, (snap.elements ?? []).map((e) => observedOf(walkElementOf(e))));
    if (snap.loadError) return ok(loadErrorReport(snap.loadError, snap.page?.loading === true));
    const head = `Snapshot of ${snap.url} — ${snap.elementCount} interactive element(s). Lines are "[ref=N] role \\"name\\" …"; changed-since-last-snapshot lines end with [new].`;
    return ok(`${head}\n${fenceUntrusted(`title: ${snap.title}\n${snap.text}`)}`);
  },

  browser_read: async (d, ctx, rawArgs) => {
    const args = parseArgs(ReadArgs, rawArgs); if ("error" in args) return args.error;
    const row = requireRow(d, ctx, args.value.browserId); if ("error" in row) return row.error;
    const result = (await d.bridge.call("read", { browserId: row.value.id, kind: args.value.kind })) as BrowserReadResult;
    if (result.loadError) return ok(loadErrorReport(result.loadError, false));
    return ok(`${args.value.kind} of browser ${row.value.id}:\n${fenceUntrusted(result.text || "(empty)")}`);
  },

  browser_screenshot: async (d, ctx, rawArgs) => {
    const args = parseArgs(BrowserIdArgs, rawArgs); if ("error" in args) return args.error;
    const row = requireRow(d, ctx, args.value.browserId); if ("error" in row) return row.error;
    const shot = (await d.bridge.call("screenshot", { browserId: row.value.id })) as BrowserScreenshotResult;
    const image = { type: "image" as const, data: shot.data, mimeType: shot.mimeType };
    // The picture is of the empty document a failed load leaves, so the words go first.
    if (shot.loadError) return { content: [{ type: "text", text: loadErrorReport(shot.loadError, false) }, image], isError: false };
    return { content: [image], isError: false };
  },

  browser_act: async (d, ctx, rawArgs) => {
    const args = parseArgs(ActArgs, rawArgs); if ("error" in args) return args.error;
    const row = requireRow(d, ctx, args.value.browserId); if ("error" in row) return row.error;
    const limited = d.constraints?.checkMutation(ctx.sessionId, "browser_act"); if (limited) return err(limited);
    const consent = await refuseConsentAct(d, ctx, row.value.id); if (consent) return consent;
    const live = await describeSafe(d, row.value.id, refOf(args.value.action));
    const title = describeAct(live, args.value.action);
    const gate = await d.broker.gate(ctx.sessionId, "browser_act", title, { browserId: row.value.id, action: args.value.action });
    if (!gate.allowed) return err(gate.reason);
    // After the gate, so only an act that is really about to happen is reported; before it, so what is
    // reported is what the agent chose from.
    observeAct(d, ctx, row.value.id, args.value.action, args.value.intent, live);
    return runTracked(d, ctx.spaceId, row.value.id, title, () => runAct(d, row.value.id, args.value.action));
  },

  /**
   * A walk: the labels to click, in order, carried out here on the page's live snapshot — see
   * `walk.ts`. One card for the walk, keyed as `browser_act`'s is: approving acts on this session's
   * pages approves both, and a walk is only acts. Each click is still the act op, with its ring, its
   * file-chooser guard and its password refusal, and goes past the consent-screen guard first — a walk
   * can click its way onto a consent page.
   */
  browser_do: async (d, ctx, rawArgs) => {
    const args = parseArgs(DoArgs, rawArgs); if ("error" in args) return args.error;
    const a = args.value;
    // "Docs › Getting started" as one string is the same path, the way a person writes it down.
    const path = a.path.flatMap((p) => p.split("›").map((part) => part.trim()).filter(Boolean));
    if (path.length > MAX_PATH) return err(`a path is at most ${MAX_PATH} steps — walk the first part, then the rest.`);
    const long = path.find((label) => label.length > MAX_LABEL);
    if (long) return err(`"${clip(long, 40)}" is not a label — a label is a few words, ${MAX_LABEL} characters at most.`);
    const row = requireRow(d, ctx, a.browserId); if ("error" in row) return row.error;
    const browserId = row.value.id;
    // A delegated agent's budget is in acts, not calls: this is the walk's first, and every click or
    // keystroke after it asks again (`pageIO`).
    const limited = d.constraints?.checkMutation(ctx.sessionId, "browser_do"); if (limited) return err(limited);
    const consent = await refuseConsentAct(d, ctx, browserId); if (consent) return consent;
    const live = await describeSafe(d, browserId);
    // Said now, rather than after a walk's first read has retried its way to the same answer.
    if (live && !live.open) return err(`browser ${browserId}'s pane is not open in the app — the user must open (or reopen) the browser pane before tools can drive it`);
    const host = hostOf(live?.url);
    // The labels and the text are the agent's words, not the page's, so the card can say them plainly.
    const clicks = `Click ${path.map((l) => `"${clip(l, 30)}"`).join(" › ")}`;
    const typed = a.text !== undefined ? `"${clip(a.text, 40)}"` : null;
    const title = `${path.length === 0 ? `Type ${typed}` : typed ? `${clicks}, then type ${typed}` : clicks} on ${host}`;
    const gate = await d.broker.gate(ctx.sessionId, "browser_act", title,
      { browserId, intent: a.intent, path, ...(a.text !== undefined ? { text: a.text } : {}) }, "browser_do");
    if (!gate.allowed) return err(gate.reason);

    const io = pageIO(d, ctx, browserId, a.intent, host);
    d.rpc.broadcast("browser.driving", { spaceId: ctx.spaceId, browserId, driving: true });
    try {
      let r = await runPath(io, { path, settle: WEB_SETTLE, ...(a.text !== undefined ? { text: a.text } : {}) });
      // `until` is checked here rather than by the walk: its tree holds only what can be acted on, and
      // what a page says it is — a heading, its title — is not in it.
      if (r.stop === null && a.until !== undefined && !(await shows(d, browserId, r.final, io.snapshotOf(r.final).title, a.until))) {
        r = { ...r, ok: false, stop: { why: "not-there", label: a.until, detail: `the walk finished, but "${clip(a.until, 60)}" is not on the page it ended on`, candidates: likeliest(r.final, a.until) } };
      }
      // The answer is this session's latest snapshot of the page, as `browser_snapshot`'s would be.
      if (d.observe) d.reads.remember(ctx.sessionId, browserId, observedPage(r.final.elements));
      return pageWalked(io.snapshotOf(r.final), host, r);
    } finally {
      d.rpc.broadcast("browser.driving", { spaceId: ctx.spaceId, browserId, driving: false });
    }
  },

  browser_credentials: async (d, ctx) => {
    const rows = await listCredentials(d, ctx);
    if (rows.length === 0) {
      return ok("No saved sign-ins. The user adds their own in Realm's Settings → Sign-ins, and there is no way for you to enroll a password of theirs. What you can do is have Realm make one: browser_fill_credential with `generate` mints a password for the page a pane is on, saves it here and types it, without ever telling you the value.");
    }
    // The user's own words from Settings (or, for a generated row, the ones an earlier call asked
    // for) — not page-authored text, so no `fenceUntrusted`, but still clipped, because a long label
    // in a tool result is a long label in the model's context.
    const lines = rows.map((c) => `credentialId: ${c.id} — ${c.origin}${c.username ? ` · ${c.username}` : ""}${c.label ? ` · ${clip(c.label, 60)}` : ""}${c.generated ? " · generated by Realm" : ""}`);
    return ok(`Saved sign-ins (no passwords — Realm cannot show you one):\n${lines.join("\n")}\n\n${CREDENTIAL_2FA_NOTE}`);
  },

  browser_fill_credential: async (d, ctx, rawArgs) => {
    const args = parseArgs(FillCredentialArgs, rawArgs); if ("error" in args) return args.error;
    const row = requireRow(d, ctx, args.value.browserId); if ("error" in row) return row.error;
    const limited = d.constraints?.checkMutation(ctx.sessionId, "browser_fill_credential"); if (limited) return err(limited);
    const live = await describeSafe(d, row.value.id);

    const generate = args.value.generate;
    if (generate) {
      // The origin a new sign-in is pinned to is READ OFF THE PANE, never taken from the agent — see
      // `BrowserGeneratedCredentialSchema`. It is what the card names, and Electron main checks it
      // again against the live page before typing, so an approval cannot outlive a navigation.
      const origin = normalizeOrigin(live?.url ?? "");
      if (!origin) {
        return err("refused: this pane is not on an http(s) page, so there is no site for Realm to pin a new sign-in to. Navigate to the page that asks for the password first.");
      }
      // `username` and `label` are the AGENT's words here, unlike a saved sign-in's, so the card
      // attributes them rather than saying them in Realm's voice — and clips them, because a
      // permission title is not somewhere a caller gets to write a paragraph.
      const named = [clip(generate.username, 60), clip(generate.label, 40)].filter(Boolean).join(" · ");
      const title =
        `Create a new saved password for ${origin}${named ? ` — the agent labels it "${named}"` : ""} and fill it into the page on ${hostOf(live?.url)}. `
        + GENERATED_CREDENTIAL_NOTE;
      // The same always-prompt gate as an enrolled fill, for the same reason: a secret is entering a
      // page. That the user has never seen this one does not make the card optional — it is the only
      // place they learn an account is about to exist with a password only Realm will hold.
      const gate = await d.broker.gate(
        ctx.sessionId, "browser_fill_credential", title,
        { browserId: row.value.id, ref: args.value.ref, origin, username: generate.username, label: generate.label, generate: true },
        "browser_fill_credential", { alwaysPrompt: true },
      );
      if (!gate.allowed) return err(gate.reason);

      return runTracked(d, ctx.spaceId, row.value.id, title, async () => {
        // The profile of the calling session's space, as the enrolled route sends: the new row joins
        // that profile's sign-ins, and main refuses a pane whose cookie jar is another profile's.
        const result = (await d.bridge.call("fillCredential", {
          browserId: row.value.id, ref: args.value.ref, origin, generate, profileId: profileIdOf(d, ctx),
        })) as BrowserFillCredentialResult;
        // No screenshot on failure here either: the field may hold what was typed into it.
        if (!result.ok) return err(`no password was generated or filled: ${result.error}`);
        return ok(
          `${result.detail}${result.credentialId ? `, as credentialId ${result.credentialId}` : ""}. `
          + "Use that id to fill the same password again — a confirm-password field takes the same call. "
          + "You cannot read the value and neither can the user, so do not offer to tell them what it is: it is in Realm's Settings → Sign-ins, and the site's own reset is the way back if they ever need it elsewhere.",
        );
      });
    }

    // The card is built from the CREDENTIAL's stored metadata (the user's own words, typed in
    // Settings) and the pane's live URL — never the page's text, and never the value. If the id is
    // unknown, say so now: a prompt for a credential that does not exist teaches nothing.
    const credential = (await listCredentials(d, ctx)).find((c) => c.id === args.value.credentialId);
    if (!credential) {
      return err("refused: no saved sign-in has that id. browser_credentials lists what exists; the user enrolls new ones in Realm's Settings → Sign-ins.");
    }
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
        browserId: row.value.id, ref: args.value.ref, credentialId: credential.id, profileId: profileIdOf(d, ctx),
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
      // Refused here rather than left to `runBatchMutation`, which has no walk in it: after the batch's
      // card, a step that could not run would be a card approved for nothing.
      if (a.tool === "browser_do") return err("browser_do cannot run inside browser_batch — a walk is already many clicks in one call. Call it directly.");
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
    const stream = await refuseSimulatorStream(d, ctx, url); if (stream) return stream;
    const limited = d.constraints?.checkMutation(ctx.sessionId, "browser_open", url); if (limited) return err(limited);
    const opened = d.browserService.open({ spaceId: ctx.spaceId, url });
    // Same as `browser_open` above: opening the pane IS the visible event, so it gets no tick.
    d.rpc.broadcast("browser.agentOpened", { spaceId: ctx.spaceId, browserId: opened.browserId, itemId: opened.itemId, openedBy: ctx.sessionId });
    return ok(`Opened browser pane ${opened.browserId} at ${url}.`);
  }
  if (tool === "browser_navigate") {
    const args = parseArgs(NavigateArgs, rawArgs); if ("error" in args) return args.error;
    const row = requireRow(d, ctx, args.value.browserId); if ("error" in row) return row.error;
    const url = normalizeToolUrl(args.value.url);
    if (!url) return err(`"${args.value.url}" is not an http(s) URL.`);
    const oauth = refuseOAuth(url); if (oauth) return oauth;
    const stream = await refuseSimulatorStream(d, ctx, url); if (stream) return stream;
    const limited = d.constraints?.checkMutation(ctx.sessionId, "browser_navigate", url); if (limited) return err(limited);
    d.reads.forget(ctx.sessionId, row.value.id);
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
    const live = await describeSafe(d, row.value.id, refOf(args.value.action));
    const title = describeAct(live, args.value.action);
    // Past the batch's card, as a plain act is past its own: heard now, just before it is sent.
    observeAct(d, ctx, row.value.id, args.value.action, args.value.intent, live);
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
 * The permission prompt line for an act, from the pane's own description of it (`describeSafe`).
 * Page-derived text (the element's accessible name) is explicitly attributed to the page — never
 * presented as Realm's own words — and clipped hard: the prompt must describe the action, not give the
 * page a channel into the approval UI.
 */
function describeAct(live: BrowserDescribeResult | null, action: BrowserAction): string {
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
  return ok(`Saved "${name}" (${Math.round(result.bytes / 1024)} KB) into ${DOWNLOAD_DIRNAME}/. Read it at ${clip(result.relPath, 200)}.`);
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
 * Where downloads land for a space: `downloads/` in the first project's root, or, when the space has no
 * project, in the space's own folder — the folder Documents shows, sessions run in, and
 * `spaceScreenshotDir` already writes to. `null` only for a space that is not there.
 *
 * Exported because the USER's own downloads (Plan 23 W4, via the pane's blocked-download bar) must
 * land in exactly the same place as the agent's, resolved by exactly the same rule. Two resolvers
 * would eventually disagree, and the one that drifted would be writing files somewhere nobody looks.
 */
export function spaceDownloadDir(
  projects: Pick<ProjectsStore, "list">,
  spaces: { get(id: string): { folderPath: string } | null | undefined },
  spaceId: string,
): string | null {
  const root = projects.list(spaceId)[0]?.rootPath ?? spaces.get(spaceId)?.folderPath;
  return root ? join(root, DOWNLOAD_DIRNAME) : null;
}

const downloadDir = (d: Deps, spaceId: string): string | null => spaceDownloadDir(d.projects, d.spaces, spaceId);

/**
 * Where a pane's screenshots land: the space's own folder, under `screenshots/`. Beside
 * `spaceDownloadDir` so the two rules for "where does a browser pane put a file" are read together.
 * Null for a space that is not there — never a guess at somewhere else.
 */
export function spaceScreenshotDir(spaces: { get(id: string): { folderPath: string } | null | undefined }, spaceId: string): string | null {
  const folder = spaces.get(spaceId)?.folderPath;
  return folder ? join(folder, SCREENSHOT_DIRNAME) : null;
}

const noDestination =
  "refused: this space no longer exists, so there is nowhere for a download to land.";

/* ---------------------------------- the observer ---------------------------------- */

/**
 * Tell the observer about an act that got past its gate, just before it is sent: what the agent said
 * it is for, the snapshot it was acting from — its latest of this page — and the element its ref
 * names: as that snapshot listed it, or, where the snapshot did not list it (a ref from an older one, or
 * from an element the user picked), as the pane describes it now. A key or a scroll with no ref
 * addressed nothing.
 */
function observeAct(d: Deps, ctx: ProviderCallContext, browserId: string, action: BrowserAction, intent: string | undefined, live: BrowserDescribeResult | null): void {
  if (!d.observe) return;
  const elements = d.reads.elements(ctx.sessionId, browserId);
  const ref = refOf(action);
  const described = ref !== undefined && live?.element
    ? { id: String(ref), role: pageRole(live.element.role || live.element.tag || "element", live.element.inputType === "password"), label: clip(live.element.name, 200) }
    : null;
  const element = (ref !== undefined ? elements.find((e) => e.id === String(ref)) : undefined) ?? described;
  const app = siteName(live?.url);
  watch(d, ctx, browserId, { tool: "browser_act", intent: intent ?? "", elements, chosen: element ? { element } : null, ...(app ? { app } : {}) });
}

/** Tell the observer about a step, if there is one, and keep what it hands back for this session's
 *  next read of the page. */
function watch(d: Deps, ctx: ProviderCallContext, browserId: string, o: Omit<ActObservation, "surface" | "spaceId" | "sessionId">): void {
  const observe = d.observe;
  if (!observe) return;
  const after = quietly(() => observe({ surface: "browser", spaceId: ctx.spaceId, sessionId: ctx.sessionId, ...o }));
  if (typeof after === "function") d.reads.owe(ctx.sessionId, browserId, after);
}

/**
 * Run something an observer handed over. A throw is swallowed and a promise is never waited on — its
 * rejection is caught here, so an observer written `async` cannot become the server's unhandled one.
 * Either way the step it watched goes ahead as if nobody had been watching.
 */
function quietly<T>(fn: () => T): T | undefined {
  try {
    const out = fn();
    if (out !== null && typeof out === "object" && typeof (out as { then?: unknown }).then === "function") {
      (out as unknown as Promise<unknown>).catch(() => {});
      return undefined;
    }
    return out;
  } catch {
    return undefined;
  }
}

type After = (after: readonly ObservedElement[]) => void;

const MAX_REMEMBERED_READS = 256;

/**
 * What each session last read of each page, and what its last act is still owed.
 *
 * `elements` is the snapshot the agent is acting from: its latest `browser_snapshot` of the page, or a
 * walk's answer. A navigation ends it — the page it listed is gone. `after` is the observer's second
 * half, kept as the simulator keeps it: the function a step's observer handed back, waiting for the
 * next read this session makes of the page — its own snapshot, a walk's first read, a walk's page once
 * a step has settled — which is the page as the step left it. `browser_act` never reads the page just
 * to feed it; a read at a guessed moment would catch a page half-loaded.
 *
 * Bounded by insertion order: a session that ended leaves its entries to age out.
 */
class PageReads {
  private readonly byKey = new Map<string, { elements: ObservedElement[]; after: After | null }>();

  elements(sessionId: string, browserId: string): ObservedElement[] {
    return this.byKey.get(key(sessionId, browserId))?.elements ?? [];
  }

  /** The agent was shown a page: it is what the next act chooses from, and what the last one left. */
  remember(sessionId: string, browserId: string, elements: ObservedElement[]): void {
    this.settle(sessionId, browserId, elements);
    this.put(key(sessionId, browserId), { elements, after: null });
  }

  /** Hand the step still waiting for a read the one just made. */
  settle(sessionId: string, browserId: string, elements: readonly ObservedElement[]): void {
    const entry = this.byKey.get(key(sessionId, browserId));
    const after = entry?.after;
    if (!entry || !after) return;
    entry.after = null;
    quietly(() => after(elements));
  }

  /** A newer step's promise replaces an older one's: only the latest step's page is still coming. */
  owe(sessionId: string, browserId: string, after: After): void {
    const k = key(sessionId, browserId);
    this.put(k, { elements: this.byKey.get(k)?.elements ?? [], after });
  }

  forget(sessionId: string, browserId: string): void {
    this.byKey.delete(key(sessionId, browserId));
  }

  private put(k: string, entry: { elements: ObservedElement[]; after: After | null }): void {
    this.byKey.delete(k);
    this.byKey.set(k, entry);
    while (this.byKey.size > MAX_REMEMBERED_READS) this.byKey.delete(this.byKey.keys().next().value!);
  }
}

/** NUL is in neither id, so no two pairs of them can collide by concatenation. */
const key = (sessionId: string, browserId: string): string => `${sessionId}\0${browserId}`;

/* ---------------------------------- walks ---------------------------------- */

/** How a walk waits on a page: a look every 50 ms (a snapshot itself takes tens), and five seconds for
 *  a click to show — a page may load another behind it, where a phone's tap answers in one. */
const WEB_SETTLE = { tapTimeoutMs: 5_000, pollMs: 50 };

/** How far a walk's scroll goes: to the end of the page, or back to its top. The snapshot already
 *  lists what is further down; what a scroll can still bring is what a page loads at the end of what
 *  it has (see `walk.ts`). */
const SCROLL_TO_END = 1_000_000;
/** How long after a scroll the walk waits before it looks: a page starts loading what a scroll
 *  reached a frame or two after the scroll lands. */
const SCROLL_SETTLE_MS = 100;

/**
 * What a walk does to a page: the pane's own snapshot and act ops, and nothing else. Every click and
 * keystroke passes the consent-screen guard, counts against a delegated agent's acts after the one the
 * handler counted, and puts a line in the pane's ticker, as `browser_act` does. Laya is offered a label
 * nothing matches only while its Assist can act; every click is told to the observer as the step it is.
 */
function pageIO(d: Deps, ctx: ProviderCallContext, browserId: string, intent: string, host: string): ExecIO & { snapshotOf(tree: WalkTree): BrowserSnapshotResult } {
  const read = new WeakMap<WalkTree, BrowserSnapshotResult>();
  let latest: BrowserSnapshotResult | null = null;
  let first = true;
  let counted = 0;
  let clicked: { ref: number; role: string; label: string } | null = null;
  const assist = d.assist;
  /** Where the page is now, for the ticker: a walk can click its way onto another site. */
  const here = (): string => (latest ? hostOf(latest.url) : host);
  const sleep = (ms: number): Promise<void> => d.clock?.sleep(ms) ?? new Promise((r) => setTimeout(r, ms));
  const send = async (action: BrowserAction, line: string, o: { counts: boolean }): Promise<{ ok: boolean; detail: string }> => {
    if (o.counts) {
      const limited = counted++ > 0 ? d.constraints?.checkMutation(ctx.sessionId, "browser_do") : null;
      if (limited) return { ok: false, detail: limited };
      const consent = await refuseConsentAct(d, ctx, browserId);
      if (consent) return { ok: false, detail: textOf(consent) };
    }
    let r: BrowserActResult;
    try { r = (await d.bridge.call("act", { browserId, action })) as BrowserActResult; } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    d.rpc.broadcast("browser.action", { spaceId: ctx.spaceId, browserId, text: line, ok: r.ok, ts: Date.now() });
    if (r.ok) return { ok: true, detail: r.detail };
    return { ok: false, detail: r.refused === "password" ? "that is a password field, and Realm never types into one" : r.error };
  };
  return {
    read: async () => {
      const snap = (await d.bridge.call("snapshot", { browserId })) as BrowserSnapshotResult;
      const tree = walkTreeOf(snap);
      read.set(tree, snap);
      latest = snap;
      // The page as an act before the walk left it, for the step still waiting on it.
      if (first) d.reads.settle(ctx.sessionId, browserId, observedPage(tree.elements));
      first = false;
      return tree;
    },
    // The document's own entry is never tapped: it has no name for a label to match, and Laya is
    // offered nothing unnamed. Every element that can be is named by its ref.
    tap: (el) => {
      const ref = Number(el.path);
      clicked = { ref, role: el.role, label: el.label };
      return send({ kind: "click", ref, button: "left", clickCount: 1, modifiers: [] }, `Click the ${el.role} the page labels "${clip(el.label, 60)}" on ${here()}`, { counts: true });
    },
    scroll: async (direction) => {
      const r = await send({ kind: "scroll", deltaX: 0, deltaY: direction === "up" ? SCROLL_TO_END : -SCROLL_TO_END }, `Scroll the page on ${here()}`, { counts: false });
      await sleep(SCROLL_SETTLE_MS);
      return r;
    },
    // The walk types only into the field it has just clicked: the one its path ended on, or the only
    // one on the page, which it clicks first. Never with Enter after it — nothing is submitted.
    type: (text) => (clicked === null
      ? Promise.resolve({ ok: false, detail: "no field was clicked to type into" })
      : send({ kind: "type", ref: clicked.ref, text, method: "keys", submit: false }, `Type "${clip(text, 60)}" into the ${clicked.role} the page labels "${clip(clicked.label, 60)}" on ${here()}`, { counts: true })),
    ...(assist?.gate().available ? { laya: (label: string, elements: readonly ObservedElement[], app: string) => assist.resolve(label, label, elements, "browser_do", app) } : {}),
    observe: ({ elements, chosen, by }) => {
      const app = siteName(latest?.url);
      watch(d, ctx, browserId, {
        tool: "browser_do", intent, elements: observedPage(elements), chosen: { element: observedOf(chosen) },
        ...(by === "laya" ? { chosenBy: "laya" as const } : {}), ...(app ? { app } : {}),
      });
    },
    settled: (tree) => d.reads.settle(ctx.sessionId, browserId, observedPage(tree.elements)),
    now: () => d.clock?.now() ?? performance.now(),
    sleep,
    snapshotOf: (tree) => read.get(tree) ?? latest!,
  };
}

/**
 * Whether the page a walk ended on shows `words`: an element its snapshot lists, or the words in its
 * title or its text, compared as a person would (`fold`). The walk's tree holds only what can be acted
 * on, and "the page says Getting started" is as often a heading as a link.
 */
async function shows(d: Deps, browserId: string, tree: WalkTree, title: string, words: string): Promise<boolean> {
  if (findLabel(tree, words)) return true;
  const want = ` ${fold(words)} `;
  if (` ${fold(title)} `.includes(want)) return true;
  const page = await d.bridge.call("read", { browserId, kind: "text" }).catch(() => null) as BrowserReadResult | null;
  return page !== null && ` ${fold(page.text)} `.includes(want);
}

/* ---------------------------------- small helpers ---------------------------------- */

/** The ref an action names, if it names one. */
const refOf = (action: BrowserAction): number | undefined => ("ref" in action ? action.ref : undefined);

/** A tool result's text, for a refusal that becomes one sentence of a walk's answer. */
const textOf = (r: CallToolResult): string =>
  r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join(" ");

/** Enrolled sign-ins from Electron main. Metadata only — there is no bridge op that returns a value,
 *  so there is nothing here to strip. An app that is not running answers with an empty list rather
 *  than a bridge error: "no sign-ins are available" is true either way, and the distinction is not
 *  one the agent could act on. */
async function listCredentials(d: Deps, ctx: ProviderCallContext): Promise<BrowserCredential[]> {
  try {
    const result = (await d.bridge.call("credentials", { profileId: profileIdOf(d, ctx) })) as { credentials?: BrowserCredential[] };
    return Array.isArray(result?.credentials) ? result.credentials : [];
  } catch {
    return [];
  }
}

/** The calling session's profile, which is whose saved sign-ins main may offer — "" when it cannot be
 *  said, which main answers as a profile with nothing saved rather than as anybody's. */
const profileIdOf = (d: Deps, ctx: ProviderCallContext): string => d.profileOf?.(ctx.spaceId) ?? "";


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

/**
 * Refuse to put serve-sim's stream of a simulator in a browser pane, and say what to call instead.
 *
 * The mistake this catches is specific: an agent that knows serve-sim starts one in a terminal and
 * opens the URL it printed, which makes a second, worse copy of the simulator pane — a web page with
 * no device controls, beside a pane that does it properly. The preamble already says not to; this is
 * for the agent that did it anyway, or that is following an older skill.
 *
 * It is a refusal and not a redirect. Opening the simulator pane instead would hand back a
 * simulatorId to a caller that asked for a browserId, behind a permission card that named a browser
 * pane, and the next `browser_snapshot` would fail on it. One refusal naming the exact call — the
 * udid is serve-sim's own — costs the agent one round trip and leaves nothing half-done.
 *
 * Precise rather than a guess about what the page looks like: the answer comes from serve-sim's own
 * records, confirmed by its `--list` (`SimulatorService.streamedOn`). A space that switched the
 * simulator tools off gets no refusal at all, since the call it names would not exist there, and a
 * guard that cannot answer lets the URL through — it is a pointer, not a boundary.
 */
async function refuseSimulatorStream(d: Deps, ctx: ProviderCallContext, url: string): Promise<CallToolResult | null> {
  const udid = await d.simulatorStreams?.streamAt(ctx.spaceId, url).catch(() => null);
  if (!udid) return null;
  return err(
    `refused: ${url} is serve-sim's stream of the simulator ${udid}, and Realm shows simulators in a pane of its own. `
    + `Call simulator_open with udid "${udid}" instead — it opens that device beside this session and adopts this same stream, so nothing needs starting or stopping.`,
  );
}

/**
 * A page that did not load, in Realm's own words — outside the untrusted fence, because nothing in it
 * is the page's: the code is Chromium's and the sentence is the one the pane's error page shows
 * (`describeLoadError`). The agent is told what is on screen in the page's place, and how to try
 * again, because there is no element to act on and no text to read.
 */
function loadErrorReport(e: BrowserLoadError, loading: boolean): string {
  const next = loading
    ? "The pane is loading again — take another browser_snapshot once it has finished."
    : "browser_navigate to the same address tries again.";
  return `The page at ${e.url} did not load. ${loadErrorLine(e)}\n`
    + `The pane shows Realm's error page in its place, so there is nothing on the page to read or act on. ${next}`;
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

