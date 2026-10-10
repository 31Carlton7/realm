import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { describe, expect, it, vi } from "vitest";
import { AGENT_EXECUTABLE_CONFIG, AGENT_STATE_DIRS, TOOLCHAIN_CACHE_DIRS } from "@realm/contracts";
import { realRoot, resolveExecutionSandboxPolicy, type ResolveInput } from "./policy";

const root = tempDir("realm-sandbox-policy-");
/** A stand-in home, a stand-in Realm home and a stand-in $TMPDIR, all real directories on disk so
 *  `realpath` has something to answer with. */
const home = join(root, "home");
const realm = join(root, "Realm");
const tmp = join(root, "tmp");
const checkout = join(root, "work", "repo");
for (const d of [home, realm, tmp, checkout, join(home, ".ssh")]) mkdirSync(d, { recursive: true });
writeFileSync(join(realm, "realm.db"), "");

const resolve = (o: Partial<ResolveInput> = {}) => resolveExecutionSandboxPolicy({
  prefs: { posture: "workspace-write", network: true },
  checkouts: [checkout], home, tmpDir: tmp, realmHome: realm, ...o,
});

describe("realRoot", () => {
  it("follows a symlink to the path the kernel will match", () => {
    const link = join(root, "link-to-repo");
    symlinkSync(checkout, link);
    expect(realRoot(link)).toBe(realRoot(checkout));
  });

  it("answers the path a directory WILL have when it does not exist yet", () => {
    // ~/.npm does not exist until the first install. Dropping it would make that install fail at
    // mkdir inside the sandbox, so the resolver walks up to the deepest real ancestor instead.
    const missing = join(home, "go", "pkg", "mod");
    expect(realRoot(missing)).toBe(join(realRoot(home)!, "go", "pkg", "mod"));
  });

  it("answers null only when nothing along the path exists at all", () => {
    // Every absolute path has `/` as an ancestor, so this is really a guard for the loop's exit.
    expect(realRoot("/definitely/not/here")).toBe("/definitely/not/here");
    expect(realRoot("")).toBeNull();
  });
});

describe("workspace-write", () => {
  it("makes the space's checkouts writable, resolved", () => {
    const p = resolve();
    expect(p.posture).toBe("workspace-write");
    expect(p.writableRoots).toContain(realRoot(checkout));
  });

  it("resolves /tmp through its symlink — the unresolved form would match nothing", () => {
    // The single most dangerous detail in the feature: `/tmp` is a symlink to `/private/tmp`, and
    // Seatbelt matches what the kernel resolved. A writable root of `/tmp` silently allows nothing.
    const p = resolve();
    expect(p.writableRoots).toContain("/private/tmp");
    expect(p.writableRoots).not.toContain("/tmp");
  });

  it("includes the toolchain caches, under the resolved home", () => {
    const p = resolve();
    const realHome = realRoot(home)!;
    for (const rel of [".npm", ".cargo", "go/pkg/mod", "Library/pnpm"]) {
      expect(p.writableRoots).toContain(join(realHome, rel));
    }
  });

  it("takes extra roots a caller knows about", () => {
    const extra = join(root, "scratch");
    mkdirSync(extra, { recursive: true });
    expect(resolve({ extraWritableRoots: [extra] }).writableRoots).toContain(realRoot(extra));
  });

  it("sorts and de-duplicates, so the same machine always compiles the same profile", () => {
    const p = resolve({ checkouts: [checkout, checkout] });
    expect(p.writableRoots).toEqual([...p.writableRoots].sort());
    expect(new Set(p.writableRoots).size).toBe(p.writableRoots.length);
  });
});

describe("roots that would make the policy a formality", () => {
  for (const dangerous of ["/", "/Users", "/System", "/private", "/var", "/usr"]) {
    it(`drops a checkout of ${dangerous} and says so`, () => {
      const dropped: string[] = [];
      const p = resolve({ checkouts: [dangerous], onDrop: (r, why) => dropped.push(`${r}: ${why}`) });
      expect(p.writableRoots).not.toContain(dangerous);
      expect(dropped.join("\n")).toContain(dangerous);
      expect(dropped.join("\n")).toMatch(/most of the disk/);
    });
  }

  it("allows the home directory itself, because a space folder at ~ is a real setup", () => {
    // And the protected roots still bite inside it — that is what makes this survivable rather than
    // a hole. The next test proves the write deny, not just the read one.
    const p = resolve({ checkouts: [home] });
    expect(p.writableRoots).toContain(realRoot(home));
    expect(p.protectedRoots).toContain(join(realRoot(home)!, ".ssh"));
  });
});

describe("protected roots", () => {
  it("protects the credential directories under the resolved home", () => {
    const p = resolve();
    const realHome = realRoot(home)!;
    for (const rel of [".ssh", ".aws", ".gnupg", ".config/gh", "Library/Keychains"]) {
      expect(p.protectedRoots).toContain(join(realHome, rel));
    }
  });

  it("protects a credential directory BOTH ways round when it is a symlink", () => {
    /* The asymmetry that makes this list different from the writable one: a writable root that
       resolves to nothing fails closed, but a protected root that resolves to nothing fails OPEN —
       the deny matches nothing and the key stays readable while the UI claims it does not. So both
       the literal path and its target go in. */
    const altHome = join(root, "home2");
    mkdirSync(altHome, { recursive: true });
    const elsewhere = join(root, "keys-elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(altHome, ".ssh"));

    const p = resolve({ home: altHome });
    expect(p.protectedRoots).toContain(join(realRoot(altHome)!, ".ssh"));
    expect(p.protectedRoots).toContain(realRoot(elsewhere));
  });

  it("protects Realm's database file by file, not the whole of Realm's home", () => {
    // Protecting all of realmHome would take the Claude skills plugin stage with it and silently
    // turn skills off for every sandboxed session.
    const p = resolve();
    expect(p.protectedRoots).toContain(join(realm, "realm.db"));
    expect(p.protectedRoots).toContain(join(realm, "realm.db-wal"));
    expect(p.protectedRoots).toContain(join(realm, "realm.db-shm"));
    expect(p.protectedRoots).not.toContain(realm);
  });

  it("protects the same paths under read-only as under workspace-write", () => {
    const p = resolve({ prefs: { posture: "read-only", network: false } });
    expect(p.protectedRoots).toContain(join(realRoot(home)!, ".ssh"));
  });
});

describe("the agents' own state", () => {
  it("makes ~/.claude and ~/.codex writable, because the CLIs do not start otherwise", () => {
    const realHome = realRoot(home)!;
    const p = resolve();
    for (const rel of [".claude", ".codex", ".cursor"]) expect(p.writableRoots).toContain(join(realHome, rel));
  });

  it("freezes the executable configuration inside them", () => {
    const realHome = realRoot(home)!;
    const p = resolve();
    for (const rel of [".claude/settings.json", ".codex/config.toml", ".zshrc", "Library/LaunchAgents"]) {
      expect(p.readOnlyPaths).toContain(join(realHome, rel));
    }
    // …and freezing is not protecting: these stay READABLE, or the CLI cannot load its own settings.
    expect(p.protectedRoots).not.toContain(join(realHome, ".claude/settings.json"));
  });

  it("keeps the freeze under read-only too, where it is redundant but free", () => {
    const p = resolve({ prefs: { posture: "read-only", network: false } });
    expect(p.readOnlyPaths).toContain(join(realRoot(home)!, ".claude/settings.json"));
  });
});

describe("read-only", () => {
  it("makes nothing writable but the process's own temp directory", () => {
    const p = resolve({ prefs: { posture: "read-only", network: true } });
    expect(p.writableRoots).toEqual([realRoot(tmp)]);
    expect(p.writableRoots).not.toContain(realRoot(checkout));
    // Not /tmp either: a read-only session has nothing to stage, and leaving no trace where a later
    // command would look is the point of the posture.
    expect(p.writableRoots).not.toContain("/private/tmp");
  });
});

describe("off", () => {
  it("resolves to a policy with nothing in it, so nothing can be compiled from it by accident", () => {
    const p = resolve({ prefs: { posture: "off", network: true } });
    expect(p).toEqual({ posture: "off", writableRoots: [], readableRoots: [], readOnlyPaths: [], protectedRoots: [], network: true });
  });
});

describe("network", () => {
  it("carries the user's switch through unchanged, both ways", () => {
    expect(resolve({ prefs: { posture: "workspace-write", network: false } }).network).toBe(false);
    expect(resolve({ prefs: { posture: "workspace-write", network: true } }).network).toBe(true);
  });
});

describe("readableRoots", () => {
  it("stays empty — Realm ships no deny-by-default read posture, and does not pretend to", () => {
    for (const posture of ["workspace-write", "read-only"] as const) {
      expect(resolve({ prefs: { posture, network: true } }).readableRoots).toEqual([]);
    }
  });
});

/** A Claude config folder a profile names, and a second name for it. A profile's folder is kept as
 *  the person spelled it, so one behind a symlink reaches the resolver unresolved. */
const claudeWork = join(home, ".claude-work");
const claudeLink = join(root, "claude-link");
mkdirSync(claudeWork, { recursive: true });
symlinkSync(claudeWork, claudeLink);

/** What Claude Code runs something from, inside the config folder it is pointed at. */
const CLAUDE_RUNS_FROM = [".claude.json", "plugins", "settings.json", "settings.local.json"];

/** The entries of `paths` at or below `dir`. */
const under = (paths: readonly string[], dir: string): string[] =>
  paths.filter((path) => path === dir || path.startsWith(`${dir}/`));

describe("a Claude config folder a profile names", () => {
  it("makes the folder writable under workspace-write, as the path the kernel resolves", () => {
    const p = resolve({ claudeDir: claudeLink });
    expect(p.writableRoots).toContain(realRoot(claudeWork));
    expect(p.writableRoots).not.toContain(claudeLink);
  });

  it("keeps ~/.claude writable beside it, for a bare `claude` typed in the space's terminal", () => {
    expect(resolve({ claudeDir: claudeWork }).writableRoots).toContain(`${realRoot(home)}/.claude`);
  });

  it("adds the folder and its frozen files to the policy the space had, and takes nothing out of it", () => {
    const dir = realRoot(claudeWork)!;
    const openedOn = join(root, "opened-on");
    mkdirSync(openedOn, { recursive: true });
    const had = resolve({ extraWritableRoots: [openedOn] });
    expect(resolve({ extraWritableRoots: [openedOn], claudeDir: dir })).toEqual({
      ...had,
      writableRoots: [...had.writableRoots, dir].sort(),
      readOnlyPaths: [...had.readOnlyPaths, ...CLAUDE_RUNS_FROM.map((name) => join(dir, name))].sort(),
    });
  });

  it("makes a folder that is not there yet writable at the path it will have, as it does a cache nobody has used", () => {
    const dropped: string[] = [];
    const p = resolve({ claudeDir: join(home, ".claude-later"), onDrop: (r) => dropped.push(r) });
    expect(p.writableRoots).toContain(join(realRoot(home)!, ".claude-later"));
    expect(dropped).toEqual([]);
  });

  it("leaves the folder unwritable under read-only, which writes its temp directory and nothing else", () => {
    const p = resolve({ prefs: { posture: "read-only", network: true }, claudeDir: claudeWork });
    expect(p.writableRoots).toEqual([realRoot(tmp)]);
  });

  it("adds nothing to the empty policy of a space with no sandbox", () => {
    const p = resolve({ prefs: { posture: "off", network: true }, claudeDir: claudeWork });
    expect(p).toEqual({ posture: "off", writableRoots: [], readableRoots: [], readOnlyPaths: [], protectedRoots: [], network: true });
  });

  it("freezes the files Claude Code runs something from, and nothing else in the folder", () => {
    const dir = realRoot(claudeWork)!;
    const p = resolve({ claudeDir: dir });
    expect(under(p.readOnlyPaths, dir)).toEqual(CLAUDE_RUNS_FROM.map((name) => join(dir, name)).sort());
  });

  it("freezes in the folder a file the contract later adds under .claude/, and takes nothing from an entry beside ~/.claude", async () => {
    vi.resetModules();
    vi.doMock("@realm/contracts", async (real) => {
      const contracts = await real<typeof import("@realm/contracts")>();
      return { ...contracts, AGENT_EXECUTABLE_CONFIG: [...contracts.AGENT_EXECUTABLE_CONFIG, ".claude/hooks", ".claude.json"] };
    });
    try {
      const later = await import("./policy");
      const dir = realRoot(claudeWork)!;
      const p = later.resolveExecutionSandboxPolicy({
        prefs: { posture: "workspace-write", network: true },
        checkouts: [checkout], home, tmpDir: tmp, realmHome: realm, claudeDir: dir,
      });
      expect(under(p.readOnlyPaths, dir)).toEqual([...CLAUDE_RUNS_FROM, "hooks"].map((name) => join(dir, name)).sort());
    } finally {
      vi.doUnmock("@realm/contracts");
      vi.resetModules();
    }
  });

  it("freezes the same files under read-only, as it does the home folder's", () => {
    const dir = realRoot(claudeWork)!;
    const p = resolve({ prefs: { posture: "read-only", network: false }, claudeDir: dir });
    expect(under(p.readOnlyPaths, dir)).toEqual(CLAUDE_RUNS_FROM.map((name) => join(dir, name)).sort());
  });

  it("lists each frozen file under the name the folder was given and under the one the kernel resolves", () => {
    const p = resolve({ claudeDir: claudeLink });
    for (const name of CLAUDE_RUNS_FROM) {
      expect(p.readOnlyPaths).toContain(join(claudeLink, name));
      expect(p.readOnlyPaths).toContain(join(realRoot(claudeWork)!, name));
    }
  });

  it("freezes a symlinked settings file both as the link in the folder and as the file it points at", () => {
    const dir = join(root, "claude-dotfiles");
    const link = join(root, "claude-dotfiles-link");
    const target = join(root, "dotfiles", "claude-settings.json");
    for (const d of [dir, join(root, "dotfiles")]) mkdirSync(d, { recursive: true });
    writeFileSync(target, "{}");
    symlinkSync(target, join(dir, "settings.json"));
    symlinkSync(dir, link);

    const p = resolve({ claudeDir: link });
    expect(p.readOnlyPaths).toContain(join(realRoot(dir)!, "settings.json"));
    expect(p.readOnlyPaths).toContain(realRoot(target));
  });

  it("takes the folder's real path from the resolver it is handed, so a layout a test describes holds for the folder too", () => {
    const given = "/named/by/the/person";
    const real = "/where/the/folder/is";
    const p = resolve({ claudeDir: given, resolve: (path) => (path === given ? real : path) });
    expect(p.writableRoots).toContain(real);
    for (const name of CLAUDE_RUNS_FROM) expect(p.readOnlyPaths).toContain(join(real, name));
  });

  it("drops a folder that would grant most of the disk, and says why", () => {
    const dropped: string[] = [];
    const p = resolve({ claudeDir: "/Users", onDrop: (r, why) => dropped.push(`${r}: ${why}`) });
    expect(p.writableRoots).not.toContain("/Users");
    expect(dropped).toEqual(["/Users: resolves to /Users, which would grant most of the disk"]);
  });

  it("keeps the freeze for a folder it drops, where it is redundant but free", () => {
    const p = resolve({ claudeDir: "/Users" });
    for (const name of CLAUDE_RUNS_FROM) expect(p.readOnlyPaths).toContain(join("/Users", name));
  });

  it("drops a folder that is not a full path, says why, and then changes nothing", () => {
    for (const claudeDir of ["claude-work", ""]) {
      const dropped: string[] = [];
      const p = resolve({ claudeDir, onDrop: (r, why) => dropped.push(`${r}: ${why}`) });
      expect(dropped).toEqual([`${claudeDir}: nothing along this path exists`]);
      expect(p).toEqual(resolve());
    }
  });

  it("changes nothing for a process on the default folder, given as null or left out", () => {
    for (const claudeDir of [null, undefined]) {
      const dropped: string[] = [];
      const p = resolve({ claudeDir, onDrop: (r) => dropped.push(r) });
      expect(dropped).toEqual([]);
      expect(p.readOnlyPaths.filter((path) => path.endsWith("/.claude/.claude.json"))).toEqual([]);
      expect(p).toEqual(resolve());
    }
  });

  it("says once, as before, that ~/.claude cannot be used, and not again for a process on the default folder", () => {
    for (const claudeDir of [null, undefined]) {
      const dropped: string[] = [];
      resolve({
        claudeDir,
        resolve: (path) => (path === join(home, ".claude") ? null : realRoot(path)),
        onDrop: (r) => dropped.push(r),
      });
      expect(dropped).toEqual([join(home, ".claude")]);
    }
  });

  it("resolves, with no folder named, the roots and the frozen files it did before a profile could name one", () => {
    const realHome = realRoot(home)!;
    const p = resolve();
    expect(p.writableRoots).toEqual([
      realRoot(checkout)!, realRoot(tmp)!, "/private/tmp",
      ...[...AGENT_STATE_DIRS, ...TOOLCHAIN_CACHE_DIRS].map((rel) => join(realHome, rel)),
    ].sort());
    expect(p.readOnlyPaths).toEqual(
      [...new Set([home, realHome].flatMap((dir) => AGENT_EXECUTABLE_CONFIG.map((rel) => join(dir, rel))))].sort(),
    );
  });
});

describe("the Claude config folders other profiles and conversations run under", () => {
  it("freezes what Claude Code runs from each, and makes none of them writable", () => {
    const dir = realRoot(claudeWork)!;
    const had = resolve();
    expect(resolve({ frozenClaudeDirs: [dir] })).toEqual({
      ...had,
      readOnlyPaths: [...had.readOnlyPaths, ...CLAUDE_RUNS_FROM.map((name) => join(dir, name))].sort(),
    });
  });

  it("freezes a folder kept inside ~/.claude, which every sandboxed process may write", () => {
    const inside = join(realRoot(home)!, ".claude", "accounts", "work");
    const p = resolve({ frozenClaudeDirs: [inside] });
    expect(p.writableRoots).toContain(join(realRoot(home)!, ".claude"));
    expect(under(p.readOnlyPaths, inside)).toEqual(CLAUDE_RUNS_FROM.map((name) => join(inside, name)).sort());
  });

  it("freezes each of them beside the folder the process runs under, which alone is made writable", () => {
    const own = realRoot(claudeWork)!;
    const other = join(realRoot(home)!, ".claude-other");
    const third = join(realRoot(home)!, ".claude-third");
    const p = resolve({ claudeDir: own, frozenClaudeDirs: [other, third] });
    expect(p.writableRoots).toContain(own);
    expect(p.writableRoots).not.toContain(other);
    expect(p.writableRoots).not.toContain(third);
    for (const dir of [own, other, third]) {
      expect(under(p.readOnlyPaths, dir)).toEqual(CLAUDE_RUNS_FROM.map((name) => join(dir, name)).sort());
    }
    expect(resolve({ claudeDir: own, frozenClaudeDirs: [own, other, third] })).toEqual(p);
  });

  it("freezes them under read-only too, where the freeze is redundant but free", () => {
    const dir = realRoot(claudeWork)!;
    const p = resolve({ prefs: { posture: "read-only", network: false }, frozenClaudeDirs: [dir] });
    expect(under(p.readOnlyPaths, dir)).toEqual(CLAUDE_RUNS_FROM.map((name) => join(dir, name)).sort());
    expect(p.writableRoots).toEqual([realRoot(tmp)]);
  });

  it("lists each frozen file under the name the folder was given and under the one the kernel resolves", () => {
    const p = resolve({ frozenClaudeDirs: [claudeLink] });
    for (const dir of [claudeLink, realRoot(claudeWork)!]) {
      expect(under(p.readOnlyPaths, dir)).toEqual(CLAUDE_RUNS_FROM.map((name) => join(dir, name)).sort());
    }
  });

  it("adds nothing to the empty policy of a space with no sandbox", () => {
    const p = resolve({ prefs: { posture: "off", network: true }, frozenClaudeDirs: [claudeWork] });
    expect(p).toEqual({ posture: "off", writableRoots: [], readableRoots: [], readOnlyPaths: [], protectedRoots: [], network: true });
  });

  it("changes nothing where there are none, given as an empty list or left out", () => {
    const dropped: string[] = [];
    expect(resolve({ frozenClaudeDirs: [], onDrop: (r) => dropped.push(r) })).toEqual(resolve({ onDrop: (r) => dropped.push(r) }));
    expect(resolve({ claudeDir: claudeWork, frozenClaudeDirs: [] })).toEqual(resolve({ claudeDir: claudeWork }));
  });

  it("says nothing was dropped for a folder it only freezes, since it asked for no root there", () => {
    const dropped: string[] = [];
    resolve({ frozenClaudeDirs: ["/Users", "claude-work"], onDrop: (r) => dropped.push(r) });
    expect(dropped.filter((r) => r === "/Users" || r === "claude-work")).toEqual([]);
  });
});
