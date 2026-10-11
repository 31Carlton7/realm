/**
 * Live check of Realm's permission gate against the REAL `claude` and the rules it keeps itself.
 *
 * Claude Code puts a tool call to Realm only when none of its own permission rules answers first,
 * and a rule that allows the call runs it with no question. Those rules come from the settings
 * files a session loads and from the session itself, and two things Realm tells a person rest on
 * what the binary does with them:
 *
 *   - Allow always is for the session. On a card, Claude Code names where it would keep each rule
 *     it offers, and for a shell command that is `.claude/settings.local.json` in the session's
 *     folder. Realm hands every one back as kept for the session (`keptForSession`). Handed back
 *     as offered, the rule answered for every later session in that folder, and for the person's
 *     own Claude Code there.
 *   - A session that keeps the person's own Claude Code setup still asks. It starts under a policy
 *     that leaves the permission rules of their settings files out of force (`OWN_SETUP_POLICY`),
 *     so a call one of those rules allows reaches Realm's card, and Ask refuses it. Without the
 *     policy the same settings run the call with no question, in Ask as in any mode.
 *
 * The unit tests hold the adapter to what it hands Claude Code. What no unit test can hold up is
 * what the binary makes of it: that a rule kept for the session is written to no file and ends
 * with the session, and that under the policy a rule in the person's settings answers nothing
 * while a command Claude Code judges read-only still runs unasked. So this is the check to run
 * again when the Agent SDK is bumped.
 *
 * It uses no account and nothing is billed. The `claude` is the one the Agent SDK carries, which is
 * the one every Realm session runs, and its environment points it at a stand-in for the Anthropic
 * API on a loopback port (`stand-in-anthropic.ts`). The stand-in's model makes the tool call that a
 * message's cue names, a shell command that makes a file or a `Write`, and says one phrase when the
 * call has come back. Whether a call ran is read off the project's folder, where its file is or is
 * not.
 *
 * It drives `ClaudeAdapter.start` directly, where `live-workflow-check.ts` drives the whole server
 * over its socket. Everything checked here is the adapter's own: the answer to a card, the policy
 * and the gate are in `claude-adapter.ts`, and the server passes an answer, a mode and `ownSetup`
 * through to them unchanged. Each scenario is a session of its own:
 *
 *    1. Allow always: the command's card is answered Allow always. The command runs, nothing is
 *       written to `.claude/settings.local.json` under the project, and with the session back in
 *       the mode that asks each time the same command raises no card.
 *    2. A new session in that project raises the card again.
 *    3. A session that keeps the person's setup, whose settings allow the command and `Write`:
 *       each call raises a card and does not run when the card is denied, and a command that only
 *       reads runs with no card.
 *    4. The same session shape in Ask: both calls are refused in the gate's own words and neither
 *       runs.
 *    5. The control for 3 and 4: the same settings in a session that does not keep the setup and
 *       is not isolated run both calls with no card. Without it, 3 and 4 would pass where the
 *       settings had never applied.
 *
 * It writes nothing outside its own temp folder. The home and the config folders `claude` is given,
 * the projects and Claude Code's own temp files sit in one folder under the system temp folder,
 * removed at the end. That folder has to be outside your home folder, because Claude Code reads
 * `CLAUDE.md` from every folder above the one it works in and would take your own for project
 * instructions. Where the system temp folder leads into your home folder the check uses `/tmp`, and
 * where that does too it refuses to run.
 *
 * Run it from `apps/server` with vite-node, which vitest brings, as `live-workflow-check.ts` is
 * run. `VITE_NODE` is its folder under `node_modules/.pnpm`:
 *
 *   node ../../node_modules/.pnpm/VITE_NODE/node_modules/vite-node/vite-node.mjs scripts/live-permission-check.ts
 *
 * Exits non-zero if a check fails. A scenario with a failed check prints what its session said.
 * Needs the `claude` that comes with the Agent SDK, or the one `REALM_CLAUDE_BIN` names.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { ClaudeAdapter, bundledClaude, probeClaude, type AgentHandle, type PermissionDecision } from "@realm/adapters";
import { ASK_PERMISSION_MODE, type SessionEvent } from "@realm/contracts";
import { finish, ok as report } from "./harness";
import { CALL_SAID, callingModel, startStandIn } from "./stand-in-anthropic";

/** How long a scenario waits for a turn to begin or to settle before it gives up and says which.
 *  Nothing here is meant to take long: the stand-in answers at once, and so does each call. */
const WAIT_MS = 30_000;

/** What Claude Code would use in place of the address and the key this check hands it: a switch to
 *  another provider, which never asks `ANTHROPIC_BASE_URL`, and the one credential that outranks an
 *  API key. Each is taken out of the environment, so a shell set up for a real account still runs
 *  the check on none. */
const OUTRANKS_THE_STAND_IN = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_MANTLE", "ANTHROPIC_AUTH_TOKEN"] as const;

/** The permission Realm calls Ask each time. A session under it is in neither Ask nor Plan, and a
 *  call that needs asking about raises a card. */
const ASK_EACH_TIME = "default";

/** How the gate's refusal begins, which is how a call refused by Ask is told from one refused by
 *  anything else. */
const ASK_REFUSAL = "This session is in Ask mode";

/** One tool call the stand-in's model makes for a scenario: the cue that asks for it, the call
 *  itself for a session working in `project`, and the file under the project that is there once
 *  the call has run. */
type Call = { cue: string; makes: string; tool(project: string): { name: string; input: Record<string, unknown> } };

/** A shell command that makes a file. Claude Code asks about it unless a rule allows it. */
const SHELL: Call = { cue: "PROBE-SHELL", makes: "made-by-check.txt", tool: () => ({ name: "Bash", input: { command: "touch made-by-check.txt", description: "Make a file" } }) };

/** A file written with `Write`. Claude Code asks about it unless a rule allows it. */
const WRITE: Call = { cue: "PROBE-WRITE", makes: "written-by-check.txt", tool: (project) => ({ name: "Write", input: { file_path: join(project, "written-by-check.txt"), content: "written by the check\n" } }) };

/** A file every project holds, and what it says. */
const PRESENT = { file: "present.txt", says: "PRESENT-IN-THE-PROJECT" };

/** A shell command that only reads. Claude Code runs it without asking anybody, rule or no rule.
 *  It makes no file, so whether it ran is read off what the model was told. */
const READ: Call = { cue: "PROBE-READ", makes: "never-made-by-check.txt", tool: () => ({ name: "Bash", input: { command: `cat ${PRESENT.file}`, description: "Read a file" } }) };

/** The two calls that change something, in the order scenarios 3 to 5 make them. */
const CALLS = [SHELL, WRITE];

/** How many calls the stand-in's model makes in one scenario before it stops. No scenario asks for
 *  more than three. */
const CALL_CAP = 4;

/** The person's own settings in scenarios 3 to 5: rules that allow both of the check's calls. */
const OWN_SETTINGS = { permissions: { allow: ["Bash(touch:*)", "Write"] } };

/** One thing a session said, with its place in the order of arrival and its time since the session
 *  began in ms. */
type Line = SessionEvent & { i: number; at: number };
type LineOf<T extends Line["type"]> = Extract<Line, { type: T }>;

/** A session under test: what it has said, the folder it works in, what Claude Code wrote to its
 *  error stream, and how the person answers any card it raises. */
type Session = ReturnType<typeof watch> & { project: string; handle: AgentHandle; stderr: string[]; answer: PermissionDecision };

/** What one turn came to. */
type Turn = {
  /** The cards put to the person during the turn. */
  cards: LineOf<"permission_request">[];
  /** What the model was told its call came to, or undefined when the call never came back. */
  result: LineOf<"tool_result"> | undefined;
  /** Whether the call's file is in the project once the turn has settled, which is whether it ran. */
  ran: boolean;
};

type Scenario = {
  title: string;
  /** The folder the session works in, under the scratch folder. Scenarios that name the same one
   *  share it. */
  project: string;
  /** The config folder the session's `claude` is given: `bare` holds no settings, and `own` holds
   *  the person's (`OWN_SETTINGS`). */
  config: "bare" | "own";
  /** The mode the session starts in. */
  mode: string;
  /** Whether the session keeps the person's own Claude Code setup (`StartOptions.ownSetup`). */
  ownSetup?: true;
  run(s: Session): Promise<void>;
};

/** Whether a check has failed in the scenario in hand, which then prints what its session said. */
let failed = false;

/** `ok` from the harness, which also notes a failure for the scenario in hand. */
function ok(label: string, cond: boolean, detail = ""): void {
  report(label, cond, detail);
  if (!cond) failed = true;
}

/** A test for one kind of line, which also tells TypeScript the kind. */
const is = <T extends Line["type"]>(type: T, test: (l: LineOf<T>) => boolean = () => true) =>
  (l: Line): l is LineOf<T> => l.type === type && test(l as LineOf<T>);

const running = is("status", (l) => l.payload.status === "running");
const idle = is("status", (l) => l.payload.status === "idle");
const capped = is("assistant_text", (l) => l.payload.text.includes(CALL_SAID.capped));

/**
 * One session as it speaks: every line in the order it arrived, and a way to wait for the next one
 * of a kind.
 *
 * `until` looks at what has arrived after `after`, then at each line as it comes, and when `WAIT_MS`
 * has passed it gives up with a sentence that names what it waited for. Nothing here sleeps. A
 * scenario moves when the session says something.
 */
function watch() {
  const began = performance.now();
  const lines: Line[] = [];
  const waiting = new Set<() => void>();
  return {
    lines,
    add(event: SessionEvent): void {
      lines.push({ ...event, i: lines.length, at: Math.round(performance.now() - began) } as Line);
      for (const look of [...waiting]) look();
    },
    until<T extends Line>(what: string, match: (l: Line) => l is T, after?: Line): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        let next = after ? after.i + 1 : 0;
        const done = (): void => { clearTimeout(timer); waiting.delete(look); };
        const look = (): void => {
          for (; next < lines.length; next++) {
            const line = lines[next];
            if (line && match(line)) { done(); resolve(line); return; }
          }
        };
        const timer = setTimeout(() => { done(); reject(new Error(`waited ${WAIT_MS / 1000} s for ${what}`)); }, WAIT_MS);
        waiting.add(look);
        look();
      });
    },
  };
}

/** One line of what a session said. A card's suggestions and what a call came back with are what a
 *  failure here is read from, so a line is cut only well past the length of either. */
function brief(l: Line): string {
  return `${l.type} ${JSON.stringify(l.payload).slice(0, 1200)}`;
}

/** Where Claude Code would keep each update a card suggests, as `type:destination`. */
function keptWhere(card: LineOf<"permission_request"> | undefined): string[] {
  return (card?.payload.suggestions ?? []).map((suggested) => {
    const update = suggested as { type?: unknown; destination?: unknown };
    return `${String(update.type)}:${String(update.destination)}`;
  });
}

/** What the project's `.claude/settings.local.json` holds, on one line, or null when there is none. */
function localSettings(project: string): string | null {
  const file = join(project, ".claude", "settings.local.json");
  return existsSync(file) ? readFileSync(file, "utf8").replace(/\s+/g, " ").trim() : null;
}

/** What the model was told a turn's call came to, for the detail of a check. */
function told(t: Turn): string {
  return t.result ? `the model was told: ${t.result.payload.content.replace(/\s+/g, " ").slice(0, 200)}` : "the call never came back";
}

/** How many cards a turn raised, for the detail of a check. */
function cards(t: Turn): string {
  return `${t.cards.length} ${t.cards.length === 1 ? "card" : "cards"}`;
}

/** Whether a turn's call was refused by the gate: the model was told so in the gate's own words,
 *  with nothing in front of them. */
function refusedByAsk(t: Turn): boolean {
  return t.result?.payload.content.startsWith(ASK_REFUSAL) === true;
}

/**
 * Where the scratch folder goes: the system temp folder, or `/tmp` where that one leads into the
 * home folder, as a `TMPDIR` that is a symlink can. Each is judged by where it really is, because
 * Claude Code works in the folder a path leads to. Null where neither is outside the home folder,
 * which no folder is when the home folder is `/`.
 */
function outsideHome(): string | null {
  const home = realpathSync(homedir());
  const within = home.endsWith(sep) ? home : `${home}${sep}`;
  for (const candidate of [tmpdir(), "/tmp"]) {
    let real: string;
    try { real = realpathSync(candidate); } catch { continue; }
    if (!`${real}${sep}`.startsWith(within)) return real;
  }
  return null;
}

/**
 * A config folder as Claude Code keeps one for a person who has worked in these projects before:
 * each project is one they have said they trust, and `settings` is their own `settings.json`, when
 * they have one.
 */
function layConfig(config: string, projects: readonly string[], settings?: unknown): void {
  writeFileSync(join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: Object.fromEntries(projects.map((project) => [project, { hasTrustDialogAccepted: true }])) }));
  if (settings !== undefined) writeFileSync(join(config, "settings.json"), JSON.stringify(settings));
}

/**
 * Starts one session on the adapter, as the server starts one for a space with no skill switched
 * on: no `skills`, so Claude Code loads the settings files of the config folder and of the project.
 * With `ownSetup` it is started as the server starts a session that keeps the person's setup.
 * Every card the session raises is answered at once with `answer`, which a turn sets before it
 * sends.
 */
function open(adapter: ClaudeAdapter, at: { project: string; config: string; mode: string; ownSetup?: true }): Session {
  const seen = watch();
  const stderr: string[] = [];
  const handle = adapter.start({ cwd: at.project, mcpServers: [], permissionMode: at.mode, ...(at.ownSetup ? { ownSetup: true as const } : {}), env: { CLAUDE_CONFIG_DIR: at.config }, onLog: (line) => { stderr.push(line); } });
  const s: Session = { ...seen, project: at.project, handle, stderr, answer: "deny" };
  void (async () => {
    for await (const event of handle.events) {
      if (event.type === "assistant_delta") continue;
      seen.add(event);
      if (event.type === "permission_request") handle.respondPermission(event.payload.requestId, s.answer);
    }
  })();
  return s;
}

/**
 * One turn. The file the call makes is removed first, so that finding it afterwards means this
 * call ran. Then a message with the call's cue is sent, any card is answered with `answer`, and the
 * turn's settle is waited for.
 */
async function turn(s: Session, call: Call, answer: PermissionDecision): Promise<Turn> {
  const made = join(s.project, call.makes);
  rmSync(made, { force: true });
  s.answer = answer;
  const before = s.lines.at(-1);
  await s.handle.send({ text: `${call.cue} make the call`, attachments: [] });
  const began = await s.until("the turn to begin", running, before);
  const settled = await s.until("the turn to settle", idle, began);
  const said = s.lines.slice(began.i, settled.i + 1);
  const called = said.find(is("tool_call", (l) => l.payload.name === call.tool(s.project).name));
  const result = called ? said.find(is("tool_result", (l) => l.payload.toolUseId === called.payload.toolUseId)) : undefined;
  return { cards: said.filter(is("permission_request")), result, ran: existsSync(made) };
}

/** 1. The first turn's card is answered Allow always. Claude Code's suggestions for a command that
 *  makes a file also move it into the mode that accepts edits, which runs such a command by itself,
 *  so the session is put back in the mode that asks each time before the second turn. Only the rule
 *  can run the command then. A card in the second turn would be denied, so a command that ran there
 *  ran with no card. */
async function allowAlways(s: Session): Promise<void> {
  const first = await turn(s, SHELL, "allow_always");
  const card = first.cards[0];
  ok("the command is put to the person on a card that offers Allow always", first.cards.length === 1 && card?.payload.once !== true, cards(first));
  const where = keptWhere(card);
  ok("Claude Code would keep a rule outside the session, so Allow always has one to hold back", where.some((kept) => !kept.endsWith(":session")), where.join(", "));
  ok("answered Allow always, the command runs", first.ran, told(first));
  const written = localSettings(s.project);
  ok("Allow always writes nothing to the project's .claude/settings.local.json", written === null, written ?? "");
  await s.handle.setOptions({ permissionMode: ASK_EACH_TIME });
  const second = await turn(s, SHELL, "deny");
  ok("back in the mode that asks each time, the same command raises no card and runs", second.cards.length === 0 && second.ran, `${cards(second)}, ${told(second)}`);
}

/** 2. The session is a new one in scenario 1's project, after scenario 1's session has ended. */
async function newSessionAsksAgain(s: Session): Promise<void> {
  const again = await turn(s, SHELL, "deny");
  ok("a new session in the same project puts the command to the person again", again.cards.length === 1, `${cards(again)}, ${told(again)}`);
}

/** 3. The session keeps the person's setup, whose settings allow both calls. Each card is denied,
 *  so a call that ran here ran on the settings' rule. */
async function ownSetupStillAsks(s: Session): Promise<void> {
  for (const call of CALLS) {
    const { name } = call.tool(s.project);
    const asked = await turn(s, call, "deny");
    ok(`${name} is put to the person on a card, though their settings allow it`, asked.cards.length === 1, `${cards(asked)}, ${told(asked)}`);
    ok(`denied, ${name} does not run`, !asked.ran);
  }
  const read = await turn(s, READ, "deny");
  ok("a command that only reads runs with no card", read.cards.length === 0 && read.result?.payload.content.includes(PRESENT.says) === true, `${cards(read)}, ${told(read)}`);
}

/** 4. The same session shape starts in Ask. */
async function ownSetupInAsk(s: Session): Promise<void> {
  for (const call of CALLS) {
    const { name } = call.tool(s.project);
    const refused = await turn(s, call, "deny");
    ok(`in Ask, ${name} is refused and the session is told why, though the person's settings allow it`, refusedByAsk(refused), told(refused));
    ok(`${name} does not run`, !refused.ran);
    ok(`no card is raised for ${name}`, refused.cards.length === 0, cards(refused));
  }
}

/** 5. The same settings and the same calls, in a session that does not keep the setup and loads
 *  the settings all the same, as one with no library does. A card would be denied, so a call that
 *  ran here ran on the settings' rule. */
async function ownSettingsApply(s: Session): Promise<void> {
  for (const call of CALLS) {
    const { name } = call.tool(s.project);
    const allowed = await turn(s, call, "deny");
    ok(`without the policy, the person's settings run ${name} with no card`, allowed.cards.length === 0 && allowed.ran, `${cards(allowed)}, ${told(allowed)}`);
  }
}

/** Every scenario, in the order the header lists them. */
const SCENARIOS: Scenario[] = [
  { title: "Allow always", project: "always", config: "bare", mode: ASK_EACH_TIME, run: allowAlways },
  { title: "a new session in the same project", project: "always", config: "bare", mode: ASK_EACH_TIME, run: newSessionAsksAgain },
  { title: "a session that keeps the person's setup still asks", project: "own-setup", config: "own", mode: ASK_EACH_TIME, ownSetup: true, run: ownSetupStillAsks },
  { title: "a session that keeps the person's setup, in Ask", project: "own-setup-ask", config: "own", mode: ASK_PERMISSION_MODE, ownSetup: true, run: ownSetupInAsk },
  { title: "the same settings without the policy", project: "own-settings", config: "own", mode: ASK_EACH_TIME, run: ownSettingsApply },
];

async function main(): Promise<void> {
  const tmp = outsideHome();
  if (!tmp) {
    ok("there is a temp folder outside the home folder", false, `${tmpdir()} and /tmp both lead into ${homedir()}, where Claude Code would read your own CLAUDE.md as project instructions. Set TMPDIR to a folder outside it, then run the check again.`);
    finish();
  }
  const undo: (() => unknown)[] = [];
  try {
    const root = mkdtempSync(join(tmp, "realm-permission-live-"));
    undo.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const dirs = { home: join(root, "home"), bare: join(root, "config"), own: join(root, "config-own"), tmp: join(root, "tmp"), projects: join(root, "projects") };
    for (const dir of Object.values(dirs)) mkdirSync(dir);
    const projects = [...new Set(SCENARIOS.map((scenario) => join(dirs.projects, scenario.project)))];
    for (const project of projects) { mkdirSync(project); writeFileSync(join(project, PRESENT.file), `${PRESENT.says}\n`); }
    layConfig(dirs.bare, projects);
    layConfig(dirs.own, projects, OWN_SETTINGS);
    const standIn = await startStandIn();
    undo.push(() => standIn.close());
    for (const name of OUTRANKS_THE_STAND_IN) delete process.env[name];
    Object.assign(process.env, {
      HOME: dirs.home, CLAUDE_CONFIG_DIR: dirs.bare, TMPDIR: dirs.tmp, CLAUDE_CODE_TMPDIR: dirs.tmp, ANTHROPIC_BASE_URL: standIn.url, ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
      DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    const bin = process.env.REALM_CLAUDE_BIN?.trim() || bundledClaude();
    const claude = bin ? await probeClaude(bin) : null;
    ok("Realm has a claude it can run", claude?.available === true, claude ? claude.version ?? claude.reason ?? "" : "the Agent SDK's package for this machine is not installed");
    const adapter = new ClaudeAdapter();
    const scenarios = claude?.available ? SCENARIOS : [];
    for (const scenario of scenarios) {
      console.log(`\n== ${scenario.title} ==`);
      failed = false;
      const project = join(dirs.projects, scenario.project);
      standIn.answerWith(callingModel(Object.fromEntries([...CALLS, READ].map((call) => [call.cue, call.tool(project)])), CALL_CAP));
      const s = open(adapter, { project, config: dirs[scenario.config], mode: scenario.mode, ...(scenario.ownSetup ? { ownSetup: true as const } : {}) });
      try { await scenario.run(s); }
      catch (e) { ok("everything the scenario waits for arrives", false, e instanceof Error ? e.message : String(e)); }
      if (s.lines.some(capped)) ok("the scenario asks the model for no more calls than its cap", false, `more than ${CALL_CAP}`);
      if (failed) {
        for (const l of s.lines) console.log(`        ${String(l.at).padStart(6)} ms  ${brief(l)}`);
        for (const line of s.stderr) console.log(`        stderr  ${line}`);
      }
      await s.handle.dispose();
    }
    if (scenarios.length > 0) {
      console.log("\n== the scratch folder ==");
      const kept = readdirSync(dirs.tmp);
      ok("Claude Code kept its own temp files inside it", kept.length > 0, kept.join(", "));
    }
  } finally {
    for (const step of undo.reverse()) await step();
  }
  finish();
}

main().catch((e: unknown) => {
  console.error(e);
  report("the check ran to its end", false, e instanceof Error ? e.message : String(e));
  finish();
});
