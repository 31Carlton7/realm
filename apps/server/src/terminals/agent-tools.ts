import { z } from "zod";
import { fenceUntrusted } from "@realm/contracts";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProviderCallContext, RealmToolProvider } from "../mcp/gateway";
import { err, ok, parseArgs } from "../mcp/tool-result";
import type { RpcServer } from "../rpc/server";
import type { McpService } from "../mcp/service";
import type { ItemsStore } from "../store/items";
import type { TerminalsStore } from "../store/terminals";
import type { BrowserPermissionBroker } from "../browsers/permissions";
import { MAX_SCROLLBACK_LINES, screenText, type TerminalScreen } from "./screen";
import type { TerminalService } from "./service";

export const TERMINAL_PROVIDER_NAME = "realm-terminal";

/**
 * The `realm-terminal` gateway provider: an agent's hands on a real terminal pane in this space.
 *
 * ## Why this exists beside the agent's own shell
 *
 * Every harness already has a Bash tool, and for running a command and reading its output that tool
 * is better than this one — it is non-interactive, it captures cleanly, and it costs no pane. This
 * provider is for the work Bash structurally cannot do: a program that keeps a terminal and talks
 * back. `claude auth login` prints a URL, waits, and asks for a code. `gh auth login` asks which
 * protocol. `ssh` asks about a host key. `git rebase -i` opens an editor. Under `bash -c` each of
 * those either hangs forever or fails with the least useful half of its own error, because there is
 * no terminal on the other end to answer them.
 *
 * So the unit here is not "run this and tell me what it said". It is a pty that OUTLIVES the call:
 * open it, type into it, read what it is showing now, type again. The pane is a real one in the
 * user's sidebar, which is the second reason to prefer it over a hidden subprocess — an agent
 * halfway through signing someone in should be something that person can watch and take over.
 *
 * ## The permission split
 *
 *   - **Read-only** (`terminal_list`, `terminal_read`, `terminal_wait`) runs free in every mode.
 *   - **Mutating** (`terminal_open`, `terminal_write`, `terminal_close`) goes through the session's
 *     normal permission flow — the same `BrowserPermissionBroker` the browser and computer tools
 *     gate on, so the card appears on the session that is blocked in the call.
 *   - **A terminal this session did not open prompts even under `bypassPermissions`.** The mode
 *     means "stop asking me about ordinary actions", and it earns that meaning from the blast radius
 *     being something the agent made. Typing into a shell the USER opened is not that: their pty may
 *     be sitting in a half-finished rebase, or at a prompt where the next character is an answer.
 *     Approving a terminal the agent spawned should not license reaching into one it did not.
 *   - **A password prompt is a refusal in every mode**, `bypassPermissions` included. See
 *     `looksLikePasswordPrompt`.
 *
 * Program output is data. Everything a terminal printed is fenced by `fenceUntrusted` before it
 * enters a tool result — a shell is a place where `curl` pipes somebody else's text onto the screen,
 * and that text has no more standing to give instructions than a web page does.
 */
export type TerminalAgentToolsDeps = {
  terminals: Pick<TerminalService, "open" | "read" | "screen" | "write" | "close" | "has" | "quiet" | "manager">;
  rows: Pick<TerminalsStore, "get" | "listBySpace">;
  items: Pick<ItemsStore, "findByRefId">;
  mcp: Pick<McpService, "providerEnabled">;
  broker: Pick<BrowserPermissionBroker, "gate">;
  rpc: Pick<RpcServer, "broadcast">;
};

export function createTerminalAgentProvider(d: TerminalAgentToolsDeps): RealmToolProvider {
  /**
   * Which terminals each session opened, for the bypass rule above.
   *
   * Process memory rather than a column, deliberately: what it protects against is an agent reaching
   * into a shell someone else is using, and after a restart there is no agent mid-task to protect
   * anything from — the worst a lost entry costs is one extra permission card. A DB column would
   * make this durable and would then have to be kept correct across terminal deletion, session
   * deletion and space moves, which is three new ways to be wrong about a question that stops
   * mattering the moment the process ends.
   */
  const opened = new Map<string, Set<string>>();
  const ownedBy = (sessionId: string, terminalId: string) => opened.get(sessionId)?.has(terminalId) === true;

  return {
    name: TERMINAL_PROVIDER_NAME,
    async tools(ctx: ProviderCallContext): Promise<Tool[]> {
      if (!d.mcp.providerEnabled(ctx.spaceId, TERMINAL_PROVIDER_NAME)) return [];
      return TOOLS;
    },
    async call(ctx: ProviderCallContext, tool: string, args: unknown): Promise<CallToolResult> {
      if (!d.mcp.providerEnabled(ctx.spaceId, TERMINAL_PROVIDER_NAME))
        return err(`the ${TERMINAL_PROVIDER_NAME} tools are disabled for this space — mcp.setProviderEnabled turns them back on.`);
      const handler = HANDLERS[tool];
      if (!handler) return err(`unknown tool "${tool}" — this provider has: ${TOOLS.map((t) => t.name).join(", ")}`);
      try {
        return await handler({ d, ctx, opened, ownedBy }, args ?? {});
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

/* ---------------------------------- the refusal ---------------------------------- */

/**
 * The line this terminal is asking for a secret on, or null.
 *
 * The terminal half of the browser's password-field block, and it exists for the same reason: an
 * agent typing a password is an agent that had to have obtained one, and every way it could have is
 * a way Realm does not want to be part of. It refuses in EVERY mode — a `bypassPermissions` session
 * is one that stopped being asked about ordinary actions, and this has never been one.
 *
 * Only the ACTIVE prompt is tested: the line the caret sits on, or the last line with anything on it
 * when the caret is somewhere blank. A screen that merely mentions the word — a `grep password`, a
 * failed login further up the scrollback — is not a program waiting for one, and treating it as one
 * would refuse the next keystroke in a terminal that has scrolled past an old error, which is both
 * wrong and very hard for a user to understand.
 *
 * The patterns are prompt SHAPES rather than keywords for that same reason: a trailing colon with
 * the caret after it is what "I am waiting for you to type a secret" looks like, from `sudo`'s
 * `[sudo] password for carlton:` to ssh's `Enter passphrase for key '/Users/x/.ssh/id_ed25519':`.
 * This is a guard, not a boundary — a program free to word its prompt any way it likes can always
 * word it out of this list, which is why the permission card sits behind it rather than beside it.
 */
export function looksLikePasswordPrompt(screen: TerminalScreen): string | null {
  const active = screen.screen[screen.cursor.row] || [...screen.screen].reverse().find((l) => l.trim() !== "") || "";
  // Everything up to the caret: a prompt is what was printed BEFORE the cursor, and on a line the
  // user has already typed into, the tail is their own input.
  const asked = (screen.screen[screen.cursor.row] === active ? active.slice(0, screen.cursor.col) : active).trimEnd();
  const patterns = [
    /password[^:]*:$/i,     // Password:  ·  [sudo] password for carlton:  ·  Password for git@host:
    /passphrase[^:]*:$/i,   // Enter passphrase for key '…':
    /\bpin\b[^:]*:$/i,      // PIN:  ·  Enter PIN for token:
    /\bsecret\b[^:]*:$/i,   // Client secret:
  ];
  return patterns.some((re) => re.test(asked)) ? active : null;
}

const PASSWORD_REFUSAL = (line: string) =>
  `refused: this terminal is asking for a secret (${JSON.stringify(line)}). Realm never types into a password prompt, in any permission mode. `
  + "Tell the user what it is asking for and let them type it in the pane — it is open in front of them.";

/* ---------------------------------- keys ---------------------------------- */

/**
 * The named keys a caller may send, and the bytes each one is.
 *
 * A table rather than raw escape bytes in the tool's arguments, because the alternative is an agent
 * composing control sequences from memory and a terminal receiving whatever it got wrong. Kept
 * short on purpose: these are the keys an interactive prompt actually reads — a menu to arrow
 * through, a field to submit, a program to interrupt — and not an attempt at a keyboard.
 */
export const TERMINAL_KEYS = {
  enter: "\r",
  tab: "\t",
  escape: "\x1b",
  backspace: "\x7f",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  /** Interrupt. The one key here that ends things rather than answering them. */
  "ctrl-c": "\x03",
  /** End of input — what closes a prompt that reads until EOF. */
  "ctrl-d": "\x04",
} as const;

export type TerminalKey = keyof typeof TERMINAL_KEYS;

/* ---------------------------------- tools ---------------------------------- */

const READ_ONLY_TOOLS = new Set(["terminal_list", "terminal_read", "terminal_wait"]);

/** How long a write waits for the program to react before reading the screen back. Long enough for
 *  a TUI to repaint, short enough that a command which is genuinely going to take a minute returns
 *  promptly and says so rather than blocking the agent's turn. */
const SETTLE_MS = 1_200;
const SETTLE_QUIET_MS = 300;

const TOOLS: Tool[] = [
  {
    name: "terminal_list",
    description: "List this space's terminal panes (id, title, working directory, whether a shell is still running). Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "terminal_open",
    description:
      "Open a terminal pane in this space and return its terminalId. Use this — rather than your own shell tool — only for a program that needs a terminal to talk back to: an interactive login, a prompt that asks a question, a full-screen TUI. For running a command and reading its output, your own shell tool is better. Asks the user for permission.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string", description: "absolute path to start the shell in (default: the space's folder)" } },
      additionalProperties: false,
    },
  },
  {
    name: "terminal_read",
    description:
      "What the terminal is SHOWING right now, rendered the way the pane draws it — not the raw bytes. A full-screen program's repaints are resolved, so you get the four lines on screen rather than everything it has ever printed, and a wrapped URL comes back whole. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        terminalId: { type: "string" },
        scrollback: { type: "number", description: `how many lines above the visible screen to include as well (0–${MAX_SCROLLBACK_LINES}, default 0)` },
      },
      required: ["terminalId"],
      additionalProperties: false,
    },
  },
  {
    name: "terminal_write",
    description:
      "Type into a terminal, then hand back the screen once it settles. `text` is typed literally; `submit` presses Return after it; `key` sends one named key (enter, tab, escape, backspace, up, down, left, right, ctrl-c, ctrl-d) for answering a menu or interrupting. Refuses, in every permission mode, while the terminal is asking for a password. Asks the user for permission.",
    inputSchema: {
      type: "object",
      properties: {
        terminalId: { type: "string" },
        text: { type: "string", description: "typed literally, exactly as given" },
        submit: { type: "boolean", description: "press Return after the text (default false)" },
        key: { type: "string", enum: Object.keys(TERMINAL_KEYS), description: "one named key, sent after `text` if both are given" },
      },
      required: ["terminalId"],
      additionalProperties: false,
    },
  },
  {
    name: "terminal_wait",
    description:
      "Wait for a terminal, then return its screen. With `until`, waits for that regular expression to match what is on screen — the way to wait for a specific prompt or a URL to appear. Without it, waits for output to stop. Either way it returns when the timeout runs out, with whatever is there and a note that it did. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        terminalId: { type: "string" },
        until: { type: "string", description: "JavaScript regular expression source, tested against the whole screen" },
        timeoutMs: { type: "number", description: "how long to wait (default 15000, max 120000)" },
      },
      required: ["terminalId"],
      additionalProperties: false,
    },
  },
  {
    name: "terminal_close",
    description: "Close a terminal pane and kill its shell. Asks the user for permission.",
    inputSchema: {
      type: "object",
      properties: { terminalId: { type: "string" } },
      required: ["terminalId"],
      additionalProperties: false,
    },
  },
];

/** Everything a handler is given: the deps, who is calling, and the ownership ledger. */
type Call = {
  d: TerminalAgentToolsDeps;
  ctx: ProviderCallContext;
  opened: Map<string, Set<string>>;
  ownedBy: (sessionId: string, terminalId: string) => boolean;
};

type Handler = (c: Call, args: unknown) => Promise<CallToolResult>;

const TerminalIdArgs = z.object({ terminalId: z.string().min(1) });

const HANDLERS: Record<string, Handler> = {
  terminal_list: async ({ d, ctx }) => {
    const rows = d.rows.listBySpace(ctx.spaceId);
    if (rows.length === 0) return ok("This space has no terminal panes. terminal_open starts one.");
    const lines = rows.map((r) => {
      const title = d.items.findByRefId(r.id)?.title ?? "Terminal";
      return `${r.id}  ${title}  cwd=${r.cwd}  ${d.terminals.has(r.id) ? "running" : "exited"}`;
    });
    return ok(lines.join("\n"));
  },

  terminal_open: async ({ d, ctx, opened }, raw) => {
    const args = parseArgs(z.object({ cwd: z.string().optional() }), raw);
    if ("error" in args) return args.error;
    const gate = await d.broker.gate(
      ctx.sessionId, "terminal_open",
      args.value.cwd ? `Open a terminal in ${args.value.cwd}` : "Open a terminal in this space",
      { cwd: args.value.cwd ?? null }, "terminal_open",
    );
    if (!gate.allowed) return err(gate.reason);

    // The size a shell is spawned at, before any pane has mounted and resized it. Wider and taller
    // than the 80×24 `terminals.create` defaults to, because nothing is looking at this one yet and
    // the programs it exists to run — full-screen logins — lay themselves out against the size they
    // find. A menu that fits is a menu an agent can read in one go.
    const { terminalId } = d.terminals.open({ spaceId: ctx.spaceId, cwd: args.value.cwd, cols: 100, rows: 30 });
    let mine = opened.get(ctx.sessionId);
    if (!mine) opened.set(ctx.sessionId, (mine = new Set()));
    mine.add(terminalId);
    // Give the login shell a moment to finish printing its own startup, so the first read is a
    // prompt rather than half a motd.
    await d.terminals.quiet(terminalId, SETTLE_QUIET_MS, SETTLE_MS);
    return withScreen(d, terminalId, `Opened terminal ${terminalId}.`, 0);
  },

  terminal_read: async ({ d, ctx }, raw) => {
    const args = parseArgs(TerminalIdArgs.extend({ scrollback: z.number().int().min(0).max(MAX_SCROLLBACK_LINES).optional() }), raw);
    if ("error" in args) return args.error;
    const check = requireTerminal(d, ctx, args.value.terminalId);
    if (check) return check;
    return withScreen(d, args.value.terminalId, null, args.value.scrollback ?? 0);
  },

  terminal_write: async (c, raw) => {
    const args = parseArgs(
      TerminalIdArgs.extend({
        text: z.string().optional(),
        submit: z.boolean().optional(),
        key: z.enum(Object.keys(TERMINAL_KEYS) as [TerminalKey, ...TerminalKey[]]).optional(),
      }).refine((v) => v.text !== undefined || v.key !== undefined, { message: "give `text`, `key`, or both" }),
      raw,
    );
    if ("error" in args) return args.error;
    const { d, ctx } = c;
    const { terminalId, text, submit, key } = args.value;
    const check = requireTerminal(d, ctx, terminalId);
    if (check) return check;
    if (!d.terminals.has(terminalId)) return err(`terminal ${terminalId} has exited — its shell is gone. terminal_open starts a new one.`);

    // The refusal comes first, and it is read from the LIVE screen rather than from anything the
    // caller said: what a terminal is asking for is a fact about the terminal, and a snapshot taken
    // before the last program started would be the wrong fact.
    const before = await d.terminals.screen(terminalId);
    if (!before) return err(`terminal ${terminalId} is not readable — it may have just exited.`);
    const asking = looksLikePasswordPrompt(before);
    if (asking) return err(PASSWORD_REFUSAL(asking));

    const bytes = (text ?? "") + (submit ? TERMINAL_KEYS.enter : "") + (key ? TERMINAL_KEYS[key] : "");
    const title = describeWrite(text, submit, key);
    const gate = await d.broker.gate(
      ctx.sessionId, `terminal_write:${terminalId}`, title,
      { terminalId, text: text ?? null, submit: submit ?? false, key: key ?? null }, "terminal_write",
      { promptUnderBypass: !c.ownedBy(ctx.sessionId, terminalId) },
    );
    if (!gate.allowed) return err(gate.reason);

    return runTracked(d, ctx.spaceId, terminalId, title, async () => {
      // `writeWhenQuiet` rather than a bare write: a shell still printing its startup mangles what
      // arrives mid-stream, the leading character especially. `manager` is reached directly because
      // the service's own `prefill` is documented as never appending a newline — that is the right
      // promise for a command Realm offers a user, and the wrong one for a key an agent is sending.
      await d.terminals.manager.writeWhenQuiet(terminalId, bytes);
      await d.terminals.quiet(terminalId, SETTLE_QUIET_MS, SETTLE_MS);
      return withScreen(d, terminalId, null, 0);
    });
  },

  terminal_wait: async ({ d, ctx }, raw) => {
    const args = parseArgs(
      TerminalIdArgs.extend({ until: z.string().optional(), timeoutMs: z.number().int().min(100).max(120_000).optional() }),
      raw,
    );
    if ("error" in args) return args.error;
    const check = requireTerminal(d, ctx, args.value.terminalId);
    if (check) return check;
    const { terminalId, until, timeoutMs = 15_000 } = args.value;

    if (until === undefined) {
      const alive = await d.terminals.quiet(terminalId, 500, timeoutMs);
      return withScreen(d, terminalId, alive ? null : "The shell exited while waiting.", 0);
    }

    let re: RegExp;
    try { re = new RegExp(until); } catch (e) {
      return err(`\`until\` is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`);
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const screen = await d.terminals.screen(terminalId);
      if (!screen) return err(`terminal ${terminalId} is not readable — it may have just exited.`);
      if (re.test(screenText(screen))) return screenResult(screen, `Matched ${JSON.stringify(until)}.`);
      if (Date.now() >= deadline) {
        return screenResult(screen, `Timed out after ${timeoutMs}ms without matching ${JSON.stringify(until)}. This is the screen as it stands.`);
      }
      // Re-render only once new bytes have arrived: the screen cannot have changed without them, and
      // the emulator is a real parse over the whole ring. `quiet` returning false means the pty is
      // gone, so there will never be more output and one last look is all that is left.
      const stillAlive = await d.terminals.quiet(terminalId, 150, Math.min(400, Math.max(100, deadline - Date.now())));
      if (!stillAlive) {
        const last = await d.terminals.screen(terminalId);
        return screenResult(last ?? screen, "The shell exited before the pattern matched.");
      }
    }
  },

  terminal_close: async (c, raw) => {
    const args = parseArgs(TerminalIdArgs, raw);
    if ("error" in args) return args.error;
    const { d, ctx } = c;
    const { terminalId } = args.value;
    const check = requireTerminal(d, ctx, terminalId);
    if (check) return check;
    const gate = await d.broker.gate(
      ctx.sessionId, `terminal_close:${terminalId}`, "Close this terminal and kill its shell",
      { terminalId }, "terminal_close",
      { promptUnderBypass: !c.ownedBy(ctx.sessionId, terminalId) },
    );
    if (!gate.allowed) return err(gate.reason);
    d.terminals.close(terminalId);
    c.opened.get(ctx.sessionId)?.delete(terminalId);
    return ok(`Closed terminal ${terminalId}.`);
  },
};

/* ---------------------------------- helpers ---------------------------------- */

/**
 * Refuse a terminal that is not this space's.
 *
 * A space is the boundary every other provider draws too, and it matters more here than it looks:
 * terminal ids are opaque, so an agent that learned one from a transcript in another space would
 * otherwise be typing into a shell sitting in somebody else's checkout.
 */
function requireTerminal(d: TerminalAgentToolsDeps, ctx: ProviderCallContext, terminalId: string): CallToolResult | null {
  const row = d.rows.get(terminalId);
  if (!row) return err(`no terminal ${terminalId} — terminal_list shows this space's terminals.`);
  if (row.spaceId !== ctx.spaceId) return err(`terminal ${terminalId} belongs to another space.`);
  return null;
}

/** The screen as a tool result: the note, then the fenced text. */
function screenResult(screen: TerminalScreen, note: string | null): CallToolResult {
  const body = screenText(screen);
  const state = screen.altScreen
    ? "A full-screen program is running, so this screen IS the whole state — there is no history above it."
    : null;
  const head = [note, state].filter(Boolean).join(" ");
  const fenced = fenceUntrusted(body === "" ? "(the screen is empty)" : body, "TERMINAL OUTPUT");
  return ok(head ? `${head}\n\n${fenced}` : fenced);
}

async function withScreen(d: TerminalAgentToolsDeps, terminalId: string, note: string | null, scrollback: number): Promise<CallToolResult> {
  const screen = await d.terminals.screen(terminalId, scrollback);
  if (!screen) return err(`terminal ${terminalId} is not readable — it may have just exited.`);
  return screenResult(screen, note);
}

/** What the permission card says. The text is quoted rather than described, because what is about to
 *  be typed into someone's shell is exactly the thing they are being asked to approve. */
function describeWrite(text: string | undefined, submit: boolean | undefined, key: TerminalKey | undefined): string {
  const parts: string[] = [];
  if (text !== undefined && text !== "") parts.push(`Type ${JSON.stringify(text)}`);
  if (submit) parts.push(parts.length > 0 ? "and press Return" : "Press Return");
  if (key) parts.push(parts.length > 0 ? `and send ${key}` : `Send ${key}`);
  return parts.length > 0 ? `${parts.join(" ")} in the terminal` : "Type in the terminal";
}

/**
 * Wrap one mutating operation with the watching broadcasts, exactly as the browser tools do:
 * `terminal.driving` true before it runs and false once it settles — in a `finally`, so a throw can
 * never leave the pane looking driven — then one `terminal.action` carrying what the card said.
 */
async function runTracked(
  d: TerminalAgentToolsDeps, spaceId: string, terminalId: string, text: string,
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  d.rpc.broadcast("terminal.driving", { spaceId, terminalId, driving: true });
  let succeeded = false;
  try {
    const result = await fn();
    succeeded = !result.isError;
    return result;
  } finally {
    d.rpc.broadcast("terminal.driving", { spaceId, terminalId, driving: false });
    d.rpc.broadcast("terminal.action", { spaceId, terminalId, text, ok: succeeded, ts: Date.now() });
  }
}

/** The tools that run free in every mode — read by the capabilities preamble and by tests. */
export const TERMINAL_READ_ONLY_TOOLS: readonly string[] = [...READ_ONLY_TOOLS];
