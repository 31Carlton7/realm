import { accessSync, constants, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { CLAUDE_DIR_MAX, tildePath, type ClaudeDir, type Session } from "@realm/contracts";
import type { SettingsStore } from "../store/settings";
import { NotFoundError, RpcError } from "../store/rows";

/**
 * Which Claude config folder a profile, and each of its sessions, runs under.
 *
 * Claude Code keeps one sign-in per config folder, and `CLAUDE_CONFIG_DIR` says which folder a
 * process uses. A person with a work account and a personal one keeps a folder for each. Realm
 * used to start every Claude process with its own environment, so every profile ran, and was
 * billed, on whichever account that environment resolved. A profile can now name the folder its
 * sessions use.
 *
 * A folder here is `string | null` throughout, and null is the default folder: no variable is
 * passed, and the process resolves a folder exactly as it did before a profile could name one.
 * That is why null is never spelled out as `~/.claude`. Claude Code reads a different
 * `.claude.json` when the variable names the default folder than when the variable is absent.
 *
 * Every question about a folder is answered here and nowhere else. `claude-homes.source.test.ts`
 * fails when another file works one out for itself.
 */

const DIR_KEYS = "claude.configDir:";
const PIN_KEYS = "claude.sessionHome:";
const dirKey = (profileId: string): string => `${DIR_KEYS}${profileId}`;
const pinKey = (sessionId: string): string => `${PIN_KEYS}${sessionId}`;

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** The variables that send Claude Code to another provider altogether. It ranks them first. */
const PROVIDER_SWITCHES = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_MANTLE"] as const;
/** The variables that carry a credential of their own, in the order Claude Code ranks them. Each
 *  one outranks the sign-in a folder holds. */
const CREDENTIAL_VARIABLES = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_PROFILE"] as const;

const switchedOn = (value: string | undefined): boolean =>
  value !== undefined && !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());

/**
 * The variable in `env` that Claude Code uses in place of any folder's sign-in, or null.
 *
 * Realm hands its own environment to every Claude process it starts, so one of these in it decides
 * the account for every profile, whatever folder a profile names. Named so the profile's page can
 * say so, in place of showing a folder's account that no session uses.
 */
export function claudeOverride(env: NodeJS.ProcessEnv): string | null {
  for (const name of PROVIDER_SWITCHES) if (switchedOn(env[name])) return name;
  for (const name of CREDENTIAL_VARIABLES) if (env[name]) return name;
  if (env.ANTHROPIC_FEDERATION_RULE_ID && env.ANTHROPIC_ORGANIZATION_ID) return "ANTHROPIC_FEDERATION_RULE_ID";
  return null;
}

function statOf(path: string): Stats | null {
  try { return statSync(path); } catch { return null; }
}

/** One folder under two spellings: a symlink, a path in another case on a volume that ignores
 *  case. Asked of the file system, since comparing the strings answers neither. */
const sameFolder = (a: Stats, b: Stats | null): boolean => b !== null && a.dev === b.dev && a.ino === b.ino;

function refuse(message: string): never {
  throw new RpcError("CLAUDE_DIR_REFUSED", message);
}

export type ClaudeHomesDeps = {
  settings: SettingsStore;
  profiles: { get(id: string): unknown };
  spaces: { get(id: string): { profileId: string } | null };
  /** The default folder, for a suite or a live check that must not read the person's own. */
  defaultDir?: string;
  /** The environment Claude processes inherit. Left out, the server's own. */
  env?: NodeJS.ProcessEnv;
  /** The person's home folder: what `~` stands for, and where the default folder is. */
  userHome?: string;
};

/** What `ofSession` reads off a session. */
export type HomedSession = Pick<Session, "id" | "spaceId" | "agentKind" | "providerSessionId">;

export class ClaudeHomes {
  private readonly env: NodeJS.ProcessEnv;
  /** The person's home folder: what `~` stands for in a path they type, and in one they are shown. */
  readonly userHome: string;

  constructor(private d: ClaudeHomesDeps) {
    this.env = d.env ?? process.env;
    this.userHome = d.userHome ?? homedir();
  }

  /** The folder in force where none is named: the one Realm's own environment resolves. */
  get defaultDir(): string {
    return this.d.defaultDir ?? (this.env.CLAUDE_CONFIG_DIR || join(this.userHome, ".claude"));
  }

  /** The folder a profile names, with the folder in force and what is wrong with either. */
  get(profileId: string): ClaudeDir {
    if (!this.d.profiles.get(profileId)) throw new NotFoundError("profile", profileId);
    return this.answer(this.ofProfile(profileId));
  }

  /**
   * Names the profile's folder, or with null goes back to the default one.
   *
   * Refused, each with its own sentence, when the folder could not hold a sign-in: Realm makes no
   * folder and Claude Code makes any folder it is pointed at, so a mistyped path would otherwise
   * become a new, signed-out folder. The home folder and the folders above it are refused because
   * a sandboxed session may write anywhere in its config folder.
   *
   * The path is kept as it was named, apart from `~`, `.` and `..`. It is not resolved through
   * symlinks, since Claude Code files a folder's sign-in in the Keychain under the path it is
   * given: another spelling of the same folder reads as signed out.
   */
  set(profileId: string, dir: string | null): ClaudeDir {
    if (!this.d.profiles.get(profileId)) throw new NotFoundError("profile", profileId);
    const named = dir === null ? null : this.accepted(dir);
    if (named === null) this.d.settings.delete(dirKey(profileId));
    else this.d.settings.set(dirKey(profileId), named);
    return this.answer(named);
  }

  /** A deleted profile's choice goes with it. */
  forget(profileId: string): void {
    this.d.settings.delete(dirKey(profileId));
  }

  ofProfile(profileId: string | null): string | null {
    return profileId === null ? null : this.stored(dirKey(profileId));
  }

  ofSpace(spaceId: string): string | null {
    return this.ofProfile(this.d.spaces.get(spaceId)?.profileId ?? null);
  }

  /**
   * The named folder a terminal in a space may write to under a sandbox: its profile's, where that
   * folder is there. A folder that is gone is nobody's to write. Realm starts nothing under it, and
   * a sandboxed process that made it again would turn that refusal into a signed-out folder.
   */
  ofTerminal(spaceId: string): string | null {
    const home = this.ofSpace(spaceId);
    return this.missing(home) ? null : home;
  }

  /**
   * The folder a session's Claude process runs under. Null for every other agent.
   *
   * A conversation lives in the folder it began under: Claude Code keeps the transcript there, and
   * the sign-in that can read it. So the answer is, in order: the folder the running process was
   * started with (`live`); for a session that holds a conversation, the folder noted when that
   * conversation began; and only for a session with no conversation yet, the folder its profile
   * names today. A session from before a profile could name a folder has no note, which says the
   * default folder, and that is where each of them began.
   *
   * It follows that changing a profile's folder, or moving a space or a session to another
   * profile, moves no conversation that exists.
   */
  ofSession(session: HomedSession, live?: { home: string | null }): string | null {
    if (session.agentKind !== "claude") return null;
    if (live) return live.home;
    if (session.providerSessionId !== null) return this.stored(pinKey(session.id));
    return this.ofSpace(session.spaceId);
  }

  /**
   * The folder Realm's own Claude calls about a session run under: its title, its recap.
   *
   * A Claude session's own folder, so the call is billed to the account that holds the
   * conversation. For any other agent the session has no folder, and the call goes to the one its
   * profile names: work done in a work profile is not billed to a personal account because the
   * agent doing it was Codex.
   */
  ofSideCall(session: HomedSession, live?: { home: string | null }): string | null {
    return session.agentKind === "claude" ? this.ofSession(session, live) : this.ofSpace(session.spaceId);
  }

  /**
   * The folder a Claude sign-in asked for from a space lands in.
   *
   * The asking session's own where a Claude session asks, since that is the sign-in it is missing.
   * Otherwise the one the space's profile names: nobody asked, or the agent that asked for Claude
   * to be signed in is not Claude. Refused when the folder is gone, as a start is, because
   * `claude auth login` makes a folder it is pointed at.
   */
  ofSignIn(spaceId: string, asking: HomedSession | null, live?: { home: string | null }): string | null {
    const own = asking !== null && asking.agentKind === "claude";
    const home = own ? this.ofSession(asking, live) : this.ofSpace(spaceId);
    this.assertPresent(home, { resumes: own && asking.providerSessionId !== null });
    return home;
  }

  /**
   * Every folder Realm starts Claude under besides the default one: each a profile names, and each
   * a conversation began under and still runs in after its profile named another.
   */
  named(): string[] {
    const kept = [...this.d.settings.distinctUnder(DIR_KEYS), ...this.d.settings.distinctUnder(PIN_KEYS)];
    return [...new Set(kept.map((value) => this.kept(value)).filter((dir): dir is string => dir !== null))].sort();
  }

  /** Notes the folder a session's conversation began under. Written only when it moved, so the
   *  common case, a session on the default folder, keeps no row at all. */
  pin(sessionId: string, home: string | null): void {
    if (this.stored(pinKey(sessionId)) === home) return;
    if (home === null) this.d.settings.delete(pinKey(sessionId));
    else this.d.settings.set(pinKey(sessionId), home);
  }

  /** A deleted session's note goes with it. */
  unpin(sessionId: string): void {
    this.d.settings.delete(pinKey(sessionId));
  }

  /** The folder on disk that `home` stands for. */
  dirOf(home: string | null): string {
    return home ?? this.defaultDir;
  }

  /** A named folder that is not a directory now. The default folder is never missing: Claude Code
   *  has always made it on first use, and Realm does not second-guess that. */
  missing(home: string | null): boolean {
    return home !== null && statOf(home)?.isDirectory() !== true;
  }

  /** What a Claude process started under `home` is handed on top of the environment it inherits. */
  envFor(home: string | null): Record<string, string> {
    return home === null ? {} : { CLAUDE_CONFIG_DIR: home };
  }

  override(): string | null {
    return claudeOverride(this.env);
  }

  /** Whether two paths are one folder, however each is spelled. */
  same(a: string, b: string): boolean {
    if (a === b) return true;
    const stat = statOf(a);
    return stat !== null && sameFolder(stat, statOf(b));
  }

  /** A path as a sentence shows it: `~` for the home folder. */
  shown(path: string): string {
    return tildePath(path, this.userHome);
  }

  /**
   * Refuses to start anything under a named folder that is not there.
   *
   * Never a fall back to the default folder, which would run the work on another account without
   * saying so. And never a start: Claude Code would make the folder and answer as a signed-out
   * install, and the folder would then look as if it had been there all along.
   */
  assertPresent(home: string | null, o: { resumes: boolean }): void {
    if (home === null || !this.missing(home)) return;
    const folder = this.shown(home);
    throw new RpcError("CLAUDE_DIR_MISSING", o.resumes
      ? `This conversation's Claude sign-in is kept in ${folder}, and that folder is missing. Put the folder back to continue the conversation.`
      : `${folder}, the Claude config folder for this profile, is missing. Choose another folder on the profile's page, or use the default.`);
  }

  private answer(dir: string | null): ClaudeDir {
    return { dir, inForce: this.dirOf(dir), missing: this.missing(dir), override: this.override(), anyNamed: this.named().length > 0 };
  }

  private stored(key: string): string | null {
    return this.kept(this.d.settings.get(key));
  }

  /** A settings row is JSON anybody can edit, and `settings.set` writes any key: a value that is
   *  not a path `set` would have kept reads as no folder named. */
  private kept(value: unknown): string | null {
    if (typeof value !== "string" || value.length > CLAUDE_DIR_MAX || CONTROL_CHARACTER.test(value)) return null;
    return this.spelled(value) === value ? value : null;
  }

  /** `raw` as an absolute path with `~`, `.`, `..` and a trailing slash taken out, or null. */
  private spelled(raw: string): string | null {
    const expanded = raw === "~" ? this.userHome : raw.startsWith("~/") ? join(this.userHome, raw.slice(2)) : raw;
    if (!isAbsolute(expanded)) return null;
    const tidy = normalize(expanded);
    return tidy.length > 1 && tidy.endsWith("/") ? tidy.slice(0, -1) : tidy;
  }

  /** The path to keep for `raw`: null where it is the default folder under another name. */
  private accepted(raw: string): string | null {
    if (CONTROL_CHARACTER.test(raw)) refuse("A folder path can't contain a line break or a control character.");
    const path = this.spelled(raw);
    if (path === null) refuse("A Claude config folder needs a full path, such as ~/.claude-work.");
    const folder = this.shown(path);
    const stat = statOf(path);
    if (stat === null) refuse(`There is no folder at ${folder}. Realm doesn't create one.`);
    if (!stat.isDirectory()) refuse(`${folder} is a file, not a folder.`);
    for (let above = this.userHome, depth = 0; ; depth++) {
      if (sameFolder(stat, statOf(above))) {
        refuse(depth === 0
          ? `${folder} is your home folder. Choose the Claude folder inside it, such as ~/.claude-work.`
          : `${folder} holds your home folder. Choose a Claude folder inside your home folder, such as ~/.claude-work.`);
      }
      const parent = dirname(above);
      if (parent === above) break;
      above = parent;
    }
    try { accessSync(path, constants.W_OK | constants.X_OK); }
    catch { refuse(`Realm can't write to ${folder}, and Claude Code keeps its conversations there.`); }
    if (sameFolder(stat, statOf(this.defaultDir))) return null;
    if (this.env.CLAUDE_CONFIG_DIR && sameFolder(stat, statOf(join(this.userHome, ".claude")))) {
      refuse(`Realm was started with CLAUDE_CONFIG_DIR=${this.env.CLAUDE_CONFIG_DIR}, so ~/.claude can't be chosen here.`);
    }
    return path;
  }
}
