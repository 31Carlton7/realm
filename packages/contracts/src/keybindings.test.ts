import { describe, expect, it } from "vitest";
import {
  ALWAYS_SWALLOWED_CHORDS, CONTEXT_KEYS, KEY_COMMANDS, DEFAULT_KEYBINDINGS, KeybindingSchema,
  chordsForCommand, commandForChord, defaultIsClaimed, displayKeyChord, evaluateWhen, formatKeyChord,
  matchKeybinding, mergeDefaults, normalizeKeyChord, parseKeyChord, parseWhen, whenHolds,
  type Keybinding, type WhenExpr,
} from "./keybindings";

describe("chord spelling (rule 1: one keystroke, one string)", () => {
  it("folds every spelling of ⌘⇧K onto one canonical string", () => {
    /* THE MUTANT: drop the `.toLowerCase()`, the glyph expansion, or the cmd→mod fold. Each one
       leaves two spellings of one keystroke that do not compare equal, which is how a user's
       override ends up in the file, reading correctly, and never firing. */
    for (const spelling of ["mod+shift+k", "cmd+shift+k", "Shift+Mod+K", "COMMAND+SHIFT+K", "meta+shift+k", "⌘⇧K", "⌘⇧k", "⌘+⇧+K", " mod + shift + k "]) {
      expect(normalizeKeyChord(spelling), spelling).toBe("mod+shift+k");
    }
  });

  it("puts the modifiers in one fixed order however they were written", () => {
    expect(normalizeKeyChord("shift+alt+ctrl+mod+a")).toBe("mod+ctrl+alt+shift+a");
    expect(normalizeKeyChord("mod+ctrl+alt+shift+a")).toBe("mod+ctrl+alt+shift+a");
  });

  it("carries shift as a modifier and never as a letter's case", () => {
    // THE MUTANT: infer shift from an uppercase key. `mod+K` would then be ⌘⇧K, and a file holding
    // both would have two rules fighting over one chord with no way to tell them apart.
    expect(normalizeKeyChord("mod+K")).toBe("mod+k");
    expect(normalizeKeyChord("mod+K")).not.toBe(normalizeKeyChord("mod+shift+k"));
  });

  it("round-trips parse → format for every shipped default", () => {
    for (const rule of DEFAULT_KEYBINDINGS) {
      const chord = parseKeyChord(rule.key);
      expect(chord, rule.key).not.toBeNull();
      const formatted = formatKeyChord(chord!);
      expect(formatted, rule.key).toBe(rule.key); // the table itself is written canonically
      expect(normalizeKeyChord(formatted), rule.key).toBe(formatted);
    }
  });

  it("accepts the aliases a person actually types, and canonicalises them", () => {
    expect(normalizeKeyChord("esc")).toBe("escape");
    expect(normalizeKeyChord("Escape")).toBe("escape");
    expect(normalizeKeyChord("mod+Return")).toBe("mod+enter");
    expect(normalizeKeyChord("mod+ArrowUp")).toBe("mod+up");
    expect(normalizeKeyChord("ctrl+PgDn")).toBe("ctrl+pagedown");
    expect(normalizeKeyChord("mod+plus")).toBe("mod++");
    expect(normalizeKeyChord("opt+f12")).toBe("alt+f12");
  });

  it("binds the literal plus key, which shares the separator's character", () => {
    expect(normalizeKeyChord("mod++")).toBe("mod++");
    expect(normalizeKeyChord("+")).toBe("+");
  });

  it("refuses what it cannot match, rather than guessing", () => {
    // Each of these would otherwise become a rule that is written down, spelled plausibly, and dead.
    expect(parseKeyChord("")).toBeNull();
    expect(parseKeyChord("mod+")).toBeNull();
    expect(parseKeyChord("shift")).toBeNull();      // a modifier alone is not a chord
    expect(parseKeyChord("⌘")).toBeNull();
    expect(parseKeyChord("mod+foo")).toBeNull();    // not a key Realm can name
    expect(parseKeyChord("mod+f21")).toBeNull();    // no keyboard has one
    expect(parseKeyChord("hyper+k")).toBeNull();    // not a modifier Realm knows
  });

  it("refuses a two-stroke sequence instead of binding its first stroke", () => {
    // VS Code's `ctrl+k ctrl+c` shape. Firing on ⌘K alone would run half of what was written.
    expect(parseKeyChord("mod+k mod+c")).toBeNull();
  });
});

describe("displayKeyChord", () => {
  it("prints the glyphs the palette's own hints already use", () => {
    // ⌘ first, matching `formatKeyChord` and the hardcoded <kbd> rows in CommandPalette.tsx — not
    // macOS's menu order, which puts ⌘ nearest the key.
    expect(displayKeyChord("mod+shift+f")).toBe("⌘⇧F");
    expect(displayKeyChord("mod+alt+left")).toBe("⌘⌥←");
    expect(displayKeyChord("ctrl+shift+tab")).toBe("⌃⇧⇥");
    expect(displayKeyChord("escape")).toBe("esc");
    expect(displayKeyChord("mod+shift+enter")).toBe("⌘⇧↩");
  });
  it("shows an unparseable key verbatim, so the typo is findable", () => {
    // THE MUTANT: fall back to a glyph or an empty string, and the one thing the user needs to see —
    // what their file actually says — is the thing the UI hides.
    expect(displayKeyChord("mod+wat")).toBe("mod+wat");
  });
});

describe("when expressions", () => {
  const ctx = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, true]));

  it("binds && tighter than ||", () => {
    /* THE MUTANT: fold left to right with no precedence, so `a || b && c` means `(a || b) && c`.
       With `a` alone true, the real answer is true and the flat one is false. */
    expect(whenHolds("a || b && c", ctx("a"))).toBe(true);
    expect(whenHolds("a || b && c", ctx("b"))).toBe(false);   // (b && c) is false and a does not carry it
    expect(whenHolds("a || b && c", ctx("b", "c"))).toBe(true);
  });

  it("binds ! tightest, and takes parentheses", () => {
    expect(whenHolds("!a && b", ctx("b"))).toBe(true);
    expect(whenHolds("!a && b", ctx("a", "b"))).toBe(false);
    expect(whenHolds("!(a && b)", ctx("a"))).toBe(true);
    expect(whenHolds("(a || b) && c", ctx("b", "c"))).toBe(true);
    expect(whenHolds("(a || b) && c", ctx("b"))).toBe(false);
    expect(whenHolds("!!a", ctx("a"))).toBe(true);
  });

  it("reads an absent context key as false", () => {
    expect(whenHolds("sessionFocus", {})).toBe(false);
    expect(whenHolds("!sessionFocus", {})).toBe(true);
  });

  it("treats an absent or blank clause as unconditional", () => {
    expect(whenHolds(undefined, {})).toBe(true);
    expect(whenHolds("   ", {})).toBe(true);
  });

  it("makes a clause that does not parse INERT, never unconditional", () => {
    /* THE MUTANT: `return expr === null ? true : …`. One typo would then become a binding that fires
       everywhere — including inside the composer — which is the worst outcome this layer has. */
    for (const broken of ["a &&", "a & b", "!", "(a", "a b", "a && b )", "a ||| b", "1a"]) {
      expect(parseWhen(broken), broken).toBeNull();
      expect(whenHolds(broken, { a: true, b: true }), broken).toBe(false);
    }
  });

  it("parses dotted and underscored key names", () => {
    const expr = parseWhen("pane.focus_a");
    expect(expr).toEqual({ kind: "key", name: "pane.focus_a" });
    expect(evaluateWhen(expr!, { "pane.focus_a": true })).toBe(true);
  });
});

describe("resolver (rule 2: the last matching rule wins, across commands)", () => {
  const idle = {};

  it("lets a later rule defeat an earlier one for a different command", () => {
    /* THE MUTANT: scan forwards and take the first match. The override a user writes at the bottom of
       their file is then dead, which is the single thing this whole feature is for. */
    const rules: Keybinding[] = [
      { key: "mod+k", command: "palette.toggle" },
      { key: "mod+k", command: "session.new" },
    ];
    expect(commandForChord(rules, "mod+k", idle)).toBe("session.new");
    expect(matchKeybinding(rules, "mod+k", idle)?.index).toBe(1);
  });

  it("wins across spellings, not just across identical strings", () => {
    // Rule 1 and rule 2 are one mechanism: an override written `⌘K` must defeat a default written
    // `mod+k`, or the override silently does not take.
    const rules: Keybinding[] = [
      { key: "mod+k", command: "palette.toggle" },
      { key: "⌘K", command: "terminal.new" },
    ];
    expect(commandForChord(rules, "mod+k", idle)).toBe("terminal.new");
  });

  it("skips a later rule whose `when` does not hold, without losing the earlier one", () => {
    const rules: Keybinding[] = [
      { key: "mod+j", command: "sidebar.toggle" },
      { key: "mod+j", command: "terminal.toggle", when: "sessionFocus" },
    ];
    expect(commandForChord(rules, "mod+j", { sessionFocus: true })).toBe("terminal.toggle");
    expect(commandForChord(rules, "mod+j", {})).toBe("sidebar.toggle");
  });

  it("unbinds on an empty command, and says so distinguishably", () => {
    const rules: Keybinding[] = [
      { key: "mod+w", command: "pane.close" },
      { key: "mod+w", command: "" },
    ];
    expect(commandForChord(rules, "mod+w", idle)).toBeNull();
    // The caller has to tell "unbound on purpose" from "nothing matched" — one means swallow nothing
    // and the other means there was never a binding here at all.
    expect(matchKeybinding(rules, "mod+w", idle)).toEqual({ index: 1, rule: rules[1], command: "" });
    expect(matchKeybinding(rules, "mod+q", idle)).toBeNull();
  });

  it("binds a command id it has never heard of (rule 3)", () => {
    /* THE MUTANT: validate `command` against KEY_COMMANDS. Project scripts bind as `script.<id>.run` and
       those ids do not exist until a user writes one. */
    const rules: Keybinding[] = [{ key: "mod+shift+r", command: "script.build.run" }];
    expect(commandForChord(rules, "mod+shift+r", idle)).toBe("script.build.run");
    expect(KeybindingSchema.safeParse(rules[0]).success).toBe(true);
  });

  it("ignores a rule whose key cannot be parsed, and lets the earlier one stand", () => {
    const rules: Keybinding[] = [
      { key: "mod+t", command: "terminal.new" },
      { key: "mod+wat", command: "terminal.new" },
    ];
    expect(commandForChord(rules, "mod+t", idle)).toBe("terminal.new");
    expect(matchKeybinding(rules, "mod+wat", idle)).toBeNull();
  });

  it("refuses to match on an unparseable chord rather than matching everything", () => {
    expect(commandForChord([{ key: "", command: "x" }], "", idle)).toBeNull();
  });
});

describe("chordsForCommand", () => {
  it("finds the chord a command answers to", () => {
    expect(chordsForCommand(DEFAULT_KEYBINDINGS, "terminal.new")).toEqual(["mod+t"]);
    expect(chordsForCommand(DEFAULT_KEYBINDINGS, "palette.toggle")).toEqual(["mod+k"]);
  });

  it("does not advertise a binding a later rule has already taken", () => {
    /* THE MUTANT: filter rules by name. The hint would then print ⌘K beside "Command palette" for a
       user who rebound ⌘K to something else — a shortcut the UI teaches and the app does not run. */
    const rules: Keybinding[] = [
      { key: "mod+k", command: "palette.toggle" },
      { key: "mod+k", command: "terminal.new" },
    ];
    expect(chordsForCommand(rules, "palette.toggle")).toEqual([]);
    expect(chordsForCommand(rules, "terminal.new")).toEqual(["mod+k"]);
  });

  it("answers in the idle frame, where the shipped guards hold", () => {
    // Every shipped `when` is a negation of an unusual state, so "nothing is happening" must satisfy
    // them — otherwise no hint could ever be shown for a command that has one.
    expect(chordsForCommand(DEFAULT_KEYBINDINGS, "pane.close")).toEqual(["mod+w"]);
    expect(chordsForCommand(DEFAULT_KEYBINDINGS, "session.attachFiles", { sessionFocus: true })).toEqual(["mod+u"]);
  });
});

describe("the shipped table", () => {
  const commandIds = new Set(KEY_COMMANDS.map((c) => c.id));
  const contextKeys = new Set(CONTEXT_KEYS.map((c) => c.key));

  it("names only commands the catalog carries", () => {
    for (const rule of DEFAULT_KEYBINDINGS) expect(commandIds.has(rule.command), rule.command).toBe(true);
  });

  it("has no duplicate command ids", () => {
    expect(new Set(KEY_COMMANDS.map((c) => c.id)).size).toBe(KEY_COMMANDS.length);
  });

  it("puts at most one default on any chord, so no default defeats another", () => {
    const keys = DEFAULT_KEYBINDINGS.map((r) => normalizeKeyChord(r.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("writes every `when` in the language, over keys the app actually publishes", () => {
    /* THE MUTANT: a typo in one clause — `!overlyOpen`. It parses, it is always true, and the binding
       silently starts firing while the palette is open. Nothing else in the suite would notice. */
    for (const rule of DEFAULT_KEYBINDINGS) {
      if (rule.when === undefined) continue;
      const expr = parseWhen(rule.when);
      expect(expr, rule.when).not.toBeNull();
      for (const name of keyNames(expr!)) expect(contextKeys.has(name), `${rule.command}: ${name}`).toBe(true);
    }
  });

  it("keeps the pre-existing shortcuts exactly, so nothing is rebound by accident", () => {
    const chordOf = (command: string) => chordsForCommand(DEFAULT_KEYBINDINGS, command, { sessionFocus: true, sessionRunning: true })[0];
    expect(chordOf("palette.toggle")).toBe("mod+k");
    expect(chordOf("sidebar.toggle")).toBe("mod+b");
    expect(chordOf("terminal.new")).toBe("mod+t");
    expect(chordOf("session.new")).toBe("mod+n");
    expect(chordOf("pane.close")).toBe("mod+w");
    expect(chordOf("pane.splitRight")).toBe("mod+\\");
    expect(chordOf("pane.splitDown")).toBe("mod+shift+\\");
    expect(chordOf("pane.toggleFocus")).toBe("mod+shift+f");
    expect(chordOf("spaces.toggle")).toBe("mod+shift+space");
    expect(chordOf("space.next")).toBe("ctrl+tab");
    expect(chordOf("space.previous")).toBe("ctrl+shift+tab");
    expect(chordOf("space.select.1")).toBe("mod+1");
    expect(chordOf("space.select.9")).toBe("mod+9");
    expect(chordOf("session.attachFiles")).toBe("mod+u");
    expect(chordOf("terminal.toggle")).toBe("mod+j");
    expect(chordOf("session.dispatchDraft")).toBe("mod+shift+enter");
    expect(chordOf("session.interrupt")).toBe("escape");
  });

  it("swallows ⌘W in a spelling the resolver agrees with", () => {
    for (const chord of ALWAYS_SWALLOWED_CHORDS) expect(normalizeKeyChord(chord)).toBe(chord);
    expect(ALWAYS_SWALLOWED_CHORDS).toContain("mod+w");
  });
});

describe("merging newly shipped defaults", () => {
  const shipped: Keybinding[] = [
    { key: "mod+k", command: "palette.toggle", when: "!sheetOpen" },
    { key: "mod+t", command: "terminal.new" },
  ];

  it("adds nothing on a steady-state boot", () => {
    expect(mergeDefaults(shipped, shipped)).toEqual(shipped);
    // …and stays that way however many times it runs.
    expect(mergeDefaults(mergeDefaults(shipped, shipped), shipped)).toEqual(shipped);
  });

  it("appends a default the file has never seen", () => {
    const existing: Keybinding[] = [{ key: "mod+k", command: "palette.toggle", when: "!sheetOpen" }];
    expect(mergeDefaults(existing, shipped)).toEqual([...existing, { key: "mod+t", command: "terminal.new" }]);
  });

  it("leaves a rebound command alone, even though its shipped key is free", () => {
    /* THE MUTANT: claim by key only. The user moved the palette to ⌘P; re-seeding the ⌘K default
       would hand them back a second way to do it that they deliberately removed. */
    const existing: Keybinding[] = [{ key: "mod+p", command: "palette.toggle" }];
    expect(mergeDefaults(existing, shipped)).toEqual([...existing, { key: "mod+t", command: "terminal.new" }]);
  });

  it("leaves a claimed KEY alone, even though the command is not in the file", () => {
    /* THE MUTANT: claim by command only. A newly shipped default would land on a chord the user had
       already given to something else and — appended last — silently win it. */
    const existing: Keybinding[] = [{ key: "mod+t", command: "script.build.run" }];
    expect(mergeDefaults(existing, shipped)).toEqual([
      { key: "mod+t", command: "script.build.run" },
      { key: "mod+k", command: "palette.toggle", when: "!sheetOpen" },
    ]);
  });

  it("treats an unbind as a claim, which is what makes a removal stick", () => {
    const existing: Keybinding[] = [{ key: "mod+t", command: "" }];
    expect(mergeDefaults(existing, shipped).some((r) => r.command === "terminal.new")).toBe(false);
    expect(defaultIsClaimed(existing, { key: "⌘T", command: "terminal.new" })).toBe(true);
  });

  it("appends, so the user's own rules keep their precedence", () => {
    // Position IS precedence (rule 2). A merge that prepended, or re-sorted, would quietly reorder
    // every override the user had already tuned.
    const existing: Keybinding[] = [{ key: "mod+e", command: "a" }, { key: "mod+e", command: "b" }];
    const merged = mergeDefaults(existing, shipped);
    expect(merged.slice(0, 2)).toEqual(existing);
    expect(commandForChord(merged, "mod+e", {})).toBe("b");
  });
});

/** Every context key an expression reads. Test-local: nothing in the app needs it, and a walker in
 *  the module would be API that exists only to be tested. */
function keyNames(expr: WhenExpr): string[] {
  switch (expr.kind) {
    case "key": return [expr.name];
    case "not": return keyNames(expr.expr);
    case "and": case "or": return [...keyNames(expr.left), ...keyNames(expr.right)];
  }
}
