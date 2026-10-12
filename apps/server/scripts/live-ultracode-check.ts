/**
 * Live check of what Claude Code makes of a message Realm sends it, and of Ultracode, against the
 * REAL `claude`.
 *
 * Four things here are Claude Code's own doing, on Realm's word. It dispatches a skill, and reads a
 * keyword, from the LAST block of a message and from no other. It acts on the `ultracode` keyword
 * only in a message the host marks as a person's own input. It counts the keyword only where its
 * own scanner finds it, by rules that Realm's prompter mirrors to tell a person what a draft will do
 * (`scanUltracodeKeyword`). And it tells the model that Ultracode is on when the session's flag
 * settings say so. The unit tests hold Realm to the shape of what it sends, and its copy of the
 * scanner to what the binary did with a table of texts. What no unit test can hold up is that the
 * binary still reads that shape, and still scans, this way, so this is the check to run again when
 * the Agent SDK is bumped.
 *
 * It uses no account and nothing is billed, the way `live-workflow-check.ts` uses none: the `claude`
 * is the one the Agent SDK carries, and its environment points it at a stand-in for the Anthropic
 * API on a loopback port (`stand-in-anthropic.ts`). The stand-in's model says "ok" to everything
 * here, and hands each request to the check, which reads what Claude Code put in front of the model.
 *
 * The real server (`createApp`) runs on a scratch Realm home and is driven over its socket. Each
 * scenario is a session of its own:
 *
 *    1. A message that calls a skill and carries a picture: the skill's body reaches the model, and
 *       so does the picture. Sent as it used to be, text first, the model got the literal command.
 *    2. The word `ultracode` in a message nobody is said to have sent reaches the model with no
 *       notice. So does the word in the name of a file that a person's message carries, because
 *       Realm sends the list of attached files ahead of the person's words. The same word in the
 *       words a person sent reaches the model with Claude Code's own notice that the turn is opted
 *       into a workflow.
 *    3. With the session's Ultracode option on, the first request carries Claude Code's notice that
 *       Ultracode is on, with no keyword typed, and `init` says whether the session can run it.
 *       With the option switched off again, the next request says that it is off.
 *    4. One session is sent a list of texts, one a turn and each as a person's own. Between them
 *       they try some of the rules of the keyword's scanner and not all of them. `KEYWORD_TEXTS`
 *       names the rules they try, and the main ones they leave to the unit tests. A turn's
 *       request carries Claude Code's notice exactly where Realm's copy of the scanner finds the
 *       word in that turn's text, and `init` says that the harness reads the keyword.
 *
 * It writes nothing outside its own temp folders, which have to sit outside your home folder, for
 * the reason `live-workflow-check.ts` gives. Symlinks are resolved before that is judged, since
 * Claude Code works in the folder a path leads to. Where `TMPDIR` leads into the home folder the
 * check uses `/tmp` instead, and where that does too it refuses to run.
 *
 *   pnpm --filter @realm/server exec tsx scripts/live-ultracode-check.ts
 *
 * While `tsx` stops at the app's import of `@xterm/headless`, vite-node, which vitest brings, runs
 * it from `apps/server`. `VITE_NODE` is its folder under `node_modules/.pnpm`:
 *
 *   node ../../node_modules/.pnpm/VITE_NODE/node_modules/vite-node/vite-node.mjs scripts/live-ultracode-check.ts
 *
 * Exits non-zero if a check fails. A scenario with a failed check prints what its window saw. Needs
 * the `claude` that comes with the Agent SDK, or the one `REALM_CLAUDE_BIN` names.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { WebSocket } from "ws";
import { ClaudeAdapter, bundledClaude, probeClaude } from "@realm/adapters";
import { parseWireMessage, scanUltracodeKeyword, type EventPayload, type MethodName, type MethodParams, type MethodResult, type SessionEvent } from "@realm/contracts";
import { createApp } from "../src/app";
import { finish, ok as report } from "./harness";
import { startStandIn, textsOf, workflowModel, type MessagesRequest } from "./stand-in-anthropic";

/** How long a scenario waits for any one thing before it gives up and says what it was waiting for. */
const WAIT_MS = 30_000;

/** What Claude Code would use in place of the address and the key this check hands it. Each is
 *  taken out of the environment, so a shell set up for a real account still runs the check on none. */
const OUTRANKS_THE_STAND_IN = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_MANTLE", "ANTHROPIC_AUTH_TOKEN"] as const;

/** The words Claude Code 2.1.293 puts in front of the model, each from one of its own notices: that
 *  a message's keyword opted its turn into a workflow, that Ultracode is on, and that it is off. */
const NOTICE = { keyword: 'included the keyword "ultracode"', on: "Ultracode is on:", off: "Ultracode is off" } as const;

/** The skill the first scenario calls. Its mark is in its body alone, which reaches the model only
 *  when Claude Code runs the skill: a description that held it would reach every request. */
const SKILL = { id: "probe-skill", mark: "PINEAPPLE-7f3a" } as const;

/** A file for a person's message to carry in the second scenario. The keyword stands apart in its
 *  name, with a space on each side. Claude Code 2.1.293 counted the word in such a name when the
 *  list of attached files stood in the block it reads a keyword from. */
const NAMED_FILE = "review ultracode draft.pdf";

/** The texts the fourth scenario sends, one a turn, each as a person's own. Between them they try
 *  the rules named here of the scanner that Realm's prompter mirrors (`scanUltracodeKeyword`), and
 *  for each of those rules the answer to one of the texts changes when the rule goes. In the
 *  list's order they are the word plain, capitalised, and with a letter joined to its end. The
 *  word in double quotes, in backticks, in round, square and curly brackets, and as a tag, and the
 *  word after a less-than sign that opens no tag. The straight single quote three ways: as a span
 *  that follows an apostrophe, as an apostrophe that opens no span, and as one that closes none.
 *  A quote that never closes, and a pair of brackets inside an open pair, which ends the span
 *  because spans do not nest. A hyphen on both sides of the word, then before it alone and after
 *  it alone, and a slash the same three ways. A backslash after the word, a question mark after
 *  it, a dot and an extension after it, and a slash that leads the text. Last, the word twice,
 *  once inside a span.
 *
 *  The list does not try every rule. The unit tests alone hold the ones it leaves out, among them
 *  a square bracket that moves the start of an open span, a tag that `</` opens, an opener that
 *  never closes passing over the openers after it, a backslash before the word, a digit or an
 *  underscore joined to the word, a dot that ends a sentence, typographic quotes, and the letters
 *  and numbers outside ASCII that are judged beside a quote and after a dot.
 *
 *  The first text counts. Its notice is then in the history that every later request carries, so a
 *  check that read more of a request than its own turn would find a notice for each text after it. */
const KEYWORD_TEXTS = [
  "ultracode say hi",
  "Ultracode: make it blue",
  "ultracoded it",
  '"ultracode" is the keyword',
  "`ultracode` is the keyword",
  "(ultracode) fix the bug",
  "[ultracode] is the keyword",
  "{ultracode} review this",
  "<ultracode> is the keyword",
  "x < 5 so use ultracode > y",
  "it's 'ultracode' time",
  "don't use ultracode' now 'x",
  "'it's ultracode' x",
  'he said "use ultracode for this',
  "(a (b) ultracode)",
  "the-ultracode-branch",
  "branch-ultracode",
  "ultracode-branch",
  "open src/ultracode/index.ts",
  "feature/ultracode",
  "ultracode/realm",
  "ultracode\\",
  "what is ultracode?",
  "open ultracode.md",
  "/tmp/notes.txt mentions ultracode",
  '"ultracode" ultracode',
] as const;

/** A one-pixel PNG, for a message to carry as its picture. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** One thing a window is told about a session, or one request the stand-in gets from the session's
 *  own loop: every text Claude Code put in it, and whether it holds a picture. `own` is the part of
 *  those texts that came in after the model last spoke, which is what the turn in hand added: the
 *  message, and the notices Claude Code put beside it. Everything before that is history. */
type Seen = SessionEvent | { type: "asked"; texts: string[]; picture: boolean; own: string[] };
/** A `Seen` with its place in the order of arrival, and its time since the scenario began in ms. */
type Line = Seen & { i: number; at: number };
type LineOf<T extends Line["type"]> = Extract<Line, { type: T }>;

type Call = <M extends MethodName>(method: M, params: MethodParams<M>) => Promise<MethodResult<M>>;

/** A session under test: what its window has seen, and what a person at that window can do. */
type Session = ReturnType<typeof watch> & {
  call: Call;
  send(text: string, more?: Partial<MethodParams<"sessions.send">>): Promise<unknown>;
};

type Scenario = { name: string; title: string; run(s: Session, scratch: string): Promise<void> };

/** Whether a check has failed in the scenario in hand, which then prints what its window saw. */
let failed = false;

/** `ok` from the harness, which also notes a failure for the scenario in hand. */
function ok(label: string, cond: boolean, detail = ""): void {
  report(label, cond, detail);
  if (!cond) failed = true;
}

/** A test for one kind of line, which also tells TypeScript the kind. */
const is = <T extends Line["type"]>(type: T, test: (l: LineOf<T>) => boolean = () => true) =>
  (l: Line): l is LineOf<T> => l.type === type && test(l as LineOf<T>);

/** A turn ending: `idle`, and not the one that only closes a card raised between turns. */
const settle = is("status", (l) => l.payload.status === "idle" && l.payload.betweenTurns !== true);
const typed = (text: string) => is("user_message", (l) => l.payload.text === text);
/** A request from the session's loop that holds this text somewhere in what Claude Code sent. */
const saying = (text: string) => is("asked", (l) => l.texts.some((t) => t.includes(text)));

/**
 * One session as its window sees it: every line in the order it arrived, and a way to wait for the
 * next one of a kind. `until` looks at what has arrived after `after`, then at each line as it
 * comes, and when `WAIT_MS` has passed it gives up with a sentence that names what it waited for.
 */
function watch(id: string) {
  const began = performance.now();
  const lines: Line[] = [];
  const waiting = new Set<() => void>();
  return {
    id,
    lines,
    add(seen: Seen): void {
      lines.push({ ...seen, i: lines.length, at: Math.round(performance.now() - began) } as Line);
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

/** One line of what a window saw, short enough to read down a column. */
function brief(l: Line): string {
  if (l.type === "asked") return `asked, ${l.texts.length} texts${l.picture ? " and a picture" : ""}: ${l.texts.filter((t) => Object.values(NOTICE).some((n) => t.includes(n))).map((t) => t.slice(-160)).join(" | ")}`;
  return `${l.type} ${JSON.stringify(l.payload).slice(0, 110)}`;
}

/** A window's end of the socket: `call` is answered by id, and every broadcast goes to `hear`. */
async function openWindow(port: number, hear: (event: string, payload: unknown) => void): Promise<{ call: Call; close(): void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let calls = 0;
  ws.on("message", (raw) => {
    const wire = parseWireMessage(String(raw));
    if (wire.kind === "event") { hear(wire.msg.event, wire.msg.payload); return; }
    if (wire.kind !== "response") return;
    const asked = pending.get(wire.msg.id);
    pending.delete(wire.msg.id);
    if (wire.msg.ok) asked?.resolve(wire.msg.result);
    else asked?.reject(new Error(`${wire.msg.error.code}: ${wire.msg.error.message}`));
  });
  const call = <M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> => new Promise((resolve, reject) => {
    const id = `w${++calls}`;
    pending.set(id, { resolve: (v) => resolve(v as MethodResult<M>), reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, close: () => ws.close() };
}

/** Sends one message and waits for its turn: the message in the log, and the settle after it. */
async function turn(s: Session, text: string, more: Partial<MethodParams<"sessions.send">> = {}) {
  const before = s.lines.at(-1);
  await s.send(text, more);
  const sent = await s.until(`"${text}" to reach the log`, typed(text), before);
  const settled = await s.until(`the turn of "${text}" to settle`, settle, sent);
  return { sent, settled, asked: s.lines.slice(sent.i, settled.i).filter(is("asked")) };
}

/** 1. The skill is one of Realm's own, in the scratch home's library, and the message names it the
 *  way a prompter does, with a picture attached. */
async function skillWithPicture(s: Session, scratch: string): Promise<void> {
  const picture = join(scratch, "picture.png");
  writeFileSync(picture, Buffer.from(PNG, "base64"));
  const { sent, asked } = await turn(s, `@${SKILL.id} go`, { mentions: [SKILL.id], attachments: [{ path: picture, mime: "image/png" }] });
  ok("the message is kept as the person wrote it", sent.payload.text === `@${SKILL.id} go` && sent.payload.attachments.length === 1);
  ok("the skill runs: its body reaches the model", asked.some((l) => l.texts.some((t) => t.includes(SKILL.mark))), `${asked.length} requests`);
  ok("the picture reaches the model too", asked.some((l) => l.picture));
  ok("the model is not handed the command as plain words", !asked.some((l) => l.texts.some((t) => t.trim() === `/realm:${SKILL.id} ${SKILL.id} go`)));
}

/** 2. The same words twice in one session, first from nobody and then from a person. The order is
 *  what lets the first turn show that the word alone does nothing. Between the two, a person sends
 *  other words with a file whose name holds the word. That turn comes ahead of the one where the
 *  person types the word, because a notice stays in the history that every later request carries. */
async function keywordFromAPerson(s: Session, scratch: string): Promise<void> {
  const unsaid = await turn(s, "ultracode say hi");
  ok("a message nobody is said to have sent is stored with no mark", unsaid.sent.payload.human === undefined);
  ok("its keyword reaches the model", unsaid.asked.some((l) => l.texts.some((t) => t.includes("ultracode say hi"))), `${unsaid.asked.length} requests`);
  ok("and Claude Code adds no notice to it", !s.lines.some(saying(NOTICE.keyword)));
  const file = join(scratch, NAMED_FILE);
  writeFileSync(file, "A stand-in for a draft. Nothing reads it.\n");
  const named = await turn(s, "say hi", { human: true, attachments: [{ path: file, mime: "application/pdf" }] });
  ok("a message a person sent with a file is stored with the mark and the file", named.sent.payload.human === true && named.sent.payload.attachments.length === 1);
  ok("the file's name reaches the model, with the keyword standing apart in it", named.asked.some(saying(`- ${file}`)), `${named.asked.length} requests`);
  ok("and Claude Code adds no notice for a word that is only in a file's name", !s.lines.some(saying(NOTICE.keyword)));
  const said = await turn(s, "ultracode say hi again", { human: true });
  ok("a message a person sent is stored with the mark", said.sent.payload.human === true);
  ok("its keyword reaches the model with Claude Code's notice that the turn is opted in", said.asked.some(saying(NOTICE.keyword)), `${said.asked.length} requests`);
}

/** 3. The option is set before the first message, as a prompter's card sets it on a new session, and
 *  taken back before the second. */
async function ultracodeAsAnOption(s: Session): Promise<void> {
  const row = await s.call("sessions.setOptions", { id: s.id, ultracode: true });
  ok("the row sessions.setOptions returns carries the option", row.ultracode === true);
  const first = await turn(s, "say hi");
  ok("the first request says Ultracode is on, with no keyword typed", first.asked.some(saying(NOTICE.on)) && !s.lines.some(saying(NOTICE.keyword)), `${first.asked.length} requests`);
  const init = await s.until("an init that says whether the session can run Ultracode", is("init", (l) => l.payload.ultracodeAvailable !== undefined));
  ok("init says the session can run it", init.payload.ultracodeAvailable === true, String(init.payload.ultracodeAvailable));
  const back = await s.call("sessions.setOptions", { id: s.id, ultracode: false });
  ok("the row no longer carries the option once it is taken back", back.ultracode === undefined);
  const second = await turn(s, "say hi again");
  ok("the next request says Ultracode is off", second.asked.some(saying(NOTICE.off)), `${second.asked.length} requests`);
}

/** 4. One turn for each text of `KEYWORD_TEXTS`, all in one session and all from a person. What
 *  Claude Code made of a text is read off its own turn's request, and only off what that request
 *  holds after the model last spoke (`own`), because the notice of an earlier turn stays in the
 *  history. Realm's copy of the scanner says what to expect there. */
async function keywordTextByText(s: Session): Promise<void> {
  for (const text of KEYWORD_TEXTS) {
    const expected = scanUltracodeKeyword(text).length > 0;
    const { asked } = await turn(s, text, { human: true });
    const noticed = asked.some((l) => l.own.some((t) => t.includes(NOTICE.keyword)));
    ok(`${JSON.stringify(text)} ${expected ? "gets Claude Code's notice" : "gets no notice"}, as Realm's scanner says`, asked.length > 0 && noticed === expected, `${asked.length} requests, ${noticed ? "a notice" : "no notice"} in the turn's own part`);
  }
  const init = await s.until("an init that says whether the harness reads the keyword", is("init", (l) => l.payload.ultracodeKeyword !== undefined));
  ok("init says the harness reads the keyword in this session", init.payload.ultracodeKeyword === true, String(init.payload.ultracodeKeyword));
}

/** Every scenario, in the order the header lists them. `name` is the session's title and its space's
 *  folder. */
const SCENARIOS: Scenario[] = [
  { name: "skill-with-picture", title: "a message that calls a skill and carries a picture", run: skillWithPicture },
  { name: "keyword", title: "the ultracode keyword, from nobody, in a file's name and from a person", run: keywordFromAPerson },
  { name: "option", title: "Ultracode as the session's option", run: ultracodeAsAnOption },
  { name: "keyword-texts", title: "the ultracode keyword, text by text, against Realm's copy of the scanner", run: keywordTextByText },
];

/** Puts what the socket broadcasts about one session onto that session's lines. Deltas are left out,
 *  since the text they spell arrives whole. */
function record(seen: ReturnType<typeof watch>, event: string, payload: unknown): void {
  if (event !== "session.event") return;
  const p = payload as EventPayload<"session.event">;
  if (p.sessionId === seen.id && p.event.type !== "assistant_delta") seen.add(p.event);
}

/** What one request holds, for the session's lines: its texts, the ones among them that came in
 *  after the model last spoke, and whether a picture is among its blocks. */
function requestLine(body: MessagesRequest): Seen {
  const messages = body.messages ?? [];
  const spoke = messages.map((m) => m.role).lastIndexOf("assistant");
  return { type: "asked", texts: textsOf(messages), own: textsOf(messages.slice(spoke + 1)), picture: messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "image")) };
}

/** Where the check's scratch folders go: the temp folder, or `/tmp` where the temp folder leads
 *  into the home folder. Each is judged by where it really is, and the home folder itself counts
 *  as inside. Null where neither is outside the home folder. */
function outsideHome(): string | null {
  const home = realpathSync(homedir());
  const within = home.endsWith(sep) ? home : home + sep;
  for (const candidate of [tmpdir(), "/tmp"]) {
    let real: string;
    try { real = realpathSync(candidate); } catch { continue; }
    if (real !== home && !real.startsWith(within)) return real;
  }
  return null;
}

async function main(): Promise<void> {
  const tmp = outsideHome();
  if (!tmp) {
    ok("there is a temp folder outside the home folder", false, `${tmpdir()} and /tmp both lead into ${homedir()}, where Claude Code would read your own CLAUDE.md as project instructions. Set TMPDIR to a folder outside it, then run the check again.`);
    finish();
  }
  const undo: (() => unknown)[] = [];
  try {
    const root = mkdtempSync(join(tmp, "realm-ultracode-live-"));
    undo.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const dirs = { realm: join(root, "realm"), home: join(root, "home"), config: join(root, "config"), tmp: join(root, "tmp"), scratch: join(root, "scratch") };
    for (const dir of Object.values(dirs)) mkdirSync(dir);
    mkdirSync(join(dirs.realm, "skills", SKILL.id), { recursive: true });
    writeFileSync(join(dirs.realm, "skills", SKILL.id, "SKILL.md"), `---\nname: ${SKILL.id}\ndescription: A probe skill. Use it only when it is called by name.\n---\n\nWhen this skill is invoked, reply with the single word ${SKILL.mark}.\n`);
    const standIn = await startStandIn();
    undo.push(() => standIn.close());
    for (const name of OUTRANKS_THE_STAND_IN) delete process.env[name];
    Object.assign(process.env, {
      HOME: dirs.home, CLAUDE_CONFIG_DIR: dirs.config, CLAUDE_CODE_TMPDIR: dirs.tmp, ANTHROPIC_BASE_URL: standIn.url, ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
      DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    const app = await createApp({ home: dirs.realm, port: 0, userHome: dirs.home, claudeDir: dirs.config, adapters: { claude: new ClaudeAdapter() } });
    undo.push(() => app.close());
    let watching: ReturnType<typeof watch> | null = null;
    const win = await openWindow(app.port, (event, payload) => { if (watching) record(watching, event, payload); });
    undo.push(() => win.close());
    console.log(`server up on :${app.port}`);
    const bin = process.env.REALM_CLAUDE_BIN?.trim() || bundledClaude();
    const claude = bin ? await probeClaude(bin) : null;
    ok("Realm has a claude it can run", claude?.available === true, claude ? claude.version ?? claude.reason ?? "" : "the Agent SDK's package for this machine is not installed");
    const profile = await win.call("profiles.create", { name: "Ultracode check" });
    const scenarios = claude?.available ? SCENARIOS : [];
    for (const scenario of scenarios) {
      console.log(`\n== ${scenario.title} ==`);
      failed = false;
      const space = await win.call("spaces.create", { profileId: profile.id, name: scenario.name });
      const { session } = await win.call("sessions.create", { spaceId: space.id, agentKind: "claude", permissionMode: "default", title: scenario.name });
      const seen = watch(session.id);
      watching = seen;
      standIn.answerWith(workflowModel({}, (by, body) => { if (by === "session") seen.add(requestLine(body)); }));
      const s: Session = { ...seen, call: win.call, send: (text, more = {}) => win.call("sessions.send", { id: session.id, text, ...more }) };
      try { await scenario.run(s, dirs.scratch); }
      catch (e) { ok("everything the scenario waits for arrives", false, e instanceof Error ? e.message : String(e)); }
      if (failed) for (const l of seen.lines) console.log(`        ${String(l.at).padStart(6)} ms  ${brief(l)}`);
      await win.call("sessions.delete", { id: session.id }).catch((e: Error) => ok("the scenario's session is deleted", false, e.message));
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
