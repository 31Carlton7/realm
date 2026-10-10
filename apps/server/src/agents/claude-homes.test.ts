import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "../db/database";
import { SettingsStore } from "../store/settings";
import { ClaudeHomes, claudeOverride, type HomedSession } from "./claude-homes";

/**
 * A home folder with a default Claude folder and a work one in it, two profiles, and a space in
 * each. `realpathSync` on the scratch home because a temp folder on macOS sits behind a symlink,
 * and these tests compare paths as they were named.
 */
function world(o: { env?: NodeJS.ProcessEnv; defaultDir?: string } = {}) {
  const home = realpathSync(tempDir("realm-homes-"));
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".claude-work"));
  const db = openDatabase(join(tempDir("realm-"), "realm.db"));
  const settings = new SettingsStore(db);
  const profiles = new Set(["personal", "work"]);
  const spaces: Record<string, { profileId: string }> = { home: { profileId: "personal" }, office: { profileId: "work" } };
  const build = (): ClaudeHomes => new ClaudeHomes({
    settings, userHome: home, env: o.env ?? {}, defaultDir: o.defaultDir,
    profiles: { get: (id) => (profiles.has(id) ? { id } : null) },
    spaces: { get: (id) => spaces[id] ?? null },
  });
  const rows = (): string[] => (db.prepare("SELECT key FROM settings WHERE key LIKE 'claude.%' ORDER BY key").all() as { key: string }[]).map((r) => r.key);
  return { home, settings, homes: build(), build, rows, work: join(home, ".claude-work") };
}

const session = (o: Partial<HomedSession> = {}): HomedSession => ({ id: "s1", spaceId: "office", agentKind: "claude", providerSessionId: null, ...o });

/** The refusal `fn` raises, as the code and sentence a client is handed. */
function refusal(fn: () => unknown): { code: string; message: string } {
  try { fn(); } catch (e) { return { code: (e as { code: string }).code, message: (e as Error).message }; }
  throw new Error("expected a refusal");
}

describe("a profile's Claude config folder", () => {
  it("starts with none named, and says which folder is then in force", () => {
    const w = world();
    expect(w.homes.get("work")).toEqual({ dir: null, inForce: join(w.home, ".claude"), missing: false, override: null, anyNamed: false });
  });

  it("takes the default folder from the app's option, then from Realm's own CLAUDE_CONFIG_DIR, then from the home folder", () => {
    expect(world({ defaultDir: "/fixture", env: { CLAUDE_CONFIG_DIR: "/from-env" } }).homes.defaultDir).toBe("/fixture");
    expect(world({ env: { CLAUDE_CONFIG_DIR: "/from-env" } }).homes.defaultDir).toBe("/from-env");
    expect(world({ env: { CLAUDE_CONFIG_DIR: "" } }).homes.get("work").inForce).toMatch(/\/\.claude$/);
  });

  it("keeps a named folder for its own profile, across a restart", () => {
    const w = world();
    expect(w.homes.set("work", w.work)).toEqual({ dir: w.work, inForce: w.work, missing: false, override: null, anyNamed: true });
    expect(w.build().get("work").dir).toBe(w.work);
    expect(w.build().get("personal").dir).toBeNull();
  });

  it("goes back to the default folder on null, and keeps no row for it", () => {
    const w = world();
    w.homes.set("work", w.work);
    expect(w.homes.set("work", null)).toEqual({ dir: null, inForce: join(w.home, ".claude"), missing: false, override: null, anyNamed: false });
    expect(w.rows()).toEqual([]);
  });

  it("spells a path out: ~ is the home folder, and dots and a trailing slash go", () => {
    const w = world();
    expect(w.homes.set("work", "~/.claude-work").dir).toBe(w.work);
    expect(w.homes.set("work", "~/.claude-work/").dir).toBe(w.work);
    expect(w.homes.set("work", `${w.home}/./.claude/../.claude-work//`).dir).toBe(w.work);
  });

  it("keeps a symlinked folder under the name it was given, since the sign-in is filed under that name", () => {
    const w = world();
    const link = join(w.home, "work-link");
    symlinkSync(w.work, link);
    expect(w.homes.set("work", link).dir).toBe(link);
  });

  it("refuses a profile that is not there, for a read and for a write", () => {
    const w = world();
    expect(refusal(() => w.homes.get("gone")).code).toBe("NOT_FOUND");
    expect(refusal(() => w.homes.set("gone", w.work)).code).toBe("NOT_FOUND");
    expect(w.rows()).toEqual([]);
  });

  it("refuses a path that is not a full one, and says what one looks like", () => {
    const w = world();
    for (const raw of ["", "claude-work", "./.claude-work", "~someone/.claude", " ~/.claude-work"]) {
      expect(refusal(() => w.homes.set("work", raw)), raw).toEqual({ code: "CLAUDE_DIR_REFUSED", message: "A Claude config folder needs a full path, such as ~/.claude-work." });
    }
  });

  it("refuses a path with a line break or a control character in it", () => {
    const w = world();
    for (const raw of [`${w.work}\n`, `${w.home}/.claude\u0000-work`, `${w.work}\u007f`, "~/.claude-work\t"]) {
      expect(refusal(() => w.homes.set("work", raw)).message, JSON.stringify(raw)).toBe("A folder path can't contain a line break or a control character.");
    }
  });

  it("refuses a folder that is not there, and makes none", () => {
    const w = world();
    expect(refusal(() => w.homes.set("work", "~/.claude-wrok"))).toEqual({ code: "CLAUDE_DIR_REFUSED", message: "There is no folder at ~/.claude-wrok. Realm doesn't create one." });
    expect(w.homes.missing(join(w.home, ".claude-wrok"))).toBe(true);
  });

  it("refuses a file", () => {
    const w = world();
    writeFileSync(join(w.home, "notes.txt"), "");
    expect(refusal(() => w.homes.set("work", "~/notes.txt")).message).toBe("~/notes.txt is a file, not a folder.");
  });

  it("refuses the home folder, under its own name or a symlink's", () => {
    const w = world();
    expect(refusal(() => w.homes.set("work", "~")).message).toBe("~ is your home folder. Choose the Claude folder inside it, such as ~/.claude-work.");
    symlinkSync(w.home, join(w.home, "me"));
    expect(refusal(() => w.homes.set("work", "~/me")).message).toBe("~/me is your home folder. Choose the Claude folder inside it, such as ~/.claude-work.");
  });

  it("refuses every folder that holds the home folder, up to the root", () => {
    const w = world();
    for (const above of [dirname(w.home), "/"]) {
      expect(refusal(() => w.homes.set("work", above)).message).toBe(`${above} holds your home folder. Choose a Claude folder inside your home folder, such as ~/.claude-work.`);
    }
  });

  it.skipIf(process.getuid?.() === 0)("refuses a folder Realm cannot write in", () => {
    const w = world();
    const locked = join(w.home, ".claude-locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      expect(refusal(() => w.homes.set("work", locked)).message).toBe("Realm can't write to ~/.claude-locked, and Claude Code keeps its conversations there.");
    } finally { chmodSync(locked, 0o700); }
  });

  it("keeps the folder it had when a new one is refused", () => {
    const w = world();
    w.homes.set("work", w.work);
    expect(() => w.homes.set("work", "~/.claude-wrok")).toThrow();
    expect(() => w.homes.set("work", "relative")).toThrow();
    expect(w.homes.get("work").dir).toBe(w.work);
  });

  it("reads the default folder under any name as no folder named", () => {
    const w = world();
    w.homes.set("work", w.work);
    expect(w.homes.set("work", "~/.claude").dir).toBeNull();
    symlinkSync(join(w.home, ".claude"), join(w.home, "also-claude"));
    w.homes.set("work", w.work);
    expect(w.homes.set("work", "~/also-claude").dir).toBeNull();
    expect(w.rows()).toEqual([]);
  });

  it("reads the folder Realm's own CLAUDE_CONFIG_DIR names as no folder named, and refuses ~/.claude beside it", () => {
    const base = world();
    const w = world({ env: { CLAUDE_CONFIG_DIR: base.work } });
    mkdirSync(join(w.home, ".claude-other"));
    expect(w.homes.set("work", base.work).dir).toBeNull();
    expect(w.homes.set("work", "~/.claude-other").dir).toBe(join(w.home, ".claude-other"));
    expect(refusal(() => w.homes.set("work", "~/.claude")).message).toBe(`Realm was started with CLAUDE_CONFIG_DIR=${base.work}, so ~/.claude can't be chosen here.`);
    expect(w.homes.get("work").dir).toBe(join(w.home, ".claude-other"));
  });

  it("says a named folder is missing once it is gone, and never says so of the default folder", () => {
    const w = world();
    w.homes.set("work", w.work);
    rmSync(w.work, { recursive: true });
    expect(w.homes.get("work")).toEqual({ dir: w.work, inForce: w.work, missing: true, override: null, anyNamed: true });
    writeFileSync(w.work, "");
    expect(w.homes.get("work").missing).toBe(true);
    rmSync(join(w.home, ".claude"), { recursive: true });
    expect(w.homes.get("personal").missing).toBe(false);
    expect(w.homes.missing(null)).toBe(false);
  });

  it("reads a stored value that set would not have kept as no folder named", () => {
    const w = world();
    for (const stored of [42, { dir: w.work }, "relative", "~/.claude-work", `${w.work}/`, `${w.home}/./.claude-work`, `${w.work}\n`, `/${"a".repeat(1024)}`]) {
      w.settings.set("claude.configDir:work", stored);
      expect(w.homes.get("work").dir, JSON.stringify(stored)).toBeNull();
      expect(w.homes.ofProfile("work")).toBeNull();
    }
    w.settings.set("claude.configDir:work", w.work);
    expect(w.homes.ofProfile("work")).toBe(w.work);
  });

  it("says in every profile's answer whether any folder but the default one is in use, named or noted", () => {
    const w = world();
    expect([w.homes.get("work").anyNamed, w.homes.get("personal").anyNamed]).toEqual([false, false]);
    w.homes.set("work", w.work);
    expect([w.homes.get("work").anyNamed, w.homes.get("personal").anyNamed]).toEqual([true, true]);
    w.homes.pin("s1", w.work);
    expect(w.homes.set("work", null).anyNamed).toBe(true);
    expect(w.homes.get("personal").anyNamed).toBe(true);
    w.homes.unpin("s1");
    expect([w.homes.get("work").anyNamed, w.homes.get("personal").anyNamed]).toEqual([false, false]);
  });

  it("forgets a deleted profile's folder, and only that profile's", () => {
    const w = world();
    mkdirSync(join(w.home, ".claude-own"));
    w.homes.set("work", w.work);
    w.homes.set("personal", "~/.claude-own");
    w.homes.forget("work");
    expect(w.rows()).toEqual(["claude.configDir:personal"]);
  });
});

describe("the variable that outranks every folder's sign-in", () => {
  it("is null in an environment that sets none of them", () => {
    expect(claudeOverride({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/x", ANTHROPIC_BASE_URL: "https://example.test" })).toBeNull();
  });

  it("names each variable Claude Code reads a credential from", () => {
    for (const name of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_PROFILE"]) {
      expect(claudeOverride({ [name]: "value" })).toBe(name);
      expect(claudeOverride({ [name]: "" })).toBeNull();
    }
  });

  it("names a provider switch that is on, and not one that is off", () => {
    for (const name of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_MANTLE"]) {
      expect(claudeOverride({ [name]: "1" })).toBe(name);
      expect(claudeOverride({ [name]: "true" })).toBe(name);
      for (const off of ["", "0", "false", "False", " off ", "no"]) expect(claudeOverride({ [name]: off }), `${name}=${off}`).toBeNull();
    }
  });

  it("names the federation rule only when the organisation is set beside it", () => {
    expect(claudeOverride({ ANTHROPIC_FEDERATION_RULE_ID: "rule" })).toBeNull();
    expect(claudeOverride({ ANTHROPIC_ORGANIZATION_ID: "org" })).toBeNull();
    expect(claudeOverride({ ANTHROPIC_FEDERATION_RULE_ID: "rule", ANTHROPIC_ORGANIZATION_ID: "org" })).toBe("ANTHROPIC_FEDERATION_RULE_ID");
  });

  it("names the one Claude Code ranks first when several are set", () => {
    const all = { ANTHROPIC_FEDERATION_RULE_ID: "r", ANTHROPIC_ORGANIZATION_ID: "o", ANTHROPIC_PROFILE: "p", CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "a", CLAUDE_CODE_USE_VERTEX: "1" };
    const ranked = ["CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID"];
    const env: Record<string, string> = { ...all };
    for (const name of ranked) {
      expect(claudeOverride(env)).toBe(name);
      delete env[name];
    }
    expect(claudeOverride(env)).toBeNull();
  });

  it("rides on a profile's answer, read from the environment Claude processes inherit", () => {
    expect(world({ env: { ANTHROPIC_API_KEY: "k" } }).homes.get("work").override).toBe("ANTHROPIC_API_KEY");
  });
});

describe("the folder a session runs under", () => {
  it("is its profile's folder for a session that holds no conversation yet", () => {
    const w = world();
    w.homes.set("work", w.work);
    expect(w.homes.ofSession(session())).toBe(w.work);
    expect(w.homes.ofSession(session({ spaceId: "home" }))).toBeNull();
    expect(w.homes.ofSpace("office")).toBe(w.work);
  });

  it("is the default folder for a space that is not there", () => {
    const w = world();
    w.homes.set("work", w.work);
    expect(w.homes.ofSession(session({ spaceId: "gone" }))).toBeNull();
    expect(w.homes.ofSpace("gone")).toBeNull();
  });

  it("is the folder its conversation began under, whatever its profile names today", () => {
    const w = world();
    mkdirSync(join(w.home, ".claude-next"));
    w.homes.set("work", w.work);
    w.homes.pin("s1", w.work);
    w.homes.set("work", "~/.claude-next");
    expect(w.homes.ofSession(session({ providerSessionId: "conversation" }))).toBe(w.work);
    expect(w.homes.ofSession(session())).toBe(join(w.home, ".claude-next"));
  });

  it("is the default folder for a conversation with no note, which is every one from before folders could be named", () => {
    const w = world();
    w.homes.set("work", w.work);
    expect(w.homes.ofSession(session({ providerSessionId: "conversation" }))).toBeNull();
  });

  it("is the folder the running process was started with, ahead of the note and the profile", () => {
    const w = world();
    mkdirSync(join(w.home, ".claude-next"));
    w.homes.set("work", w.work);
    w.homes.pin("s1", w.work);
    expect(w.homes.ofSession(session({ providerSessionId: "conversation" }), { home: null })).toBeNull();
    expect(w.homes.ofSession(session(), { home: join(w.home, ".claude-next") })).toBe(join(w.home, ".claude-next"));
  });

  it("is never a folder for another agent, whatever is noted, named or running", () => {
    const w = world();
    w.homes.set("work", w.work);
    w.homes.pin("s1", w.work);
    for (const agentKind of ["codex", "acp:cursor", "fake"] as const) {
      expect(w.homes.ofSession(session({ agentKind }))).toBeNull();
      expect(w.homes.ofSession(session({ agentKind, providerSessionId: "thread" }))).toBeNull();
      expect(w.homes.ofSession(session({ agentKind }), { home: w.work })).toBeNull();
    }
  });

  it("sends Realm's own calls about a Claude session to that session's folder, and about any other agent's to its profile's", () => {
    const w = world();
    mkdirSync(join(w.home, ".claude-next"));
    w.homes.set("work", w.work);
    w.homes.pin("s1", w.work);
    w.homes.set("work", "~/.claude-next");
    expect(w.homes.ofSideCall(session({ providerSessionId: "conversation" }))).toBe(w.work);
    expect(w.homes.ofSideCall(session({ providerSessionId: "conversation" }), { home: null })).toBeNull();
    expect(w.homes.ofSideCall(session({ agentKind: "codex", providerSessionId: "thread" }))).toBe(join(w.home, ".claude-next"));
    expect(w.homes.ofSideCall(session({ agentKind: "codex" }), { home: null })).toBe(join(w.home, ".claude-next"));
    expect(w.homes.ofSideCall(session({ agentKind: "codex", spaceId: "home" }))).toBeNull();
  });

  it("lands a sign-in in the asking Claude session's folder, and in the profile's for anyone else who asks", () => {
    const w = world();
    mkdirSync(join(w.home, ".claude-next"));
    w.homes.set("work", w.work);
    w.homes.pin("s1", w.work);
    w.homes.set("work", "~/.claude-next");
    const next = join(w.home, ".claude-next");
    expect(w.homes.ofSignIn("office", session({ providerSessionId: "conversation" }))).toBe(w.work);
    expect(w.homes.ofSignIn("office", session({ providerSessionId: "conversation" }), { home: null })).toBeNull();
    expect(w.homes.ofSignIn("office", null)).toBe(next);
    expect(w.homes.ofSignIn("office", session({ agentKind: "codex", providerSessionId: "thread" }))).toBe(next);
    expect(w.homes.ofSignIn("home", null)).toBeNull();
  });

  it("refuses a sign-in for a folder that has gone, in the words that fit who asked", () => {
    const w = world();
    w.homes.set("work", w.work);
    w.homes.pin("s1", w.work);
    rmSync(w.work, { recursive: true });
    expect(refusal(() => w.homes.ofSignIn("office", null)).message).toMatch(/^~\/\.claude-work, the Claude config folder for this profile, is missing\./);
    expect(refusal(() => w.homes.ofSignIn("office", session())).message).toMatch(/^~\/\.claude-work, the Claude config folder for this profile, is missing\./);
    expect(refusal(() => w.homes.ofSignIn("office", session({ providerSessionId: "conversation" }))).message).toMatch(/^This conversation's Claude sign-in is kept in ~\/\.claude-work/);
    expect(refusal(() => w.homes.ofSignIn("office", session({ agentKind: "codex", providerSessionId: "thread" }))).message).toMatch(/for this profile, is missing/);
    expect(() => w.homes.ofSignIn("home", null)).not.toThrow();
  });

  it("lists every folder a profile names or a conversation began under, each once, and nothing once none is left", () => {
    const w = world();
    const other = join(w.home, ".claude-other");
    mkdirSync(other);
    expect(w.homes.named()).toEqual([]);
    w.homes.set("work", w.work);
    w.homes.pin("s1", w.work);
    w.homes.pin("s2", other);
    expect(w.homes.named()).toEqual([other, w.work].sort());
    w.homes.set("work", null);
    expect(w.homes.named()).toEqual([other, w.work].sort());
    w.homes.unpin("s1");
    expect(w.homes.named()).toEqual([other]);
    w.homes.unpin("s2");
    expect(w.homes.named()).toEqual([]);
  });

  it("lists a folder a profile names and no conversation has begun under", () => {
    const w = world();
    w.homes.set("work", w.work);
    expect(w.homes.named()).toEqual([w.work]);
  });

  it("goes on listing a folder that is gone, since anything that can write there can make its files again", () => {
    const w = world();
    w.homes.set("work", w.work);
    rmSync(w.work, { recursive: true });
    expect(w.homes.named()).toEqual([w.work]);
  });

  it("lists no stored value that set would not have kept", () => {
    const w = world();
    w.settings.set("claude.configDir:work", "relative/path");
    w.settings.set("claude.configDir:personal", `${w.home}/./.claude-work`);
    w.settings.set("claude.sessionHome:s1", 42);
    w.settings.set("claude.sessionHome:s2", `${w.home}/a\nb`);
    expect(w.homes.named()).toEqual([]);
  });

  it("gives a terminal its profile's folder to write, and none once that folder is gone", () => {
    const w = world();
    expect(w.homes.ofTerminal("office")).toBeNull();
    w.homes.set("work", w.work);
    expect(w.homes.ofTerminal("office")).toBe(w.work);
    expect(w.homes.ofTerminal("home")).toBeNull();
    expect(w.homes.ofTerminal("nowhere")).toBeNull();
    rmSync(w.work, { recursive: true });
    expect(w.homes.ofTerminal("office")).toBeNull();
    expect(w.homes.ofSpace("office")).toBe(w.work);
  });

  it("knows one folder under two spellings, and two folders apart", () => {
    const w = world();
    symlinkSync(w.work, join(w.home, "work-link"));
    expect(w.homes.same(w.work, w.work)).toBe(true);
    expect(w.homes.same(join(w.home, "work-link"), w.work)).toBe(true);
    expect(w.homes.same(w.work, join(w.home, ".claude"))).toBe(false);
    expect(w.homes.same(join(w.home, "gone"), join(w.home, "gone"))).toBe(true);
    expect(w.homes.same(join(w.home, "gone"), join(w.home, "also-gone"))).toBe(false);
    expect(w.homes.same(w.work, join(w.home, "gone"))).toBe(false);
  });

  it("notes a folder once, drops the note for the default folder, and writes nothing that has not moved", () => {
    const w = world();
    const writes: string[] = [];
    const set = w.settings.set.bind(w.settings), del = w.settings.delete.bind(w.settings);
    w.settings.set = (key, value) => { writes.push(`set ${key}`); set(key, value); };
    w.settings.delete = (key) => { writes.push(`delete ${key}`); del(key); };
    w.homes.pin("s1", null);
    expect(writes).toEqual([]);
    w.homes.pin("s1", w.work);
    w.homes.pin("s1", w.work);
    expect(writes).toEqual(["set claude.sessionHome:s1"]);
    expect(w.rows()).toEqual(["claude.sessionHome:s1"]);
    w.homes.pin("s1", null);
    w.homes.pin("s1", null);
    expect(writes).toEqual(["set claude.sessionHome:s1", "delete claude.sessionHome:s1"]);
    expect(w.rows()).toEqual([]);
  });

  it("drops a deleted session's note, and no other session's", () => {
    const w = world();
    w.homes.pin("s1", w.work);
    w.homes.pin("s2", w.work);
    w.homes.unpin("s1");
    expect(w.rows()).toEqual(["claude.sessionHome:s2"]);
  });

  it("hands a process the variable for a named folder, and nothing for the default one", () => {
    const w = world();
    expect(w.homes.envFor(w.work)).toEqual({ CLAUDE_CONFIG_DIR: w.work });
    expect(w.homes.envFor(null)).toEqual({});
    expect(w.homes.dirOf(w.work)).toBe(w.work);
    expect(w.homes.dirOf(null)).toBe(join(w.home, ".claude"));
  });

  it("refuses a start under a named folder that is gone, in words that fit a new session and a conversation", () => {
    const w = world();
    expect(() => w.homes.assertPresent(null, { resumes: false })).not.toThrow();
    expect(() => w.homes.assertPresent(w.work, { resumes: true })).not.toThrow();
    rmSync(w.work, { recursive: true });
    expect(refusal(() => w.homes.assertPresent(w.work, { resumes: false }))).toEqual({ code: "CLAUDE_DIR_MISSING",
      message: "~/.claude-work, the Claude config folder for this profile, is missing. Choose another folder on the profile's page, or use the default." });
    expect(refusal(() => w.homes.assertPresent(w.work, { resumes: true }))).toEqual({ code: "CLAUDE_DIR_MISSING",
      message: "This conversation's Claude sign-in is kept in ~/.claude-work, and that folder is missing. Put the folder back to continue the conversation." });
    expect(() => w.homes.assertPresent(null, { resumes: true })).not.toThrow();
  });

  it("shows a path with ~ for the home folder, and only for the home folder", () => {
    const w = world();
    expect(w.homes.shown(w.home)).toBe("~");
    expect(w.homes.shown(w.work)).toBe("~/.claude-work");
    expect(w.homes.shown(`${w.home}-other/.claude`)).toBe(`${w.home}-other/.claude`);
    expect(w.homes.shown("/opt/claude")).toBe("/opt/claude");
  });
});
