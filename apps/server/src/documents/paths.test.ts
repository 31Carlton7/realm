import { describe, expect, it } from "vitest";
import { realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { relInRoot, resolveInRoot } from "./paths";

const ROOT = "/tmp/realm-space";

describe("resolveInRoot", () => {
  it("resolves ordinary relative paths under the root", () => {
    expect(resolveInRoot(ROOT, "notes.md")).toBe("/tmp/realm-space/notes.md");
    expect(resolveInRoot(ROOT, "docs/q3/report.md")).toBe("/tmp/realm-space/docs/q3/report.md");
    expect(resolveInRoot(ROOT, "")).toBe("/tmp/realm-space");
  });

  it("allows .. that stays inside the root", () => {
    expect(resolveInRoot(ROOT, "docs/../notes.md")).toBe("/tmp/realm-space/notes.md");
  });

  it("refuses traversal out of the root", () => {
    expect(() => resolveInRoot(ROOT, "../secrets.md")).toThrow(/escapes the workspace root/);
    expect(() => resolveInRoot(ROOT, "docs/../../secrets.md")).toThrow(/escapes/);
    expect(() => resolveInRoot(ROOT, "../../../../etc/passwd")).toThrow(/escapes/);
  });

  /** The mutant: a prefix check written as `abs.startsWith(rootAbs)` without the separator. A sibling
   *  directory whose name merely EXTENDS the root's would then pass containment. */
  it("does not accept a sibling directory sharing the root's name prefix", () => {
    expect(() => resolveInRoot(ROOT, "../realm-space-evil/x.md")).toThrow(/escapes/);
  });

  it("refuses absolute paths outright, with a message that names the real problem", () => {
    expect(() => resolveInRoot(ROOT, "/etc/passwd")).toThrow(/must be relative/);
    // Absolute even when it happens to point inside: the contract is relative paths.
    expect(() => resolveInRoot(ROOT, "/tmp/realm-space/notes.md")).toThrow(/must be relative/);
  });

  it("refuses null bytes", () => {
    expect(() => resolveInRoot(ROOT, "notes.md\0.png")).toThrow(/null byte/);
  });

  it("normalizes a trailing-slash root the same as a bare one", () => {
    expect(resolveInRoot("/tmp/realm-space/", "notes.md")).toBe("/tmp/realm-space/notes.md");
  });
});

describe("relInRoot", () => {
  it("returns the /-separated relative path", () => {
    expect(relInRoot(ROOT, "/tmp/realm-space/docs/a.md")).toBe("docs/a.md");
    expect(relInRoot(ROOT, "/tmp/realm-space")).toBe("");
  });

  it("returns null for anything outside the root", () => {
    expect(relInRoot(ROOT, "/tmp/other/a.md")).toBeNull();
    // Same prefix-extension mutant as above, from the watcher's side.
    expect(relInRoot(ROOT, "/tmp/realm-space-evil/a.md")).toBeNull();
  });

  it("round-trips with resolveInRoot", () => {
    for (const rel of ["a.md", "docs/b.csv", "x/y/z.tex"]) {
      expect(relInRoot(ROOT, resolveInRoot(ROOT, rel))).toBe(rel);
    }
  });
});

describe("relInRoot across a symlinked root", () => {
  it("accepts the same file named through a symlink — the macOS /tmp case", () => {
    /* This is what "…is outside this workspace" was, for a file the agent had just written INSIDE
       the space: on macOS `/tmp` is a symlink to `/private/tmp`, so an agent reporting
       `/private/tmp/…/notes.md` for a workspace Realm knows as `/tmp/…` names the same file by
       another true name, and a lexical comparison of the two strings can only miss. */
    // `tempDir` is the repo's one temp-directory maker; it also cleans up after the file.
    // `realpathSync` on the way out because the point of this test is the two spellings of one path.
    const real = realpathSync(tempDir("realm-paths-"));
    const link = join(realpathSync(tempDir("realm-links-")), "linked");
    symlinkSync(real, link);
    try {
      writeFileSync(join(real, "notes.md"), "x");
      // Root named through the link, file named through the real path — and the reverse.
      expect(relInRoot(link, join(real, "notes.md"))).toBe("notes.md");
      expect(relInRoot(real, join(link, "notes.md"))).toBe("notes.md");
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("refuses a path that is outside by BOTH readings", () => {
    /* The scope of the realpath fallback, stated as a test: it only ever ADDS the symlinked-root
       case. A path outside the root lexically AND after resolution is still refused, which is the
       mutant that matters — dropping the null return would open anything.

       What this deliberately does NOT claim: that a symlink INSIDE the root pointing out of it is
       caught. It is not, today, and it was not before — the lexical pass accepts it first. Making
       realpath primary would change containment for every caller including the write path, which is
       a decision about the whole document surface rather than about opening a file. */
    const root = realpathSync(tempDir("realm-paths-root-"));
    const outside = realpathSync(tempDir("realm-paths-out-"));
    try {
      writeFileSync(join(outside, "secret.md"), "x");
      expect(relInRoot(root, join(outside, "secret.md"))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
