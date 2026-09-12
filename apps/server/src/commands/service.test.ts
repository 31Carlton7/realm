import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { RpcError } from "../store/rows";
import { UserCommandsService, commandsRoot } from "./service";

const SPACE = "spc_1";
let home: string;
let folder: string;
let claudeDir: string;
let service: UserCommandsService;

/** A command file, written wherever it is asked for. */
const cmd = (dir: string, file: string, body: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), body);
};
const template = (description: string, body = "Do the thing.") => `---\ndescription: ${description}\n---\n\n${body}\n`;

const spaceDir = () => join(folder, "commands");
const userDir = () => commandsRoot(home);
const claudeCmds = () => join(claudeDir, "commands");

const names = (spaceId: string | null = SPACE) => service.list(spaceId).commands.map((c) => c.name);
const byName = (name: string, spaceId: string | null = SPACE) => service.list(spaceId).commands.filter((c) => c.name === name);

beforeEach(() => {
  home = tempDir("realm-commands-home-");
  folder = tempDir("realm-commands-space-");
  claudeDir = join(tempDir("realm-commands-user-"), ".claude");
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
      body: "\nWrite a standup for $ARGUMENTS.\n", path: join(userDir(), "standup.md"),
      origin: { kind: "user", key: "user", label: userDir(), root: userDir(), writable: true },
      valid: true, reason: null, shadowedBy: null,
    }]);
  });

  it("sorts by name, whichever directory they came from", () => {
    cmd(userDir(), "zed.md", template("z"));
    cmd(spaceDir(), "alpha.md", template("a"));
    expect(names()).toEqual(["alpha", "zed"]);
  });

  it("takes the name off the filename, case-folded", () => {
    cmd(userDir(), "Standup.md", template("d"));
    expect(names()).toEqual(["standup"]);
  });

  it("skips everything in the folder that is not a command file", () => {
    // The skills scan's rule, repeated: a name that cannot be addressed is skipped rather than
    // listed, because there is no name to list it under.
    cmd(userDir(), "good.md", template("d"));
    cmd(userDir(), "README", "not a command");
    cmd(userDir(), "notes.txt", "not a command");
    cmd(userDir(), ".hidden.md", template("d"));
    cmd(userDir(), "has space.md", template("d"));
    cmd(userDir(), "under_score.md", template("d"));
    mkdirSync(join(userDir(), "nested"), { recursive: true });
    cmd(join(userDir(), "nested"), "deep.md", template("d"));
    expect(names()).toEqual(["good"]);
  });
});

describe("precedence", () => {
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
    cmd(spaceDir(), "test.md", "---\n---\n\nno description\n");
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
    cmd(userDir(), "no-fence.md", "# just prose\n");
    cmd(userDir(), "no-description.md", "---\nargument-hint: x\n---\n\nbody\n");
    cmd(userDir(), "no-template.md", "---\ndescription: d\n---\n\n\n");
    cmd(userDir(), "good.md", template("d"));
    expect(names()).toEqual(["good", "no-description", "no-fence", "no-template"]);
    expect(byName("no-fence")[0]!.reason).toMatch(/frontmatter/);
    expect(byName("no-description")[0]!.reason).toMatch(/`description`/);
    expect(byName("no-template")[0]!.reason).toMatch(/template/);
    expect(service.runnable(SPACE).map((c) => c.name)).toEqual(["good"]);
  });

  it("shows the whole file as the body when there is no fence to strip", () => {
    // How the author sees the text they forgot to put a `---` block above.
    cmd(userDir(), "no-fence.md", "# just prose\n");
    expect(byName("no-fence")[0]!.body).toBe("# just prose\n");
  });

  it("refuses a name one of Realm's own commands owns", () => {
    cmd(userDir(), "plan.md", template("mine"));
    const [plan] = byName("plan");
    expect(plan!.valid).toBe(false);
    expect(plan!.reason).toContain("/plan");
    // Listed, because a silently ignored file is a file the user keeps editing and re-saving.
    expect(names()).toEqual(["plan"]);
  });

  it("refuses a file too large to be a prompt, and says how large", () => {
    cmd(userDir(), "huge.md", `---\ndescription: d\n---\n\n${"x".repeat(120_000)}`);
    const [huge] = byName("huge");
    expect(huge!.valid).toBe(false);
    expect(huge!.reason).toMatch(/too large/);
    // Not silently truncated into a prompt that stops mid-sentence.
    expect(huge!.body).toBe("");
  });
});

describe("UserCommandsService.expand", () => {
  it("fills the template with what was typed after the command", () => {
    cmd(userDir(), "review.md", "---\ndescription: d\n---\n\nReview $1 for $ARGUMENTS.\n");
    expect(service.expand(SPACE, "review", "auth.ts carefully").text).toBe("\nReview auth.ts for auth.ts carefully.\n");
  });

  it("reports a placeholder nothing was typed for instead of dropping it", () => {
    cmd(userDir(), "compare.md", "---\ndescription: d\n---\n\nCompare $1 and $2.\n");
    const out = service.expand(SPACE, "compare", "one");
    expect(out.text).toContain("Compare one and $2.");
    expect(out.missing).toEqual(["$2"]);
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
    cmd(userDir(), "broken.md", "---\nargument-hint: x\n---\n\nbody\n");
    expect(() => service.expand(SPACE, "broken", "")).toThrow(RpcError);
    expect(() => service.expand(SPACE, "broken", "")).toThrow(/`description`/);
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
