import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESERVED_COMMAND_NAMES, commandNameFromFile, expandCommand, isReservedCommandName, readCommandDocument,
  runnableCommands, untypeableReason, type UserCommand,
} from "./commands";
import { SESSION_MODES } from "./presets";

const doc = (frontmatter: Record<string, string> | null, body: string) => ({ frontmatter, body });

describe("commandNameFromFile", () => {
  it("takes the name off the filename, keeping its case", () => {
    expect(commandNameFromFile("standup.md")).toBe("standup");
    expect(commandNameFromFile("write-tests.md")).toBe("write-tests");
    // Claude lists `Plain_Name.md` as `/Plain_Name`; matching ignores case, display does not.
    expect(commandNameFromFile("Standup.MD")).toBe("Standup");
  });

  it("names a nested file with `:`, as Claude does", () => {
    expect(commandNameFromFile("git/commit.md")).toBe("git:commit");
    expect(commandNameFromFile("a/b/c.md")).toBe("a:b:c");
  });

  it("is not a command unless it is a visible .md file", () => {
    expect(commandNameFromFile("notes.txt")).toBeNull();
    expect(commandNameFromFile("README")).toBeNull();
    expect(commandNameFromFile(".DS_Store")).toBeNull();
    expect(commandNameFromFile(".hidden.md")).toBeNull();
    expect(commandNameFromFile(".md")).toBeNull();
  });

  it("names every other file, even one that cannot be typed, so it can be listed with a reason", () => {
    expect(commandNameFromFile("has space.md")).toBe("has space");
    expect(commandNameFromFile("with_underscore.md")).toBe("with_underscore");
    expect(commandNameFromFile("dotted.name.md")).toBe("dotted.name");
  });
});

describe("untypeableReason", () => {
  it("accepts upper case, `_`, `.` and a nested name's `:`", () => {
    for (const name of ["standup", "Plain_Name", "v2.1", "git:commit", "2fa", "-x"]) expect(untypeableReason(name), name).toBeNull();
  });

  it("says why a name with a space, or anything else, cannot be typed", () => {
    expect(untypeableReason("has space")).toMatch(/space/);
    expect(untypeableReason("café")).toMatch(/letters, digits/);
  });
});

describe("readCommandDocument", () => {
  it("reads the description and the argument hint", () => {
    expect(readCommandDocument("standup", doc({ description: "Write a standup note", "argument-hint": "[yesterday]" }, "Body")))
      .toEqual({ description: "Write a standup note", argumentHint: "[yesterday]", valid: true, reason: null });
  });

  it("leaves argumentHint null when the file does not take one", () => {
    expect(readCommandDocument("standup", doc({ description: "d" }, "Body")).argumentHint).toBeNull();
    // An empty hint is the same fact as no hint, and a picker that armed the box on `argument-hint: ""`
    // would refuse to run a command that takes nothing.
    expect(readCommandDocument("standup", doc({ description: "d", "argument-hint": "  " }, "Body")).argumentHint).toBeNull();
  });

  it("runs a plain file with no frontmatter, and describes it by its first line", () => {
    expect(readCommandDocument("a", doc(null, "\n\n# Review the diff\nthen say so"))).toEqual({
      description: "Review the diff", argumentHint: null, valid: true, reason: null,
    });
    // Frontmatter without a description falls back the same way.
    expect(readCommandDocument("a", doc({ "argument-hint": "<x>" }, "Ship $0")).description).toBe("Ship $0");
  });

  it("is invalid, with a sentence, when there is nothing to send or the name cannot be typed", () => {
    expect(readCommandDocument("a", doc({ description: "d" }, "   \n\n")).reason).toMatch(/template/);
    expect(readCommandDocument("a", doc(null, "  ")).reason).toMatch(/empty/);
    expect(readCommandDocument("has space", doc(null, "body")).reason).toMatch(/space/);
    for (const bad of [doc(null, " "), doc({ description: "d" }, " ")]) {
      expect(readCommandDocument("a", bad).valid).toBe(false);
    }
  });

  it("keeps what it managed to read out of a file it has to reject", () => {
    const meta = readCommandDocument("a", doc({ description: "Ship it" }, ""));
    expect(meta.valid).toBe(false);
    expect(meta.description).toBe("Ship it");
  });

  it("refuses a name one of Realm's own commands owns, whatever else is right about the file", () => {
    const perfect = doc({ description: "Mine", "argument-hint": "<x>" }, "Template");
    for (const name of ["plan", "goal", "diff", "export", "attach", "skills", "connections"]) {
      const meta = readCommandDocument(name, perfect);
      expect(meta.valid, name).toBe(false);
      expect(meta.reason, name).toContain(`/${name}`);
    }
    // Whatever the file's case: `/plan` would match `Plan.md` too.
    expect(readCommandDocument("Plan", perfect).valid).toBe(false);
    // Not a blanket refusal: the point is the six names, not every name.
    expect(readCommandDocument("standup", perfect).valid).toBe(true);
  });

  it("reserves every mode command by construction, not by memory", () => {
    // The mode half of the list is derived from SESSION_MODES, so a fourth mode reserves its own name
    // without anyone remembering to. Dropping the spread would fail here.
    for (const m of SESSION_MODES) expect(isReservedCommandName(m.id), m.id).toBe(true);
  });
});

describe("RESERVED_COMMAND_NAMES", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const PANE = join(ROOT, "apps/desktop/src/renderer/src/panes/session/SessionPane.tsx");
  /** The prompter's own commands, as literals. `hint:` is what separates a `SlashCommand` from the
   *  pane-bar tabs a few lines above it, which share the `id`/`label` shape. */
  const literals = [...readFileSync(PANE, "utf8").matchAll(/id: "([a-z0-9-]+)", label: "[^"]*", hint:/g)].map((m) => m[1]!);

  it("finds the list it is meant to police", () => {
    // A scan that silently matched nothing would pass forever — the same guard `temp.test.ts` puts on
    // its own sweep, for the same reason.
    expect(literals.length).toBeGreaterThanOrEqual(5);
    expect(literals).toContain("goal");
  });

  it("covers every command the prompter already owns", () => {
    // If this goes red, an app command was added without reserving its name: a user's
    // `commands/<name>.md` would stop running with nothing said about it. Add the name above.
    expect(literals.filter((id) => !isReservedCommandName(id))).toEqual([]);
  });

  it("is sorted and has no duplicates, so a reader can find a name in it", () => {
    expect([...RESERVED_COMMAND_NAMES]).toEqual([...new Set(RESERVED_COMMAND_NAMES)].sort());
  });
});

describe("expandCommand", () => {
  it("puts the whole argument string wherever $ARGUMENTS appears", () => {
    expect(expandCommand("Review $ARGUMENTS, then say so about $ARGUMENTS.", "the auth code").text)
      .toBe("Review the auth code, then say so about the auth code.");
  });

  it("numbers the words from $0, as Claude's CLI does", () => {
    expect(expandCommand("$0/$1/$2", "a b c").text).toBe("a/b/c");
    expect(expandCommand("$ARGUMENTS[0]-$ARGUMENTS[2]", "a b c").text).toBe("a-c");
  });

  it("has no last placeholder: $10 is the eleventh word", () => {
    // Claude 2.1.322, measured: twelve words fill $0…$11, and $12 stays standing.
    const args = "a b c d e f g h i j k l";
    expect(expandCommand("$9 $10 $11 $ARGUMENTS[10]", args).text).toBe("j k l k");
    const out = expandCommand("[$0] [$12] [$100]", args);
    expect(out.text).toBe("[a] [$12] [$100]");
    expect(out.missing).toEqual(["$12", "$100"]);
  });

  it("keeps a quoted run as one word", () => {
    expect(expandCommand("[$0] [$1]", `"old name" 'new one'`).text).toBe("[old name] [new one]");
  });

  it("trims the argument string, and splits words on any run of whitespace", () => {
    expect(expandCommand("[$ARGUMENTS] [$0] [$1]", "   one    two  ").text).toBe("[one    two] [one] [two]");
  });

  it("leaves an unmatched positional standing, and says which", () => {
    // Empty would be the silent failure: "compare  and b" still reads as a sentence, and the agent
    // would answer a question nobody asked.
    const out = expandCommand("compare $0 and $2", "only-one");
    expect(out.text).toBe("compare only-one and $2");
    expect(out.missing).toEqual(["$2"]);
  });

  it("reports each missing placeholder once, in the order they appear", () => {
    expect(expandCommand("$3 $2 $3 $2 $ARGUMENTS[5]", "a").missing).toEqual(["$3", "$2", "$ARGUMENTS[5]"]);
  });

  it("expands $ARGUMENTS to nothing when there were no arguments, and does not call that missing", () => {
    expect(expandCommand("Summarise: $ARGUMENTS", "   ")).toEqual({ text: "Summarise: ", missing: [] });
  });

  it("does not rescan what it substituted", () => {
    // A single pass is the whole reason: an argument that mentions $1 must arrive as the text the
    // user typed, not as a word again.
    expect(expandCommand("$ARGUMENTS", "literally $1 and $ARGUMENTS").text).toBe("literally $1 and $ARGUMENTS");
    expect(expandCommand("$0", "$1 x").text).toBe("$1");
  });

  it("leaves an escaped or run-on placeholder alone", () => {
    expect(expandCommand("\\$0 costs \\$ARGUMENTS, $0th", "").text).toBe("$0 costs $ARGUMENTS, $0th");
  });

  it("puts what was typed on an ARGUMENTS line when the template names no placeholder", () => {
    // Claude's rule, and what keeps a plain .md from dropping the words typed after it.
    expect(expandCommand("Run the tests.", "only the slow ones")).toEqual({ text: "Run the tests.\n\nARGUMENTS: only the slow ones", missing: [] });
    expect(expandCommand("Run the tests.", "  ")).toEqual({ text: "Run the tests.", missing: [] });
  });
});

describe("runnableCommands", () => {
  const cmd = (name: string, over: Partial<UserCommand> = {}): UserCommand => ({
    name, description: "d", argumentHint: null, path: `/c/${name}.md`,
    origin: { kind: "user", key: "user", label: "~/Realm/commands", root: "/c", writable: true },
    valid: true, reason: null, shadowedBy: null, ...over,
  });

  it("keeps only what /name would actually run", () => {
    const all = [cmd("a"), cmd("b", { valid: false, reason: "no `description`" }), cmd("c", { shadowedBy: "/space/commands/c.md" })];
    expect(runnableCommands(all).map((c) => c.name)).toEqual(["a"]);
  });
});
