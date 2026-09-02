import { describe, expect, it } from "vitest";
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
