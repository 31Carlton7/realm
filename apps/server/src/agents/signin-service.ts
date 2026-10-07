import * as pty from "node-pty";
import { homedir } from "node:os";
import {
  AGENT_CLI_COMMANDS, AGENT_LOGIN_HINTS, agentLabel, newId,
  type AgentKind, type AgentSignIn,
} from "@realm/contracts";
import { claudeExecutable, type ProbeResult } from "@realm/adapters";
import { agentBin } from "../cli/bins";
import { resolveInstall } from "../cli/provenance";
import { signInUrlOn } from "../browsers/signin-flow";
import { renderScreen, screenText, type TerminalScreen } from "../terminals/screen";
import { NotFoundError, RpcError } from "../store/rows";
import type { RpcServer } from "../rpc/server";

/**
 * Signing an agent CLI in before there is a space to do it in.
 *
 * `signin-flow.ts` is the in-space version, and it is right for a space: a terminal pane the person
 * watches and can take over, and a consent page opened beside it. The first run has neither — no
 * space, so nowhere for a pane to open — and its two buttons, "Sign in with Claude" and "Sign in
 * with ChatGPT", need the same login done with nothing on screen but the button. So the CLI's own
 * login runs in a pty this service owns, and the rendered screen is read for the two things a person
 * needs from it: the sign-in page, and a prompt for a code to paste back.
 *
 * What it reuses, and what it deliberately does not:
 *
 *  - **The command is Realm's**, from `AGENT_CLI_COMMANDS`, never a caller's — the same rule, for the
 *    same reason, as the in-space flow.
 *  - **The screen is read with `screen.ts`**, on demand, so a URL the pty wrapped arrives whole and
 *    the bytes cost nothing when nobody is reading. `signInUrlOn` picks the consent link out of it.
 *  - **The browser is the CLI's.** Both CLIs open the sign-in page themselves; opening it again from
 *    here would put two tabs in front of someone who asked for one. `url` exists so the renderer can
 *    offer "Open the page again", not so this service can open it.
 *  - **A clean exit is not taken for a sign-in.** It is confirmed by a fresh probe of that agent,
 *    whose answer goes into the cache every screen reads, so `done` means what every other screen in
 *    Realm will say next. Only that agent: the whole probe waits on every adapter, and one of them
 *    can take half a minute to say it has nothing to do with this.
 *
 * Nothing typed is ever logged or broadcast. The tty echoes what Realm types, so a code that was
 * pasted is on the CLI's screen afterwards — `lastWords` cuts it out of anything this reports.
 */

/** What runs for one agent's login: a binary, resolved, and the table's own subcommand. */
export type LoginCommand = { file: string; args: string[] };

export type AgentSignInDeps = {
  rpc: Pick<RpcServer, "broadcast">;
  /** `SessionService.probeAgent` — a fresh probe of the one agent whose login just exited, which
   *  also puts its answer in the cache every other probe caller rides. */
  probe: (kind: AgentKind) => Promise<ProbeResult | undefined>;
  /** What to spawn for `kind`'s login, or null when it is not on this Mac. `loginCommand` unless a
   *  suite hands in a fake login program — which is the only way a suite may run one. */
  command?: (kind: AgentKind) => Promise<LoginCommand | null>;
  /** Whose PATH and REALM_*_BIN overrides are read, and what the CLI inherits. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
};

/** A login is a person in a browser — they may be reading a consent screen, or finding a password.
 *  Ten minutes is generous for that and still ends a CLI that was never going to finish. */
export const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

/** The in-space flow's size, for the in-space flow's reason: a CLI lays itself out against the size
 *  it finds, and a URL wrapped across fewer rows is fewer seams for the screen to rejoin. */
const COLS = 100;
const ROWS = 30;
/** Every login measured prints a handful of lines; a few hundred keeps the URL in view even if the
 *  CLI goes on talking after it. */
const SCROLLBACK = 200;
/** Output is kept as a tail. The screen is rebuilt from it on each look, so it is bounded the way the
 *  terminal ring is — a runaway program costs a capped string, not a growing one. */
const OUTPUT_KEEP = 64 * 1024;
/** How long after output arrives the screen is read. Coalesces a burst (claude prints its three lines
 *  in one breath) into one look, without ever waiting for a CLI that never goes quiet. */
const LOOK_AFTER_MS = 120;
/** SIGHUP first — it is what closing a terminal sends, and every CLI handles it. A CLI still there
 *  this long after is not going to leave on its own. */
const KILL_GRACE_MS = 2_000;
/** How much of a failed CLI's screen `detail` carries: its last few lines, which is where the error
 *  is, and never more than a tooltip can hold. */
const DETAIL_LINES = 4;
const DETAIL_MAX = 400;
/** Finished sign-ins kept, so a late `code` or `cancel` gets a precise answer rather than "unknown". */
const KEEP_FINISHED = 16;

const TIMED_OUT = "The sign-in timed out before it finished. Start it again when you're ready.";
const REALM_CLOSED = "Realm closed before the sign-in finished.";

type State = AgentSignIn["state"];
const isFinal = (s: State): boolean => s === "done" || s === "failed" || s === "cancelled";
/** The order the renderer applies states in (a late one never walks a sign-in back), and the order
 *  this service moves them in, so the two cannot disagree about what "later" means. */
const RANK: Record<"starting" | "browser" | "code", number> = { starting: 0, browser: 1, code: 2 };

type Run = {
  id: string;
  kind: AgentKind;
  state: State;
  url: string | null;
  detail: string | null;
  term: pty.IPty | null;
  /** The pty's process is gone — by its own exit or Realm's kill. */
  exited: boolean;
  output: string;
  /** Every code typed in, held only so `lastWords` can cut each one out. */
  typed: string[];
  lookTimer: ReturnType<typeof setTimeout> | null;
  deadline: ReturnType<typeof setTimeout> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
  looking: boolean;
  lookAgain: boolean;
};

const snapshot = (r: Run): AgentSignIn => ({ id: r.id, kind: r.kind, state: r.state, url: r.url, detail: r.detail });

export class AgentSignInService {
  private runs = new Map<string, Run>();
  /** The one unfinished sign-in per agent. */
  private live = new Map<AgentKind, Run>();

  constructor(private readonly d: AgentSignInDeps) {}

  /** Start `kind`'s login and answer with its first state; every later one is broadcast. Refuses an
   *  agent with no login command, and one whose CLI is not on this Mac. */
  async start(kind: AgentKind): Promise<AgentSignIn> {
    if (!AGENT_CLI_COMMANDS[kind].login) {
      // Gemini and DeepSeek: an API key is a sentence, not a line to run. Same answer as the
      // in-space flow gives, because it is the same fact.
      throw new RpcError("BAD_REQUEST", `${agentLabel(kind)} has no sign-in command Realm can run. ${AGENT_LOGIN_HINTS[kind]}`);
    }
    const env = this.d.env ?? process.env;
    const command = await (this.d.command ?? ((k: AgentKind) => loginCommand(k, env)))(kind);
    if (!command) throw new RpcError("CLI_NOT_INSTALLED", `${agentLabel(kind)} isn't on this Mac yet, so there is nothing to sign in to. Install it first.`);

    // After the await, not before it: two starts racing for one agent still leave exactly one
    // running, because whichever resumes second finds the first here and replaces it.
    const prior = this.live.get(kind);
    if (prior) this.end(prior, "cancelled", null);

    const run: Run = {
      id: newId(), kind, state: "starting", url: null, detail: null, term: null, exited: false,
      output: "", typed: [], lookTimer: null, deadline: null, killTimer: null, looking: false, lookAgain: false,
    };
    this.runs.set(run.id, run);
    this.live.set(kind, run);
    try {
      /* Spawned directly, not typed into a login shell the way `signin-flow.ts` does it. That shell
         is a visible pane a person can take over; here nobody is watching, and a shell would only add
         what the screen-reading has to see past — a prompt, the command echoed, whatever an rc file
         prints or asks. PATH is no reason to want one: the server starts with the login shell's PATH
         already merged in (see `provenance.ts`), which is the PATH the probe found this binary on, so
         the sign-in runs the very copy the probe judged. And the exit status is the CLI's own.

         In the user's home: where a fresh Terminal window would have run it. Not a project, because
         Claude Code reads a project's `.claude/settings.json` from where it runs, and a repo's
         settings can steer a sign-in (`forceLoginMethod`, `forceLoginOrgUUID`). Not Realm's home
         either — that is Realm's data folder, and nothing a third-party CLI writes belongs in it. */
      run.term = pty.spawn(command.file, command.args, { name: "xterm-256color", cols: COLS, rows: ROWS, cwd: this.d.cwd ?? homedir(), env });
    } catch (e) {
      this.end(run, "failed", `${agentLabel(kind)}'s sign-in could not start: ${(e as Error).message}`);
      return snapshot(run);
    }
    run.term.onData((chunk) => this.heard(run, chunk));
    run.term.onExit(({ exitCode, signal }) => {
      run.exited = true;
      if (run.killTimer) clearTimeout(run.killTimer);
      void this.exited(run, exitCode, signal ?? 0);
    });
    run.deadline = setTimeout(() => this.end(run, "failed", TIMED_OUT), this.d.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
    run.deadline.unref?.();
    this.say(run);
    return snapshot(run);
  }

  /**
   * Type the code the sign-in page showed into the CLI that asked for it, and press Return.
   *
   * Only into a CLI that is asking: a code typed while it is still printing would land in whatever
   * it reads next. Trimmed, because a paste carries its line ending; refused outright if anything
   * else in it is a control character — `\x03` in a pty is a SIGINT, and no sign-in page shows one.
   */
  code(id: string, code: string): void {
    const run = this.runs.get(id);
    if (!run) throw new NotFoundError("sign-in", id);
    if (isFinal(run.state) || run.exited || !run.term) throw new RpcError("SIGN_IN_FINISHED", "That sign-in has already finished.");
    if (run.state !== "code") throw new RpcError("SIGN_IN_NOT_ASKING", `${agentLabel(run.kind)} isn't asking for a code yet.`);
    const typed = code.trim();
    if (typed === "" || /[\u0000-\u001f\u007f]/.test(typed)) throw new RpcError("BAD_REQUEST", "That doesn't look like the code from the sign-in page. Copy it again and paste it here.");
    run.typed.push(typed);
    run.term.write(`${typed}\r`);
  }

  /** Stop a sign-in. Idempotent: a finished one is left as it finished, and an id this process never
   *  issued — a renderer that outlived the last server — has nothing left to stop. */
  cancel(id: string): void {
    const run = this.runs.get(id);
    if (run) this.end(run, "cancelled", null);
  }

  /** Shutdown: no CLI outlives the server that was reading it. Reported as failed rather than
   *  cancelled — nobody asked for it to stop — so a window that survives a daemon handoff says
   *  "didn't finish, try again", which is the truth. */
  disposeAll(): void {
    for (const run of [...this.live.values()]) this.end(run, "failed", REALM_CLOSED);
  }

  private heard(run: Run, chunk: string): void {
    run.output = (run.output + chunk).slice(-OUTPUT_KEEP);
    if (run.lookTimer || isFinal(run.state)) return;
    run.lookTimer = setTimeout(() => { run.lookTimer = null; void this.look(run); }, LOOK_AFTER_MS);
  }

  /** Read the screen and move the sign-in forward. One look at a time; output arriving during one is
   *  looked at again once it lands, so the last thing a CLI prints is never left unread. */
  private async look(run: Run): Promise<void> {
    if (run.looking) { run.lookAgain = true; return; }
    run.looking = true;
    try {
      const screen = await this.render(run);
      // Once the process is gone, its exit decides — not a look that was already in flight.
      if (run.exited || isFinal(run.state)) return;
      this.advance(run, screen);
    } finally {
      run.looking = false;
      if (run.lookAgain) { run.lookAgain = false; void this.look(run); }
    }
  }

  private advance(run: Run, screen: TerminalScreen): void {
    if (run.state !== "starting" && run.state !== "browser" && run.state !== "code") return;
    let state: "starting" | "browser" | "code" = run.state;
    let url = run.url;
    // Frozen once a code has been typed: the echo is on screen by then, and whatever a person pasted
    // — a whole callback URL is a common mistake — must not become the "page to open again".
    const seen = run.typed.length === 0 ? signInPageOn(screen) : null;
    if (seen) url = seen;
    if (url && RANK[state] < RANK.browser) state = "browser";
    if (asksForCode(screen)) state = "code";
    if (state === run.state && url === run.url) return;
    run.state = state;
    run.url = url;
    this.say(run);
  }

  private async exited(run: Run, exitCode: number, signal: number): Promise<void> {
    if (isFinal(run.state)) return; // Realm ended it; this is its own kill landing
    if (run.lookTimer) { clearTimeout(run.lookTimer); run.lookTimer = null; }
    if (run.deadline) { clearTimeout(run.deadline); run.deadline = null; }
    const label = agentLabel(run.kind);
    const screen = await this.render(run);
    // A signal reports exit code 0 from node-pty, so a CLI something else killed would otherwise
    // read as a clean finish.
    if (exitCode !== 0 || signal !== 0) {
      const how = signal !== 0 ? `was stopped (signal ${signal})` : `exited with code ${exitCode}`;
      this.end(run, "failed", lastWords(screen, run.typed) ?? `${label}'s sign-in ${how} without saying why.`);
      return;
    }
    // `end` ignores a run that is already final, so a cancel or a replacement that lands while this
    // probe is out wins — the person asked for that after the CLI finished.
    const probe = await this.d.probe(run.kind).catch(() => undefined);
    if (probe?.loggedIn === false) {
      const said = lastWords(screen, run.typed);
      this.end(run, "failed", clip(`${label} finished, but it still says it isn't signed in.${said ? `\n${said}` : ""}`));
      return;
    }
    // `null` is "the probe could not tell" (the keychain, an old CLI) — not evidence of a failure,
    // after a CLI that has just exited cleanly from its own login.
    this.end(run, "done", null);
  }

  private end(run: Run, state: "done" | "failed" | "cancelled", detail: string | null): void {
    if (isFinal(run.state)) return;
    run.state = state;
    run.detail = detail;
    for (const t of [run.lookTimer, run.deadline]) if (t) clearTimeout(t);
    run.lookTimer = null;
    run.deadline = null;
    if (this.live.get(run.kind) === run) this.live.delete(run.kind);
    if (run.term && !run.exited) {
      const term = run.term;
      term.kill();
      run.killTimer = setTimeout(() => { if (!run.exited) term.kill("SIGKILL"); }, KILL_GRACE_MS);
      run.killTimer.unref?.();
    }
    this.say(run);
    this.prune();
  }

  private say(run: Run): void {
    this.d.rpc.broadcast("agentSignIn.changed", snapshot(run));
  }

  /** The screen as a person would see it. Never rejects: a look is fire-and-forget, and a look that
   *  could throw would be an unhandled rejection in the server. */
  private async render(run: Run): Promise<TerminalScreen> {
    try {
      return await renderScreen(run.output, { cols: COLS, rows: ROWS, scrollback: SCROLLBACK });
    } catch {
      return { screen: [], scrollback: [], cursor: { row: 0, col: 0 }, cols: COLS, rows: ROWS, altScreen: false };
    }
  }

  private prune(): void {
    const finished = [...this.runs.values()].filter((r) => isFinal(r.state));
    for (const r of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) this.runs.delete(r.id);
  }
}

/**
 * What runs for `kind`'s login on this Mac, or null when its CLI is not here.
 *
 * The table's first word names the binary and the rest is the subcommand; the binary is resolved the
 * way the probe resolves it, override first, so a sign-in runs the copy the probe judged. That makes
 * REALM_CLAUDE_BIN and REALM_CODEX_BIN reach the sign-in too — which is what lets a live check point
 * one at a stub, and an override that does not resolve is refused rather than replaced by whatever is
 * on PATH: falling back there would start a real login on the owner's account.
 *
 * Claude has one more place to look than the rest, because it is the one Realm carries itself:
 * with no override and no `claude` on PATH, the Agent SDK's own binary (`claudeExecutable`).
 */
export async function loginCommand(kind: AgentKind, env: NodeJS.ProcessEnv = process.env): Promise<LoginCommand | null> {
  const login = AGENT_CLI_COMMANDS[kind].login;
  if (!login) return null;
  const [, ...args] = login.split(/\s+/);
  if (kind === "claude") {
    const file = await claudeExecutable({ env });
    return file ? { file, args } : null;
  }
  const bin = agentBin(kind, env);
  const found = bin ? await resolveInstall(bin, env) : null;
  return found ? { file: found.path, args } : null;
}

/**
 * The page a person should be sent to, off the CLI's screen — and only an https one.
 *
 * `signInUrlOn` already prefers a consent URL to any other link. The scheme check is for what it
 * falls back to: `codex login` prints its own callback server (`http://localhost:1455`) a line
 * before the consent URL, and a screen read between the two would otherwise offer "open the page
 * again" on a port that only serves the redirect.
 */
function signInPageOn(screen: TerminalScreen): string | null {
  const url = signInUrlOn(screen);
  return url?.startsWith("https://") ? url : null;
}

/**
 * Whether the CLI is asking, right now, for a code to be pasted back.
 *
 * Read off the ACTIVE line — where the caret is, or the last line with anything on it — the way
 * `looksLikePasswordPrompt` reads a password prompt: a CLI that mentions pasting a code in passing is
 * not waiting for one. URLs are taken out first; a sign-in URL is full of `code=` and must not answer
 * for a prompt.
 *
 * `claude auth login` asks with "Paste code here if prompted >", written in the same breath as its
 * URL, so a Claude sign-in reaches `code` at once. That is the truth rather than a shortcut: it is
 * listening for the code from that moment, and the page it printed is the one that shows the code
 * (the browser it opened itself is the flow that needs none).
 */
function asksForCode(screen: TerminalScreen): boolean {
  const atCaret = screen.screen[screen.cursor.row] ?? "";
  const active = atCaret.trim() !== "" ? atCaret : [...screen.screen].reverse().find((l) => l.trim() !== "") ?? "";
  const words = active.replace(/https?:\/\/\S+/g, "");
  return /\bpaste\b/i.test(words) && /\bcode\b/i.test(words);
}

/**
 * What a sign-in last said, for `detail`: its final few lines with anything to them, every code typed
 * into it cut out first.
 *
 * The cut is not optional and it comes before the clip. The tty echoes what Realm types, so a CLI that
 * failed after a code was pasted has that code on its screen — and `detail` is broadcast to every
 * window. Clipping first could leave half a code behind for the cut to miss.
 */
function lastWords(screen: TerminalScreen, typed: readonly string[]): string | null {
  let text = screenText(screen);
  for (const c of typed) text = text.split(c).join("[code]");
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "").slice(-DETAIL_LINES);
  return lines.length > 0 ? clip(lines.join("\n")) : null;
}

/** The END of a long detail, which is where a CLI puts its error. */
function clip(text: string): string {
  return text.length <= DETAIL_MAX ? text : `…${text.slice(-(DETAIL_MAX - 1))}`;
}
