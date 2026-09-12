import { describe, expect, it } from "vitest";
import type { ExecutionSandboxPolicy } from "@realm/contracts";
import { compileSeatbeltProfile, sandboxPathProblem } from "./profile";

const policy = (o: Partial<ExecutionSandboxPolicy> = {}): ExecutionSandboxPolicy => ({
  posture: "workspace-write", writableRoots: [], readableRoots: [], readOnlyPaths: [], protectedRoots: [], network: true, ...o,
});

/** SBPL comments run from `;` to end of line. */
const withoutComments = (profile: string): string =>
  profile.split("\n").filter((l) => !l.trimStart().startsWith(";")).join("\n");

/** Every `(param "NAME")` the profile references, in order of appearance. */
const paramsReferenced = (profile: string): string[] =>
  [...profile.matchAll(/\(param "([^"]+)"\)/g)].map((m) => m[1]!);

describe("the profile never contains a caller-supplied path", () => {
  /*
   * This is the security property the whole design rests on, so it is asserted as an IDENTITY rather
   * than as an absence: two policies with the same SHAPE (one writable root, one protected root)
   * must compile to byte-identical profile text no matter what the paths are. A compiler that
   * interpolated paths — even with perfect quoting — could not pass this.
   */
  const hostile = [
    '/tmp/quote"inside',
    "/tmp/close)paren",
    "/tmp/open(paren",
    "/tmp/semi;colon",
    "/tmp/back\\slash",
    "/tmp/space dir",
    "/tmp/new\nline",
    '/tmp/x") (allow file-write* (subpath "/etc',
    '/tmp/y"))\n(allow file-write* (subpath "/System',
    "/tmp/#comment",
    "/tmp/…unicode",
  ];

  const benign = compileSeatbeltProfile(policy({ writableRoots: ["/a"], protectedRoots: ["/b"] })).profile;

  for (const path of hostile) {
    it(`is unchanged by a writable root containing ${JSON.stringify(path.slice(5, 25))}`, () => {
      const out = compileSeatbeltProfile(policy({ writableRoots: [path], protectedRoots: ["/b"] }));
      expect(out.profile).toBe(benign);
      // …and the path is carried out of band, verbatim, with nothing escaped or stripped.
      expect(out.parameters.REALM_WRITE_0).toBe(path);
    });

    it(`is unchanged by a protected root containing ${JSON.stringify(path.slice(5, 25))}`, () => {
      const out = compileSeatbeltProfile(policy({ writableRoots: ["/a"], protectedRoots: [path] }));
      expect(out.profile).toBe(benign);
      expect(out.parameters.REALM_PROTECTED_0).toBe(path);
    });
  }

  it("carries the injection attempt as a parameter value and nowhere else", () => {
    const injection = '/tmp/x") (allow file-write* (subpath "/etc';
    const out = compileSeatbeltProfile(policy({ writableRoots: [injection] }));
    // The giveaway substring of the attack must not appear in the text the kernel parses.
    expect(out.profile).not.toContain('subpath "/etc"');
    expect(out.profile).not.toContain(injection);
    // Exactly one write rule, no matter how many the injection tried to add.
    expect(out.profile.match(/\(allow file-write\*/g)).toHaveLength(1);
  });
});

describe("what the compiler refuses", () => {
  const cases: [string, RegExp][] = [
    ["", /is empty/],
    ["relative/path", /not absolute/],
    ["./here", /not absolute/],
    ["/", /filesystem root/],
    ["/a/b/", /trailing slash/],
    ["/a//b", /empty path segment/],
    ["/a/../etc", /"\.\." segment/],
    ["/a/./b", /"\." segment/],
    ["/a\0/b", /NUL byte/],
  ];

  for (const [path, why] of cases) {
    it(`refuses ${JSON.stringify(path)}`, () => {
      expect(sandboxPathProblem(path)).toMatch(why);
      expect(() => compileSeatbeltProfile(policy({ writableRoots: [path] }))).toThrow(why);
    });
  }

  it("refuses a bad path in the read-only list too", () => {
    expect(() => compileSeatbeltProfile(policy({ readOnlyPaths: ["/"] }))).toThrow(/filesystem root/);
    expect(() => compileSeatbeltProfile(policy({ readOnlyPaths: ["~/.zshrc"] }))).toThrow(/not absolute/);
  });

  it("refuses `/` as a PROTECTED root too, not just a writable one", () => {
    // Less obviously dangerous than a writable `/` and still wrong: it would deny reading the whole
    // disk, which fails every spawn, and it is the sort of value a broken resolver produces.
    expect(() => compileSeatbeltProfile(policy({ protectedRoots: ["/"] }))).toThrow(/filesystem root/);
  });

  it("refuses to compile the `off` posture rather than emitting an empty profile", () => {
    expect(() => compileSeatbeltProfile(policy({ posture: "off" }))).toThrow(/no profile/);
  });

  it("gives a root of `/` the same answer whichever list it is in", () => {
    expect(sandboxPathProblem("/")).toMatch(/whole disk/);
  });
});

describe("the compiled profile", () => {
  it("is closed by default before it is anything else", () => {
    const { profile } = compileSeatbeltProfile(policy({ writableRoots: ["/w"] }));
    expect(profile.indexOf("(deny default)")).toBeGreaterThan(-1);
    expect(profile.indexOf("(deny default)")).toBeLessThan(profile.indexOf("(allow file-write*"));
  });

  it("puts the protected denies LAST, which is what makes them win", () => {
    // SBPL takes the last matching rule. A protected root inside a writable root only stays
    // protected because of this ordering, so the ordering is the assertion.
    const { profile } = compileSeatbeltProfile(policy({ writableRoots: ["/w"], protectedRoots: ["/w/.ssh"] }));
    const lastAllow = Math.max(profile.lastIndexOf("(allow file-write*"), profile.lastIndexOf("(allow file-read*"));
    expect(profile.lastIndexOf("(deny file-read*")).toBeGreaterThan(lastAllow);
    expect(profile.lastIndexOf("(deny file-write*")).toBeGreaterThan(lastAllow);
  });

  it("denies writing a protected root as well as reading it", () => {
    const { profile, parameters } = compileSeatbeltProfile(policy({ protectedRoots: ["/p"] }));
    expect(profile).toContain('(deny file-read* (subpath (param "REALM_PROTECTED_0")))');
    expect(profile).toContain('(deny file-write* (subpath (param "REALM_PROTECTED_0")))');
    expect(parameters).toEqual({ REALM_PROTECTED_0: "/p" });
  });

  it("denies writing a read-only path while leaving it readable", () => {
    // The difference from a protected root, which is the whole reason the list exists: `~/.claude`
    // is writable, `~/.claude/settings.json` inside it is not, and the CLI still loads its settings.
    const { profile, parameters } = compileSeatbeltProfile(policy({ writableRoots: ["/w"], readOnlyPaths: ["/w/settings.json"] }));
    expect(profile).toContain('(deny file-write* (subpath (param "REALM_READ_ONLY_0")))');
    expect(profile).not.toContain('(deny file-read* (subpath (param "REALM_READ_ONLY_0")))');
    expect(parameters.REALM_READ_ONLY_0).toBe("/w/settings.json");
  });

  it("puts the read-only denies after the write allows, which is what makes them win", () => {
    const { profile } = compileSeatbeltProfile(policy({ writableRoots: ["/w"], readOnlyPaths: ["/w/settings.json"] }));
    expect(profile.lastIndexOf("(deny file-write* (subpath (param \"REALM_READ_ONLY_0\")))"))
      .toBeGreaterThan(profile.lastIndexOf("(allow file-write*"));
  });

  it("references exactly the parameters it defines — no more, no fewer", () => {
    // A referenced parameter that is never passed makes sandbox-exec exit 65 without running the
    // command (fail closed, but a broken feature); a defined one that is never referenced is a
    // rule that silently does nothing. Both are caught here rather than at a live spawn.
    const { profile, parameters } = compileSeatbeltProfile(policy({
      writableRoots: ["/w1", "/w2"], readableRoots: ["/r"], readOnlyPaths: ["/ro"], protectedRoots: ["/p1", "/p2"],
    }));
    expect([...new Set(paramsReferenced(profile))].sort()).toEqual(Object.keys(parameters).sort());
  });

  it("reads everything when readableRoots is empty, and nothing but the list when it is not", () => {
    expect(compileSeatbeltProfile(policy()).profile).toContain("\n(allow file-read*)");
    const strict = compileSeatbeltProfile(policy({ readableRoots: ["/usr", "/bin"] })).profile;
    expect(strict).not.toContain("\n(allow file-read*)\n");
    expect(strict).toContain('(allow file-read* (subpath (param "REALM_READ_0")))');
    expect(strict).toContain('(allow file-read* (subpath (param "REALM_READ_1")))');
  });

  it("emits network rules only when the policy allows network", () => {
    expect(compileSeatbeltProfile(policy({ network: true })).profile).toContain("(allow network*)");
    const closed = compileSeatbeltProfile(policy({ network: false })).profile;
    expect(closed).not.toContain("(allow network");
    expect(closed).not.toContain("(allow system-socket)");
  });

  it("never opens /dev wholesale — raw disk access would be a complete escape", () => {
    // Comments stripped first, for the reason temp.test.ts gives about `mkdtemp`: the base policy
    // EXPLAINS why it does not use `(subpath "/dev")`, and prose about a thing must not read as a
    // use of it — otherwise the check teaches people to delete the explanation.
    const rules = withoutComments(compileSeatbeltProfile(policy({ writableRoots: ["/w"] })).profile);
    expect(rules).not.toContain('(subpath "/dev")');
    expect(rules).toContain("/dev/(null|zero|stdout|stderr|tty|ttys[0-9]+|fd/[0-9]+|dtracehelper)");
  });

  it("is deterministic: order and duplicates in the input do not change the output", () => {
    const a = compileSeatbeltProfile(policy({ writableRoots: ["/b", "/a", "/b"] }));
    const b = compileSeatbeltProfile(policy({ writableRoots: ["/a", "/b"] }));
    expect(a).toEqual(b);
    expect(a.parameters).toEqual({ REALM_WRITE_0: "/a", REALM_WRITE_1: "/b" });
  });

  it("emits no write rule at all for a policy with no writable roots", () => {
    const { profile, parameters } = compileSeatbeltProfile(policy({ posture: "read-only" }));
    expect(profile).not.toContain("(allow file-write* (subpath");
    expect(parameters).toEqual({});
  });
});
