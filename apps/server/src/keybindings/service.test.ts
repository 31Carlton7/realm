import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_KEYBINDINGS, commandForChord, type Keybinding } from "@realm/contracts";
import { tempDir } from "@realm/test-utils";
import { KeybindingsService, keybindingsPath } from "./service";

/** A two-rule stand-in for what Realm ships, so the merge tests read as themselves rather than as an
 *  assertion about the size of the real table. */
const SHIPPED: Keybinding[] = [
  { key: "mod+k", command: "palette.toggle", when: "!sheetOpen" },
  { key: "mod+t", command: "terminal.new" },
];

let home: string;
let logs: string[];
const service = (defaults: Keybinding[] | undefined = SHIPPED) =>
  new KeybindingsService({ home, defaults, onLog: (l) => logs.push(l) });
const onDisk = (): unknown => JSON.parse(readFileSync(keybindingsPath(home), "utf8"));
const put = (body: string) => writeFileSync(keybindingsPath(home), body);

beforeEach(() => { home = tempDir("realm-keys-"); logs = []; });

describe("first run", () => {
  it("seeds the defaults into the file and hands them back", () => {
    const file = service().read();
    expect(file.path).toBe(keybindingsPath(home));
    expect(file.rules).toEqual(SHIPPED);
    expect(file.error).toBeNull();
    expect(onDisk()).toEqual(SHIPPED);
  });

  it("seeds the real shipped table, which is what a user first opens", () => {
    // THE MUTANT: seed `[]`. The file would exist, parse, claim nothing, and every default would be
    // re-added on the next read — a file that fills itself in one release late.
    expect(new KeybindingsService({ home }).read().rules).toEqual([...DEFAULT_KEYBINDINGS]);
  });

  it("leaves the seeded file alone on the next read", () => {
    const first = service().read();
    const before = readFileSync(keybindingsPath(home), "utf8");
    expect(service().read().rules).toEqual(first.rules);
    expect(readFileSync(keybindingsPath(home), "utf8")).toBe(before);
  });
});

describe("merging newly shipped defaults", () => {
  it("adds a default the file has never seen, and writes it down", () => {
    put(JSON.stringify([{ key: "mod+k", command: "palette.toggle", when: "!sheetOpen" }]));
    const file = service().read();
    expect(file.rules).toEqual(SHIPPED);
    expect(onDisk()).toEqual(SHIPPED);
  });

  it("does not re-impose a default the user rebound", () => {
    /* THE MUTANT: append every shipped default unconditionally. The user moved the palette to ⌘P;
       ⌘K would come back next release and they would have two bindings for one thing, one of which
       they had deliberately removed. */
    const mine: Keybinding[] = [{ key: "mod+p", command: "palette.toggle" }, { key: "mod+t", command: "terminal.new" }];
    put(JSON.stringify(mine));
    expect(service().read().rules).toEqual(mine);
    expect(onDisk()).toEqual(mine);
  });

  it("does not put a default onto a key the user gave to something else", () => {
    // …and this is the case where re-imposing would actually WIN, because a merged default is
    // appended and the last matching rule wins.
    const mine: Keybinding[] = [{ key: "mod+t", command: "script.build.run" }];
    put(JSON.stringify(mine));
    const file = service().read();
    expect(commandForChord(file.rules, "mod+t", {})).toBe("script.build.run");
    expect(file.rules.some((r) => r.command === "terminal.new")).toBe(false);
  });

  it("keeps an unbind, which is how a user removes a default for good", () => {
    put(JSON.stringify([{ key: "mod+t", command: "" }]));
    const file = service().read();
    expect(commandForChord(file.rules, "mod+t", {})).toBeNull();
    expect(file.error).toBeNull();
  });

  it("keeps the user's rules in the order they wrote them, ahead of anything added", () => {
    // Position is precedence. A merge that sorted, or prepended, would re-rank overrides the user
    // had already tuned against each other.
    const mine: Keybinding[] = [{ key: "mod+k", command: "a", when: "!sheetOpen" }, { key: "mod+e", command: "b" }];
    put(JSON.stringify(mine));
    const file = service().read();
    expect(file.rules.slice(0, 2)).toEqual(mine);
    expect(file.rules[2]).toEqual({ key: "mod+t", command: "terminal.new" });
  });
});

describe("a file the user broke", () => {
  it("falls back to defaults, reports why, and does NOT overwrite the file", () => {
    /* THE MUTANT: let JSON.parse throw. `read()` is on the boot path, so a trailing comma in a file
       someone was editing would take the whole app down — and the app is where they would have gone
       to fix it. */
    put('[{ "key": "mod+k", "command": "palette.toggle" },]');
    const file = service().read();
    expect(file.rules).toEqual(SHIPPED);
    expect(file.error).toContain("not valid JSON");
    expect(readFileSync(keybindingsPath(home), "utf8")).toBe('[{ "key": "mod+k", "command": "palette.toggle" },]');
    expect(logs.join("\n")).toContain("keybindings");
  });

  it("refuses a top level that is not an array", () => {
    put(JSON.stringify({ "mod+k": "palette.toggle" }));
    const file = service().read();
    expect(file.rules).toEqual(SHIPPED);
    expect(file.error).toContain("not a JSON array");
  });

  it("drops one malformed rule and keeps the rest, naming the line", () => {
    put(JSON.stringify([{ key: "mod+k", command: "palette.toggle" }, { key: 7 }, { key: "mod+e", command: "b" }]));
    const file = service().read();
    expect(file.rules.map((r) => r.command)).toEqual(["palette.toggle", "b", "terminal.new"]);
    expect(file.error).toContain("rule 2");
  });

  it("names a key it cannot parse, and keeps the rule rather than deleting the user's line", () => {
    /* A key that will not parse can never fire. Saying so is the difference between a shortcut the
       user can fix and one they will press for a week wondering why nothing happens. */
    put(JSON.stringify([{ key: "mod+wat", command: "terminal.new" }]));
    const file = service().read();
    expect(file.error).toContain("mod+wat");
    expect(file.rules[0]).toEqual({ key: "mod+wat", command: "terminal.new" });
  });

  it("does not rewrite a file it only partly understood, even when the merge has something to add", () => {
    /* THE MUTANT: persist the merge whenever it grew. The write would drop the very entry we just
       complained about — so the release that happened to add a default would silently delete the
       user's typo instead of letting them find it. */
    const broken = JSON.stringify([{ key: "mod+k", command: "palette.toggle", when: "!sheetOpen" }, { nope: true }]);
    put(broken);
    const file = service().read();
    expect(file.rules.some((r) => r.command === "terminal.new")).toBe(true); // merged in memory
    expect(readFileSync(keybindingsPath(home), "utf8")).toBe(broken);        // and nowhere else
  });
});

describe("write and reset", () => {
  it("stores rules exactly as given — no sorting, no normalising, no dedupe", () => {
    /* THE MUTANT: canonicalise `key` on write. The file would never read back the way the user typed
       it, and a sort would re-rank the overrides whose whole meaning is their position. */
    const mine: Keybinding[] = [
      { key: "⌘⇧K", command: "b" },
      { key: "Cmd+T", command: "a" },
      { key: "⌘⇧K", command: "c" },
    ];
    const file = service().write(mine);
    expect(file.rules).toEqual(mine);
    expect(onDisk()).toEqual(mine);
    // …and the resolver still reads them, because normalising happens at match time.
    expect(commandForChord(file.rules, "mod+shift+k", {})).toBe("c");
  });

  it("reset discards the user's file for the shipped table", () => {
    service().write([{ key: "mod+q", command: "pane.close" }]);
    expect(service().reset().rules).toEqual(SHIPPED);
    expect(onDisk()).toEqual(SHIPPED);
  });

  it("writes a trailing newline, because the file is something a person opens in an editor", () => {
    service().write(SHIPPED);
    expect(readFileSync(keybindingsPath(home), "utf8").endsWith("\n")).toBe(true);
  });

  it("creates the home directory if a caller handed it one that does not exist yet", () => {
    const missing = `${tempDir("realm-keys-missing-")}/not-yet`;
    const s = new KeybindingsService({ home: missing, defaults: SHIPPED });
    expect(s.read().rules).toEqual(SHIPPED);
    expect(existsSync(keybindingsPath(missing))).toBe(true);
  });
});
