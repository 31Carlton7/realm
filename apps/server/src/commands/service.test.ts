import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { COMMAND_HEAD_BYTES } from "@realm/contracts";
import { RpcError } from "../store/rows";
import { UserCommandsService, commandsRoot } from "./service";

// Pass-through, so a test can see which files were read whole.
vi.mock("node:fs", async (actual) => {
  const fs = await actual<typeof import("node:fs")>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});

const SPACE = "spc_1";
let home: string;
let folder: string;
let claudeDir: string;
let repo: string;
let service: UserCommandsService;

/** A command file, written wherever it is asked for; `file` may name sub-folders. */
const cmd = (dir: string, file: string, body: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), body);
};
const template = (description: string, body = "Do the thing.") => `---\ndescription: ${description}\n---\n\n${body}\n`;

const spaceDir = () => join(folder, "commands");
const userDir = () => commandsRoot(home);
const claudeCmds = () => join(claudeDir, "commands");
const projectCmds = () => join(repo, ".claude", "commands");

const names = (spaceId: string | null = SPACE, cwd: string | null = null) => service.list(spaceId, cwd).commands.map((c) => c.name);
const byName = (name: string, spaceId: string | null = SPACE, cwd: string | null = null) => service.list(spaceId, cwd).commands.filter((c) => c.name === name);

beforeEach(() => {
  home = tempDir("realm-commands-home-");
  folder = tempDir("realm-commands-space-");
  claudeDir = join(tempDir("realm-commands-user-"), ".claude");
  repo = tempDir("realm-commands-repo-");
  service = new UserCommandsService({
    home, claudeDir, userHome: "/Users/nobody",
    spaces: { folderPathOf: (id) => (id === SPACE ? folder : null) },
  });
});

describe("UserCommandsService.list", () => {
  it("is empty, not an error, before any commands directory exists", () => {
    expect(service.list(SPACE)).toEqual({ root: userDir(), commands: [] });
  });

  it("reads one file into a command", () => {
    cmd(userDir(), "standup.md", "---\ndescription: Write a standup note\nargument-hint: [yesterday]\n---\n\nWrite a standup for $ARGUMENTS.\n");
    expect(service.list(SPACE).commands).toEqual([{
      name: "standup", description: "Write a standup note", argumentHint: "[yesterday]",
      path: join(userDir(), "standup.md"),
      origin: { kind: "user", key: "user", label: userDir(), root: userDir(), writable: true },
      valid: true, reason: null, shadowedBy: null,
    }]);
  });

  it("sorts by name, whichever directory they came from", () => {
    cmd(userDir(), "zed.md", template("z"));
    cmd(spaceDir(), "alpha.md", template("a"));
    expect(names()).toEqual(["alpha", "zed"]);
  });

  it("keeps the filename's case, and matches it without", () => {
    cmd(userDir(), "Plain_Name.md", template("d"));
    expect(names()).toEqual(["Plain_Name"]);
    expect(service.expand(SPACE, "plain_name", "").text.trim()).toBe("Do the thing.");
  });

  it("lists every Markdown file, and only those", () => {
    cmd(userDir(), "good.md", template("d"));
    cmd(userDir(), "README", "not a command");
    cmd(userDir(), "notes.txt", "not a command");
    cmd(userDir(), ".hidden.md", template("d"));
    cmd(userDir(), "under_score.md", template("d"));
    cmd(userDir(), "v2.1.md", template("d"));
    cmd(userDir(), "UPPER.md", template("d"));
    expect(names()).toEqual(["good", "under_score", "UPPER", "v2.1"]);
    expect(service.runnable(SPACE)).toHaveLength(4);
  });

  it("lists a file whose name cannot be typed, with the reason, instead of skipping it", () => {
    cmd(userDir(), "has space.md", template("d"));
    const [spaced] = byName("has space");
    expect(spaced).toMatchObject({ valid: false });
    expect(spaced!.reason).toMatch(/space/);
  });

  it("walks sub-folders, naming a nested file the way Claude does", () => {
    cmd(userDir(), "git/commit.md", template("Commit the staged work"));
    cmd(userDir(), "a/b/deep.md", template("d"));
    cmd(userDir(), ".git/HEAD.md", template("d"));
    expect(names()).toEqual(["a:b:deep", "git:commit"]);
    expect(service.expand(SPACE, "git:commit", "now").text).toContain("Do the thing.");
  });

  it("does not walk node_modules, at any depth", () => {
    cmd(spaceDir(), "deploy.md", template("Deploy"));
    cmd(spaceDir(), "node_modules/pkg/README.md", template("d"));
    cmd(spaceDir(), "tools/node_modules/pkg/CHANGELOG.md", template("d"));
    expect(names()).toEqual(["deploy"]);
  });

  it("reads a folder reached twice through symlinks once, and does not loop on a cycle", () => {
    cmd(userDir(), "real/one.md", template("d"));
    symlinkSync(join(userDir(), "real"), join(userDir(), "alias"));
    symlinkSync(userDir(), join(userDir(), "real", "loop"));
    expect(names()).toEqual(["alias:one"]);
  });

  it("runs a plain Markdown file, described by its first line", () => {
    cmd(userDir(), "plain.md", "\n# Tidy the imports\n\nThen run the linter.\n");
    const [plain] = byName("plain");
    expect(plain).toMatchObject({ valid: true, description: "Tidy the imports", argumentHint: null });
    expect(service.expand(SPACE, "plain", "").text).toBe("\n# Tidy the imports\n\nThen run the linter.\n");
  });
});

describe("size", () => {
  const big = (bytes: number) => template("Big", `${"x".repeat(bytes)} for $ARGUMENTS`);

  it("runs a command of any size, whole", () => {
    cmd(userDir(), "huge.md", big(150_000));
    expect(byName("huge")[0]).toMatchObject({ valid: true, description: "Big" });
    const { text } = service.expand(SPACE, "huge", "the release");
    expect(text.length).toBeGreaterThan(150_000);
    expect(text.trimEnd().endsWith("for the release")).toBe(true);
  });

  it("reads only the head of each file to list it", () => {
    cmd(userDir(), "huge.md", big(5_000_000));
    vi.mocked(readFileSync).mockClear();
    service.list(SPACE);
    expect(vi.mocked(readFileSync).mock.calls.map((c) => c[0])).not.toContain(join(userDir(), "huge.md"));
    expect(COMMAND_HEAD_BYTES).toBeLessThan(64 * 1024);
  });

  it("reads past the head when the frontmatter does not close inside it", () => {
    const long = "x".repeat(COMMAND_HEAD_BYTES + 10);
    cmd(userDir(), "long-fm.md", `---\nnote: ${long}\ndescription: Late\n---\nBody\n`);
    expect(byName("long-fm")[0]).toMatchObject({ valid: true, description: "Late" });
  });
});

describe("precedence", () => {
  it("puts the session's checkout between the space and the user", () => {
    cmd(spaceDir(), "a.md", template("space"));
    cmd(projectCmds(), "a.md", template("project"));
    cmd(projectCmds(), "b.md", template("project"));
    cmd(userDir(), "b.md", template("user"));
    expect(byName("a", SPACE, repo).map((c) => c.origin.kind)).toEqual(["space", "project"]);
    expect(byName("b", SPACE, repo).map((c) => c.origin.kind)).toEqual(["project", "user"]);
    expect(service.runnable(SPACE, repo).map((c) => c.description)).toEqual(["space", "project"]);
    // Without a working folder there is no project root.
    expect(names(SPACE)).toEqual(["a", "b"]);
    expect(byName("b").map((c) => c.origin.kind)).toEqual(["user"]);
  });

  it("settles a name across sources without regard to case", () => {
    cmd(spaceDir(), "Review.md", template("the repo's"));
    cmd(userDir(), "review.md", template("the user's"));
    expect(service.list(SPACE).commands.map((c) => [c.name, c.shadowedBy !== null])).toEqual([["Review", false], ["review", true]]);
  });

  it("lets the space's own folder win the name, and says who won", () => {
    cmd(userDir(), "test.md", template("the user's"));
    cmd(spaceDir(), "test.md", template("the repo's"));
    const both = byName("test");
    expect(both.map((c) => c.origin.kind)).toEqual(["space", "user"]);
    expect(both[0]!.shadowedBy).toBeNull();
    // The loser stays in the list. "My command stopped working" and "my command is being overridden
    // by this repo's" are the same symptom, and only a list showing both answers either.
    expect(both[1]!.shadowedBy).toBe(join(spaceDir(), "test.md"));
    expect(service.runnable(SPACE).map((c) => c.description)).toEqual(["the repo's"]);
  });

  it("puts an agent's directory last", () => {
    cmd(claudeCmds(), "test.md", template("claude's"));
    cmd(userDir(), "test.md", template("the user's"));
    expect(byName("test").map((c) => c.origin.kind)).toEqual(["user", "agent"]);
    expect(service.runnable(SPACE).map((c) => c.description)).toEqual(["the user's"]);
  });

  it("never lets a broken file take a name away from a working one", () => {
    // First-file-wins, broken or not, would let a typo in a file somebody else committed silently
    // disable a command the user has been running for months.
    cmd(spaceDir(), "test.md", "---\ndescription: d\n---\n\n\n");
    cmd(userDir(), "test.md", template("the user's"));
    const both = byName("test");
    expect(both[0]!.valid).toBe(false);
    expect(both[1]!.shadowedBy).toBeNull();
    expect(service.runnable(SPACE).map((c) => c.description)).toEqual(["the user's"]);
  });

  it("shows a space's commands only in that space", () => {
    cmd(spaceDir(), "repo.md", template("d"));
    cmd(userDir(), "everywhere.md", template("d"));
    expect(names("spc_other")).toEqual(["everywhere"]);
    // And with no space at all — a palette listing commands outside a session still gets the
    // user-level ones rather than nothing.
    expect(names(null)).toEqual(["everywhere"]);
  });
});

describe("invalid files", () => {
  it("lists them, with one sentence each, rather than letting them vanish", () => {
    cmd(userDir(), "no-template.md", "---\ndescription: d\n---\n\n\n");
    cmd(userDir(), "empty.md", "");
    cmd(userDir(), "good.md", template("d"));
    expect(names()).toEqual(["empty", "good", "no-template"]);
    expect(byName("no-template")[0]!.reason).toMatch(/template/);
    expect(byName("empty")[0]!.reason).toMatch(/empty/);
    expect(service.runnable(SPACE).map((c) => c.name)).toEqual(["good"]);
  });

  it("refuses a name one of Realm's own commands owns", () => {
    cmd(userDir(), "plan.md", template("mine"));
    const [plan] = byName("plan");
    expect(plan!.valid).toBe(false);
    expect(plan!.reason).toContain("/plan");
    // Listed, because a silently ignored file is a file the user keeps editing and re-saving.
    expect(names()).toEqual(["plan"]);
  });

});

describe("UserCommandsService.expand", () => {
  it("fills the template with what was typed after the command", () => {
    cmd(userDir(), "review.md", "---\ndescription: d\n---\n\nReview $0 for $ARGUMENTS.\n");
    expect(service.expand(SPACE, "review", "auth.ts carefully").text).toBe("\nReview auth.ts for auth.ts carefully.\n");
  });

  it("reports a placeholder nothing was typed for instead of dropping it", () => {
    cmd(userDir(), "compare.md", "---\ndescription: d\n---\n\nCompare $0 and $1.\n");
    const out = service.expand(SPACE, "compare", "one");
    expect(out.text).toContain("Compare one and $1.");
    expect(out.missing).toEqual(["$1"]);
  });

  it("expands the file that won the name", () => {
    cmd(userDir(), "test.md", template("d", "the user's"));
    cmd(spaceDir(), "test.md", template("d", "the repo's"));
    expect(service.expand(SPACE, "test", "").text.trim()).toBe("the repo's");
  });

  it("says a command does not exist when it does not", () => {
    expect(() => service.expand(SPACE, "nope", "")).toThrow(/not found/);
  });

  it("refuses a command that cannot run, with the file's own reason", () => {
    // A bare NOT_FOUND would be a lie about a file the user can see in the list, and the reason is
    // the only thing that says which line to fix.
    cmd(userDir(), "broken.md", "---\nargument-hint: x\n---\n\n\n");
    expect(() => service.expand(SPACE, "broken", "")).toThrow(RpcError);
    expect(() => service.expand(SPACE, "broken", "")).toThrow(/template/);
  });
});

describe("UserCommandsService.sources", () => {
  it("lists Realm's own roots even when they are empty, and counts what each contributed", () => {
    cmd(userDir(), "a.md", template("d"));
    cmd(userDir(), "b.md", template("d"));
    expect(service.sources(SPACE)).toEqual([
      { kind: "space", key: "space", label: `${join(folder).split("/").pop()}/commands`, path: spaceDir(), count: 0, writable: true },
      { kind: "user", key: "user", label: userDir(), path: userDir(), count: 2, writable: true },
    ]);
  });

  it("lists the checkout's .claude/commands only when it exists, and never as writable", () => {
    expect(service.sources(SPACE, repo).map((s) => s.kind)).not.toContain("project");
    cmd(projectCmds(), "x.md", template("d"));
    expect(service.sources(SPACE, repo).map((s) => s.kind)).toEqual(["space", "project", "user"]);
    expect(service.sources(SPACE, repo)[1]).toMatchObject({ key: "project", path: projectCmds(), count: 1, writable: false });
  });

  it("does not list ~/.claude/commands twice for a session in the home folder", () => {
    cmd(claudeCmds(), "x.md", template("d"));
    expect(service.sources(SPACE, dirname(claudeDir)).map((s) => s.kind)).toEqual(["space", "user", "agent"]);
  });

  it("invents no agent directory for someone who does not have one", () => {
    // The skills scan's rule: a root that does not exist would show the user a folder Realm made up.
    expect(service.sources(SPACE).map((s) => s.kind)).not.toContain("agent");
    cmd(claudeCmds(), "x.md", template("d"));
    const agent = service.sources(SPACE).find((s) => s.kind === "agent")!;
    expect(agent).toMatchObject({ key: "claude", path: claudeCmds(), count: 1 });
    // And Realm never writes there, which is the whole promise about another agent's directory.
    expect(agent.writable).toBe(false);
  });

  it("writes nothing into any directory it read", () => {
    cmd(claudeCmds(), "x.md", template("d"));
    cmd(userDir(), "y.md", template("d"));
    const before = [readdirSync(claudeCmds()), readdirSync(userDir())];
    service.list(SPACE); service.runnable(SPACE); service.sources(SPACE); service.expand(SPACE, "y", "arg");
    expect([readdirSync(claudeCmds()), readdirSync(userDir())]).toEqual(before);
  });
});
