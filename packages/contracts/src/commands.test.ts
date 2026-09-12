import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESERVED_COMMAND_NAMES, commandNameFromFile, expandCommand, isReservedCommandName, readCommandDocument,
  runnableCommands, CommandNameSchema, type UserCommand,
} from "./commands";
import { SESSION_MODES } from "./presets";

const doc = (frontmatter: Record<string, string> | null, body: string) => ({ frontmatter, body });

describe("commandNameFromFile", () => {
  it("takes the name off the filename", () => {
    expect(commandNameFromFile("standup.md")).toBe("standup");
    expect(commandNameFromFile("write-tests.md")).toBe("write-tests");
  });

  it("folds case, because macOS hands back the name it feels like", () => {
    // A file created as `standup.md` and read back as `Standup.MD` has to be one command, not two —
    // and the lower-cased name is also the only one `filterSlashCommands` can ever match.
    expect(commandNameFromFile("Standup.MD")).toBe("standup");
  });

  it("is not a command unless it is a .md file", () => {
    expect(commandNameFromFile("notes.txt")).toBeNull();
    expect(commandNameFromFile("README")).toBeNull();
    expect(commandNameFromFile(".DS_Store")).toBeNull();
  });

  it("refuses a name the prompter could never type", () => {
    // `slashQueryAt` stops the token at the first character outside [a-z0-9-], so each of these would
    // list a command that no amount of typing selects.
    expect(commandNameFromFile("has space.md")).toBeNull();
    expect(commandNameFromFile("with_underscore.md")).toBeNull();
    expect(commandNameFromFile("dotted.name.md")).toBeNull();
    expect(commandNameFromFile("-leading.md")).toBeNull();
    expect(commandNameFromFile(".md")).toBeNull();
  });

  it("accepts exactly what the schema does", () => {
    expect(CommandNameSchema.safeParse("standup").success).toBe(true);
    expect(CommandNameSchema.safeParse("Standup").success).toBe(false);
    expect(CommandNameSchema.safeParse("2fa").success).toBe(true);
  });
});

describe("readCommandDocument", () => {
  it("reads the description and the argument hint", () => {
    expect(readCommandDocument("standup", doc({ description: "Write a standup note", "argument-hint": "[yesterday]" }, "Body")))
      .toEqual({ description: "Write a standup note", argumentHint: "[yesterday]", body: "Body", valid: true, reason: null });
  });

  it("leaves argumentHint null when the file does not take one", () => {
    expect(readCommandDocument("standup", doc({ description: "d" }, "Body")).argumentHint).toBeNull();
    // An empty hint is the same fact as no hint, and a picker that armed the box on `argument-hint: ""`
    // would refuse to run a command that takes nothing.
    expect(readCommandDocument("standup", doc({ description: "d", "argument-hint": "  " }, "Body")).argumentHint).toBeNull();
  });

  it("is invalid, with a different sentence, for each way a file falls short", () => {
    expect(readCommandDocument("a", doc(null, "just prose")).reason).toMatch(/frontmatter/);
    expect(readCommandDocument("a", doc({ name: "a" }, "body")).reason).toMatch(/`description`/);
    expect(readCommandDocument("a", doc({ description: "d" }, "   \n\n")).reason).toMatch(/template/);
    for (const bad of [doc(null, "x"), doc({ name: "a" }, "b"), doc({ description: "d" }, " ")]) {
      expect(readCommandDocument("a", bad).valid).toBe(false);
    }
  });

  it("keeps what it managed to read out of a file it has to reject", () => {
    // The opposite of the skills reader's `invalidMeta`, on purpose: there is no directory name to
    // fall back on here, and showing the author the half that parsed is how they find the half that
    // did not.
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

  it("fills $1…$9 from the words", () => {
    const args = "a b c d e f g h i";
    expect(expandCommand("$1/$2/$3/$4/$5/$6/$7/$8/$9", args).text).toBe("a/b/c/d/e/f/g/h/i");
  });

  it("trims the argument string, and splits words on any run of whitespace", () => {
    expect(expandCommand("[$ARGUMENTS] [$1] [$2]", "   one    two  ").text).toBe("[one    two] [one] [two]");
  });

  it("leaves an unmatched positional standing, and says which", () => {
    // Empty would be the silent failure: "compare  and b" still reads as a sentence, and the agent
    // would answer a question nobody asked.
    const out = expandCommand("compare $1 and $3", "only-one");
    expect(out.text).toBe("compare only-one and $3");
    expect(out.missing).toEqual(["$3"]);
  });

  it("reports each missing placeholder once, in the order they appear", () => {
    expect(expandCommand("$3 $2 $3 $2", "a").missing).toEqual(["$3", "$2"]);
  });

  it("says nothing is missing when everything landed", () => {
    expect(expandCommand("$ARGUMENTS $1", "a b").missing).toEqual([]);
  });

  it("expands $ARGUMENTS to nothing when there were no arguments, and does not call that missing", () => {
    // Unlike a positional: the rest of the line exists and is empty, and there is no other word it
    // could have meant. The truncated sentence is visible in the draft either way.
    expect(expandCommand("Summarise: $ARGUMENTS", "   ")).toEqual({ text: "Summarise: ", missing: [] });
  });

  it("does not rescan what it substituted", () => {
    // A single pass is the whole reason: an argument that mentions $1 must arrive as the text the
    // user typed, not as the first word again.
    expect(expandCommand("$ARGUMENTS", "literally $1 and $ARGUMENTS").text).toBe("literally $1 and $ARGUMENTS");
    expect(expandCommand("$1", "$2 x").text).toBe("$2");
  });

  it("leaves $10 and $0 alone rather than half-expanding them", () => {
    // Without the (?![0-9]) guard `$10` becomes "<first word>0" — a template that quietly means
    // something else, which is the failure this function exists to prevent.
    expect(expandCommand("$10 $0 $ARGUMENTSX", "a b").text).toBe("$10 $0 $ARGUMENTSX");
  });

  it("returns a template with no placeholders unchanged", () => {
    expect(expandCommand("Run the tests.", "ignored")).toEqual({ text: "Run the tests.", missing: [] });
  });
});

describe("runnableCommands", () => {
  const cmd = (name: string, over: Partial<UserCommand> = {}): UserCommand => ({
    name, description: "d", argumentHint: null, body: "b", path: `/c/${name}.md`,
    origin: { kind: "user", key: "user", label: "~/Realm/commands", root: "/c", writable: true },
    valid: true, reason: null, shadowedBy: null, ...over,
  });

  it("keeps only what /name would actually run", () => {
    const all = [cmd("a"), cmd("b", { valid: false, reason: "no `description`" }), cmd("c", { shadowedBy: "/space/commands/c.md" })];
    expect(runnableCommands(all).map((c) => c.name)).toEqual(["a"]);
  });
});
