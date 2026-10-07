import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { describe, expect, it } from "vitest";
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
