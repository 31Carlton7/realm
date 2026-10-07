import { describe, expect, it } from "vitest";
import { DEFAULT_KEYBINDINGS, scriptCommandId, type Keybinding } from "@realm/contracts";
import {
  FOREIGN_GROUP, SCRIPTS_GROUP, UNBOUND_GROUP,
  commandEntries, describeRules, filterEntries, groupEntries,
} from "./keybindings-model";

const SCRIPT_ID = `01HQ${"0".repeat(22)}`;
const stateOf = (rules: Keybinding[], index: number) => describeRules(rules)[index]!;

describe("describeRules — which rule actually holds a chord", () => {
  it("a later rule on the same chord defeats the earlier one, and names what took it", () => {
    /* THE MUTANT: resolve precedence by walking forward and keeping the FIRST rule per key. Every
       assertion below flips — the shipped default reads as live and the user's override reads as
       defeated — which is the page teaching a shortcut that does nothing, in reverse. */
    const rules: Keybinding[] = [
      { key: "mod+k", command: "palette.toggle" },
      { key: "mod+k", command: "terminal.new" },
    ];
    expect(stateOf(rules, 0).state).toBe("defeated");
    expect(stateOf(rules, 0).defeatedBy).toEqual({ index: 1, command: "terminal.new" });
    expect(stateOf(rules, 1).state).toBe("live");
    expect(stateOf(rules, 1).defeatedBy).toBeNull();
  });

  it("two spellings of one chord are one chord — `Cmd+Shift+K` defeats `mod+shift+k`", () => {
    /* Rule 1, which is what makes rule 2 hold in practice. THE MUTANT: compare `rule.key` strings
       directly instead of normalising. The two rules stop colliding, both read as live, and the
       user's override sits in the file reading correctly and never firing. */
    const rules: Keybinding[] = [
      { key: "mod+shift+k", command: "palette.toggle" },
      { key: "Cmd+Shift+K", command: "terminal.new" },
    ];
    expect(stateOf(rules, 0).state).toBe("defeated");
    expect(stateOf(rules, 1).state).toBe("live");
  });

  it("a rule whose `when` is false right now is CONDITIONAL, never defeated and never absent", () => {
    /* ⌘U is a shipped default guarded on `sessionFocus`, which is false in the idle frame.
       THE MUTANT: drop the `whenHolds` branch. `matchKeybinding` then skips the rule, the winner for
       ⌘U comes back null, and the page reports a live binding for a rule that is waiting — or, with
       the null handled the other way, reports it defeated by a rule that is not even there. */
    const attach = DEFAULT_KEYBINDINGS.findIndex((r) => r.command === "session.attachFiles");
    expect(attach).toBeGreaterThanOrEqual(0);
    const view = stateOf([...DEFAULT_KEYBINDINGS], attach);
    expect(view.state).toBe("conditional");
    expect(view.defeatedBy).toBeNull();
    expect(view.display).toBe("⌘U");
  });

  it("every other shipped default is live — the idle frame is the frame they were written for", () => {
    // The counterweight to the test above: if "conditional" crept onto the ordinary guard
    // (`!overlayOpen && !inputFocus`), most of this page would carry a sentence nobody needs.
    const views = describeRules([...DEFAULT_KEYBINDINGS]);
    const conditional = views.filter((v) => v.state === "conditional").map((v) => v.rule.command);
    expect(conditional).toEqual(["session.attachFiles", "terminal.toggle", "session.dispatchDraft", "session.interrupt"]);
    expect(views.filter((v) => v.state === "live")).toHaveLength(DEFAULT_KEYBINDINGS.length - 4);
  });

  it("an unreadable key is reported as unreadable, with the user's own text kept", () => {
    /* THE MUTANT: fall back to `state: "live"` for an unparseable key. The row then claims a working
       shortcut for a line that can never fire, which is the one failure a keymap page must not have.
       The verbatim display is the other half: a glyph fallback would hide the typo being looked for. */
    const view = stateOf([{ key: "ctrl+k ctrl+c", command: "palette.toggle" }], 0);
    expect(view.state).toBe("bad-key");
    expect(view.chord).toBeNull();
    expect(view.display).toBe("ctrl+k ctrl+c");
  });

  it("an unreadable `when` is told apart from a condition that is merely false", () => {
    /* `whenHolds` folds both into `false` — right for the resolver, useless here. THE MUTANT: use
       `whenHolds` alone and report "conditional". The row then reads "only while a & b", which is a
       promise about a state the rule will never reach: the clause does not parse, so it is false in
       every context and the binding is dead. */
    const rules: Keybinding[] = [{ key: "mod+k", command: "palette.toggle", when: "a & b" }];
    expect(stateOf(rules, 0).state).toBe("bad-when");
    expect(stateOf([{ key: "mod+k", command: "palette.toggle", when: "sessionFocus" }], 0).state).toBe("conditional");
  });

  it("a rule with no `when` at all is live, not conditional", () => {
    expect(stateOf([{ key: "mod+k", command: "palette.toggle" }], 0).state).toBe("live");
    expect(stateOf([{ key: "mod+k", command: "palette.toggle", when: "  " }], 0).state).toBe("live");
  });
});

describe("commandEntries — the catalogue, plus everything the catalogue cannot contain", () => {
  it("lists every catalogued command, bound or not", () => {
    const entries = commandEntries(describeRules([...DEFAULT_KEYBINDINGS]));
    expect(entries.filter((e) => e.known).length).toBeGreaterThanOrEqual(40);
    const unbound = entries.find((e) => e.id === "pane.rename");
    expect(unbound?.bindings).toEqual([]); // Realm ships no chord for it; the row still exists
    expect(entries.find((e) => e.id === "palette.toggle")?.bindings).toHaveLength(1);
  });

  it("a rule naming a project script gets its own group rather than vanishing", () => {
    /* THE MUTANT: build entries from KEY_COMMANDS alone. A user who bound ⌘⇧T to their own script
       opens this page and finds no trace of the rule they wrote — which reads as "Realm lost it". */
    const id = scriptCommandId(SCRIPT_ID);
    const entries = commandEntries(describeRules([{ key: "mod+shift+t", command: id }]));
    const mine = entries.find((e) => e.id === id);
    expect(mine?.group).toBe(SCRIPTS_GROUP);
    expect(mine?.known).toBe(false); // the label IS the id, so the panel sets it as code
    expect(mine?.bindings).toHaveLength(1);
  });

  it("an id from some other Realm is listed too, under its own heading", () => {
    const entries = commandEntries(describeRules([{ key: "mod+shift+y", command: "future.thing" }]));
    expect(entries.find((e) => e.id === "future.thing")?.group).toBe(FOREIGN_GROUP);
  });

  it("an unbind is one prose row, not a command called empty string", () => {
    const entries = commandEntries(describeRules([
      { key: "mod+t", command: "" },
      { key: "mod+n", command: "" },
    ]));
    const off = entries.filter((e) => e.group === UNBOUND_GROUP);
    expect(off).toHaveLength(1);
    expect(off[0]!.known).toBe(true); // prose, or the row renders an empty <code>
    expect(off[0]!.bindings).toHaveLength(2);
  });

  it("groups drop when empty and keep the catalogue's own order", () => {
    const groups = groupEntries(commandEntries(describeRules([{ key: "mod+k", command: "palette.toggle" }])))
      .map((g) => g.group);
    expect(groups).toEqual(["Panes", "Spaces", "Sessions", "App"]);
    expect(groups).not.toContain(SCRIPTS_GROUP);
  });
});

describe("filterEntries", () => {
  const entries = commandEntries(describeRules([...DEFAULT_KEYBINDINGS]));

  it("finds a command by its label", () => {
    expect(filterEntries(entries, "palette").map((e) => e.id)).toContain("palette.toggle");
  });

  it("finds a command by the chord as PRINTED and by the chord as WRITTEN", () => {
    /* THE MUTANT: match only `b.display`. "mod+k" — the spelling in the file the page is rendering,
       and the one a person arrives with after reading it — then finds nothing at all. */
    expect(filterEntries(entries, "⌘K").map((e) => e.id)).toContain("palette.toggle");
    expect(filterEntries(entries, "mod+k").map((e) => e.id)).toContain("palette.toggle");
  });

  it("an empty query is every entry, and a miss is none", () => {
    expect(filterEntries(entries, "   ")).toHaveLength(entries.length);
    expect(filterEntries(entries, "zzzz")).toHaveLength(0);
  });
});
