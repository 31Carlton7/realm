import { AGENT_CLI_COMMANDS, AGENT_LOGIN_HINTS, agentLabel, type AgentKind } from "@realm/contracts";
import { isOAuthConsentUrl } from "./guards";
import { screenText, type TerminalScreen } from "../terminals/screen";
import type { SignInTickets } from "./signin";

/**
 * Signing an agent CLI in, without handing the user a command to go and run.
 *
 * `InstallCard.tsx` states the position this replaces, in its own header comment: "A signed-out
 * agent is always the second case, because logging in is a browser flow or an API key, not a command
 * Realm can run to completion on someone's behalf." That was true of a command Realm could only
 * spawn and read. It stops being true once Realm has a terminal that talks back and a browser pane
 * beside it, which is every piece this flow is assembled from.
 *
 * The shape of the thing, and why each step is where it is:
 *
 *  1. **A real terminal pane**, not a hidden subprocess. `claude auth login` is a full-screen TUI
 *     that waits; under `bash -c` it hangs with nothing on screen to say why. The pane is also the
 *     honest half of the design — a sign-in happening on someone's behalf should be something they
 *     are watching, and can take over at any point by typing into it themselves.
 *  2. **The command comes from `AGENT_CLI_COMMANDS`**, never from a caller. That is what makes the
 *     URL this flow later reads PROVENANCED: it came out of a program Realm chose to run, not out of
 *     anything an agent said or a page influenced. `SignInTickets` is built on that fact.
 *  3. **The URL is read off the rendered screen**, so a wrapped one arrives whole (`screen.ts`).
 *  4. **Realm opens the pane**, through the browser service rather than the agent's tools — an agent
 *     still cannot navigate to a consent screen, and this flow does not give it a way to.
 *  5. **The last click is the user's**, unless the space said otherwise. See `signin.ts`.
 *
 * What this never does is type the code back. The step after consent — reading a code off the page
 * and returning it to the terminal — is left to the caller with both ids in hand, because at that
 * point it is two ordinary tool calls on two panes that already exist, and burying them here would
 * hide from the transcript the one part a person most wants to see.
 */

/** How long to wait for a login command to print its URL before giving up and handing back what is
 *  on screen. Generous: the CLI may be checking for an update, or asking which account first. */
export const URL_WAIT_MS = 45_000;

export type SignInStart =
  | { ok: false; reason: string }
  | {
      ok: true;
      terminalId: string;
      command: string;
      /**
       * The rest of it: waiting for the URL and opening the pane, which together take as long as the
       * CLI takes to print.
       *
       * Split from the call rather than awaited inside it because the two callers want different
       * moments. A tool call wants the whole outcome and can block for it. A BUTTON cannot: the
       * terminal appears the instant it is opened and the user is already watching it, so a click
       * that sat for forty-five seconds before the UI acknowledged it would be reporting, very late,
       * something they had been looking at the whole time.
       *
       * It never rejects. A caller that does not await it must not be able to produce an unhandled
       * rejection, and a caller that does is owed an outcome rather than a throw — a sign-in whose
       * URL never arrived is a real result with a screen attached, not an error.
       */
      settled: Promise<SignInSettled>;
    };

/** How a started sign-in turned out, once the CLI has had its say. */
export type SignInSettled = {
  /** Null when the command printed no URL before `URL_WAIT_MS` — the terminal is still there and
   *  still running, and the screen says what it is doing instead. */
  url: string | null;
  browserId: string | null;
  /** True when a ticket was minted, i.e. this space lets Realm press Authorize itself. */
  mayAuthorize: boolean;
  screen: TerminalScreen;
};

export type SignInFlowDeps = {
  terminals: {
    open(p: { spaceId: string; cwd?: string; cols: number; rows: number }): { terminalId: string; itemId: string };
    screen(terminalId: string, scrollback?: number): Promise<TerminalScreen | null>;
    quiet(terminalId: string, quietMs?: number, timeoutMs?: number): Promise<boolean>;
    manager: { writeWhenQuiet(id: string, data: string): Promise<void> };
  };
  browsers: { open(p: { spaceId: string; url: string }): { browserId: string; itemId: string; url: string } };
  tickets: Pick<SignInTickets, "mint" | "enabled">;
  now?: () => number;
};

export class SignInFlow {
  constructor(private readonly d: SignInFlowDeps) {}

  async start(spaceId: string, kind: AgentKind): Promise<SignInStart> {
    const command = AGENT_CLI_COMMANDS[kind]?.login;
    if (!command) {
      // Gemini is the one with no login command: Google discontinued its free personal tier, so the
      // route is an API key or Vertex credentials — a sentence rather than a line to run. (goose
      // looks like a sibling and is not: `goose configure` is a real command and runs here fine.)
      // The hint is the whole answer, and `authFix` already gives the same one.
      return { ok: false, reason: `${agentLabel(kind)} has no sign-in command Realm can run. ${AGENT_LOGIN_HINTS[kind]}` };
    }

    // Wider and taller than the 80×24 default: what runs here lays itself out against the size it
    // finds, and a menu that fits on screen is one that can be read in a single look.
    const { terminalId } = this.d.terminals.open({ spaceId, cols: 100, rows: 30 });
    await this.d.terminals.quiet(terminalId, 300, 4_000);
    await this.d.terminals.manager.writeWhenQuiet(terminalId, `${command}\r`);
    return { ok: true, terminalId, command, settled: this.settle(spaceId, terminalId) };
  }

  /** The waiting half. Every failure becomes an outcome, for the reason `settled` gives. */
  private async settle(spaceId: string, terminalId: string): Promise<SignInSettled> {
    try {
      const found = await this.waitForUrl(terminalId);
      if (!found.url) return { url: null, browserId: null, mayAuthorize: false, screen: found.screen };
      const opened = this.d.browsers.open({ spaceId, url: found.url });
      this.d.tickets.mint(spaceId, opened.browserId, found.url);
      return {
        url: found.url, browserId: opened.browserId,
        mayAuthorize: this.d.tickets.enabled(spaceId), screen: found.screen,
      };
    } catch {
      return { url: null, browserId: null, mayAuthorize: false, screen: EMPTY_SCREEN };
    }
  }

  /** Poll the rendered screen until a sign-in URL appears on it, or the clock runs out. */
  private async waitForUrl(terminalId: string): Promise<{ url: string | null; screen: TerminalScreen }> {
    const now = this.d.now ?? Date.now;
    const deadline = now() + URL_WAIT_MS;
    let screen = await this.d.terminals.screen(terminalId);
    for (;;) {
      if (screen) {
        const url = signInUrlOn(screen);
        if (url) return { url, screen };
      }
      if (now() >= deadline) return { url: null, screen: screen ?? EMPTY_SCREEN };
      // Only re-read once the program has said something more; `quiet` false means its shell died,
      // and then one last look at the screen is all that is left to do.
      const alive = await this.d.terminals.quiet(terminalId, 200, 1_000);
      screen = await this.d.terminals.screen(terminalId);
      if (!alive) return { url: screen ? signInUrlOn(screen) : null, screen: screen ?? EMPTY_SCREEN };
    }
  }
}

const EMPTY_SCREEN: TerminalScreen = { screen: [], scrollback: [], cursor: { row: 0, col: 0 }, cols: 100, rows: 30, altScreen: false };

/**
 * The sign-in URL a login command has printed, or null.
 *
 * A consent URL is PREFERRED over the first URL on screen rather than assumed to be it, because
 * these programs print other links while they work — a docs link in a banner, an update notice, a
 * privacy policy beside the button. Taking the first match would open a documentation page and wait
 * for a consent that was never going to arrive there.
 *
 * Trailing punctuation is trimmed for the ordinary reason: a URL at the end of an English sentence
 * takes the full stop with it, and prose around these links is common ("visit https://… to
 * continue."). Brackets are trimmed only when unbalanced, so a URL that genuinely contains one
 * survives.
 */
export function signInUrlOn(screen: TerminalScreen): string | null {
  const urls = [...screenText(screen).matchAll(/https?:\/\/[^\s"'<>`]+/g)].map((m) => trimTrailing(m[0]));
  return urls.find((u) => isOAuthConsentUrl(u)) ?? urls[0] ?? null;
}

function trimTrailing(url: string): string {
  let out = url;
  for (;;) {
    const last = out[out.length - 1];
    if (last === undefined) return out;
    if (".,;:!?".includes(last)) { out = out.slice(0, -1); continue; }
    const opener = last === ")" ? "(" : last === "]" ? "[" : null;
    // Strictly FEWER openers than closers: "…/a(b)" is balanced and keeps its bracket, while
    // "(https://…/login)" has one closer too many and gives it back to the sentence.
    if (opener && out.split(opener).length < out.split(last).length) { out = out.slice(0, -1); continue; }
    return out;
  }
}
