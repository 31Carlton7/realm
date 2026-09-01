// @vitest-environment node
import { describe, expect, it } from "vitest";
import { extractPathFromEnvOutput, mergePath, loginShellPath, FALLBACK_EXTRA_DIRS } from "./login-shell-path";

describe("extractPathFromEnvOutput", () => {
  const wrap = (body: string) => `__REALM_ENV_START__\n${body}\n__REALM_ENV_END__\n`;

  it("finds PATH between the sentinels", () => {
    expect(extractPathFromEnvOutput(wrap("HOME=/Users/x\nPATH=/opt/homebrew/bin:/usr/bin\nSHELL=/bin/zsh"))).toBe("/opt/homebrew/bin:/usr/bin");
  });
  it("ignores rc-file noise printed before the start marker, even a fake PATH line", () => {
    const out = "welcome banner\nPATH=/evil\n" + wrap("PATH=/real/bin");
    expect(extractPathFromEnvOutput(out)).toBe("/real/bin");
  });
  it("returns null when a marker is missing", () => {
    expect(extractPathFromEnvOutput("PATH=/usr/bin\n")).toBeNull();
    expect(extractPathFromEnvOutput("__REALM_ENV_START__\nPATH=/usr/bin\n")).toBeNull();
    expect(extractPathFromEnvOutput("PATH=/x\n__REALM_ENV_END__\n")).toBeNull();
  });
  it("returns null when markers are inverted or PATH absent or empty", () => {
    expect(extractPathFromEnvOutput("__REALM_ENV_END__\n__REALM_ENV_START__\n")).toBeNull();
    expect(extractPathFromEnvOutput("__REALM_ENV_START__\nHOME=/x\n__REALM_ENV_END__\n")).toBeNull();
    expect(extractPathFromEnvOutput("__REALM_ENV_START__\nPATH=\n__REALM_ENV_END__\n")).toBeNull();
  });
  it("does not match SOMEPATH= or mid-line PATH=", () => {
    expect(extractPathFromEnvOutput("__REALM_ENV_START__\nCDPATH=/nope\nMANPATH=/nope\n__REALM_ENV_END__\n")).toBeNull();
  });
});

describe("mergePath", () => {
  it("login PATH leads, current entries it lacks follow, duplicates collapse", () => {
    expect(mergePath("/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin")).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  });
  it("null login falls back to current plus the standard extra dirs", () => {
    expect(mergePath("/usr/bin:/bin", null)).toBe(`/usr/bin:/bin:${FALLBACK_EXTRA_DIRS.join(":")}`);
  });
  it("fallback dirs already present are not duplicated", () => {
    expect(mergePath("/opt/homebrew/bin:/usr/bin", null)).toBe("/opt/homebrew/bin:/usr/bin:/usr/local/bin");
  });
  it("undefined current with a login answer is just the login PATH", () => {
    expect(mergePath(undefined, "/a:/b")).toBe("/a:/b");
  });
  it("undefined current and null login still yields the fallback dirs", () => {
    expect(mergePath(undefined, null)).toBe(FALLBACK_EXTRA_DIRS.join(":"));
  });
  it("empty segments are dropped", () => {
    expect(mergePath(":/usr/bin:", "/a::/b")).toBe("/a:/b:/usr/bin");
  });
});

describe("loginShellPath (live, /bin/sh)", () => {
  it("resolves a real PATH from a POSIX shell", async () => {
    const p = await loginShellPath("/bin/sh", 5000);
    expect(p).toBeTruthy();
    expect(p!).toContain("/usr/bin");
  });
  it("resolves null for a shell that does not exist", async () => {
    expect(await loginShellPath("/no/such/shell", 2000)).toBeNull();
  });
  it("resolves null (not hangs) for a shell that never answers", async () => {
    expect(await loginShellPath("/bin/cat", 500)).toBeNull();
  });
});
