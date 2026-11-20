import { beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { GlobalKeysEvent, GlobalKeysState } from "@realm/contracts";
import { tempDir } from "@realm/test-utils";
import { CHORD_KEY_CODES, parseKeysLine, RealmKeys } from "./realm-keys";

describe("the RealmKeys helper's lines", () => {
  it("reads ready, a double-tap, a chord's key code and the held key, and nothing else", () => {
    expect(parseKeysLine('{"ready":true,"active":true}')).toEqual({ ready: true, active: true });
    expect(parseKeysLine('{"ready":true,"active":false}')).toEqual({ ready: true, active: false });
    expect(parseKeysLine('{"t":"doubleTap"}')).toEqual({ t: "doubleTap" });
    expect(parseKeysLine('{"t":"chord","code":37}')).toEqual({ t: "chord", code: 37 });
    expect(parseKeysLine('{"t":"hold","down":true}')).toEqual({ t: "hold", down: true });
    for (const bad of ['{"ready":true}', '{"t":"chord","code":"L"}', '{"t":"chord","code":1.5}', '{"t":"hold","down":1}', '{"t":"key","code":37}', "{}", "not json", ""]) {
      expect(parseKeysLine(bad)).toBeNull();
    }
  });
});

/** A helper that never runs: what main wrote to it, and a way to make it speak or exit. */
function fakeHelper() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & { stdout: PassThrough; written: string[] };
  const written: string[] = [];
  const stdin = new PassThrough();
  stdin.on("data", (d: Buffer) => written.push(...d.toString().split("\n").filter(Boolean)));
  Object.assign(child, { stdin, stdout: new PassThrough(), stderr: new PassThrough(), written });
  child.kill = vi.fn(() => true);
  return child;
}

function setup() {
  const helpers: ReturnType<typeof fakeHelper>[] = [];
  const doubleTaps = vi.fn();
  const watched: GlobalKeysEvent[] = [];
  const states: GlobalKeysState[] = [];
  const keys = new RealmKeys({
    start: () => { helpers.push(fakeHelper()); return helpers.at(-1)!; },
    onDoubleTap: doubleTaps,
    onWatched: (event) => watched.push(event),
    onState: (state) => states.push(state),
  });
  const lastConfig = () => JSON.parse(helpers.at(-1)!.written.at(-1)!);
  const says = (line: string) => helpers.at(-1)!.stdout.write(`${line}\n`);
  return { keys, helpers, doubleTaps, watched, states, lastConfig, says };
}

describe("RealmKeys", () => {
  it("does not start the helper until something needs it, and ends it when nothing does", () => {
    const { keys, helpers, states } = setup();
    keys.setHoldKey("rightOption");
    expect(helpers).toHaveLength(0);
    expect(keys.state).toBe("off");

    keys.setDoubleTap(true);
    expect(helpers).toHaveLength(1);
    expect(keys.state).toBe("starting");

    keys.setDoubleTap(false);
    expect(helpers[0]!.kill).toHaveBeenCalled();
    expect(helpers[0]!.stdin.writableEnded).toBe(true);
    expect(states).toEqual(["starting", "off"]);
  });

  it("runs for a registered chord or a watching page alone, and stops when the last reason goes", () => {
    const { keys, helpers } = setup();
    const giveBack = keys.registerChord("L", () => {});
    expect(helpers).toHaveLength(1);
    keys.setWatchers(1);
    giveBack();
    expect(helpers[0]!.kill).not.toHaveBeenCalled();
    keys.setWatchers(0);
    expect(helpers[0]!.kill).toHaveBeenCalled();
    expect(keys.state).toBe("off");
  });

  it("sends the timings, the held key and only the chords somebody registered", () => {
    const { keys, lastConfig } = setup();
    keys.setDoubleTap(true);
    expect(lastConfig()).toEqual({ doubleTap: true, maxHold: 0.25, maxGap: 0.3, hold: "fn", chords: [], reportHold: false });

    keys.setHoldKey("rightCommand");
    const giveBack = keys.registerChord("L", () => {});
    keys.registerChord("Space", () => {});
    expect(lastConfig()).toMatchObject({ hold: "rightCommand", chords: [CHORD_KEY_CODES.L, CHORD_KEY_CODES.Space] });

    giveBack();
    expect(lastConfig().chords).toEqual([CHORD_KEY_CODES.Space]);
  });

  it("says which tap the helper got", () => {
    const { keys, says } = setup();
    keys.setDoubleTap(true);
    says('{"ready":true,"active":false}');
    expect(keys.state).toBe("listening");
    says('{"ready":true,"active":true}');
    expect(keys.state).toBe("active");
  });

  it("opens the quick chat on a double-tap only while the setting is on", () => {
    const { keys, says, doubleTaps, watched, lastConfig } = setup();
    keys.setWatchers(1);
    // The helper reports it for the watching page; the setting is what acts on it.
    expect(lastConfig()).toMatchObject({ doubleTap: true, reportHold: true });
    says('{"t":"doubleTap"}');
    expect(doubleTaps).not.toHaveBeenCalled();
    expect(watched).toEqual([{ t: "doubleTap" }]);

    keys.setDoubleTap(true);
    says('{"t":"doubleTap"}');
    expect(doubleTaps).toHaveBeenCalledTimes(1);
  });

  it("tells a watching page about the held key, and nobody when no page watches", () => {
    const { keys, says, watched } = setup();
    keys.setDoubleTap(true);
    says('{"t":"hold","down":true}');
    says('{"t":"doubleTap"}');
    expect(watched).toEqual([]);
    keys.setWatchers(1);
    says('{"t":"hold","down":true}');
    says('{"t":"hold","down":false}');
    expect(watched).toEqual([{ t: "hold", down: true }, { t: "hold", down: false }]);
  });

  it("runs a chord's own handler by its key code, split across reads", () => {
    const { keys, helpers } = setup();
    const onL = vi.fn();
    const onSpace = vi.fn();
    keys.registerChord("L", onL);
    keys.registerChord("Space", onSpace);
    helpers[0]!.stdout.write('{"t":"chord","co');
    helpers[0]!.stdout.write('de":37}\n{"t":"chord","code":5}\n');
    expect(onL).toHaveBeenCalledTimes(1);
    expect(onSpace).not.toHaveBeenCalled();
  });

  it("reports a helper macOS refused as denied, and does not start it again on its own", () => {
    const { keys, helpers } = setup();
    keys.setDoubleTap(true);
    helpers[0]!.emit("exit", 2);
    expect(keys.state).toBe("denied");
    expect(helpers).toHaveLength(1);

    keys.recheck();
    expect(helpers).toHaveLength(2);
    expect(keys.state).toBe("starting");
  });

  it("recheck restarts a helper that is only listening, and leaves one that swallows alone", () => {
    const { keys, helpers, says } = setup();
    keys.setDoubleTap(true);
    says('{"ready":true,"active":false}');
    keys.recheck();
    expect(helpers).toHaveLength(2);
    expect(helpers[0]!.kill).toHaveBeenCalled();

    says('{"ready":true,"active":true}');
    keys.recheck();
    expect(helpers).toHaveLength(2);
  });

  it("ignores a helper it has already replaced", () => {
    const { keys, helpers, doubleTaps } = setup();
    keys.setDoubleTap(true);
    helpers[0]!.stdout.write('{"ready":true,"active":false}\n');
    keys.recheck();
    helpers[0]!.stdout.write('{"t":"doubleTap"}\n');
    helpers[0]!.emit("exit", 0);
    expect(doubleTaps).not.toHaveBeenCalled();
    expect(keys.state).toBe("starting");
  });

  it("is missing where there is no helper, or it cannot be spawned", () => {
    const states: GlobalKeysState[] = [];
    const none = new RealmKeys({ start: () => null, onDoubleTap: () => {}, onWatched: () => {}, onState: (s) => states.push(s) });
    none.setDoubleTap(true);
    expect(none.state).toBe("missing");

    const { keys, helpers } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    keys.setDoubleTap(true);
    helpers[0]!.emit("error", new Error("spawn ENOENT"));
    expect(keys.state).toBe("missing");
    warn.mockRestore();
  });
});

// Modifier flags as a tap reads them: the side-less mask, and which side (IOKit's device bits).
const NONE = 0x100;
const LEFT_COMMAND = 0x100008;
const RIGHT_COMMAND = 0x100010;
const SHIFT = 0x20002;
const LEFT_OPTION = 0x80020;
const RIGHT_OPTION = 0x80040;
const FN = 0x800000;
const KEY = { leftCommand: 55, rightCommand: 54, shift: 56, leftOption: 58, rightOption: 61, fn: 63, c: 8, tab: 48, l: 37, j: 38, rightArrow: 124 };

const swiftc = process.platform === "darwin" && spawnSync("xcrun", ["-f", "swiftc"]).status === 0;

/**
 * The helper's own decisions, asked of the Swift that ships: `realmkeys decide` runs the tap's
 * decider on a script of events and makes no tap. Built here from the source, so a stale binary in
 * native/bin cannot answer for it.
 */
describe.runIf(swiftc)("what the helper decides", () => {
  let bin: string;
  beforeAll(() => {
    bin = join(tempDir("realmkeys-test-"), "realmkeys");
    execFileSync("swiftc", ["-o", bin, join(__dirname, "../../native/RealmKeys.swift")], { stdio: "inherit" });
  }, 120_000);

  type Decision = { swallow: boolean; out: { t: string; code?: number; down?: boolean }[] };
  const config = (over: object = {}) => JSON.stringify({ doubleTap: true, maxHold: 0.25, maxGap: 0.3, hold: "fn", chords: [], reportHold: false, ...over });
  /** Every event's decision, in order. Config lines print nothing. */
  const decide = (lines: string[]): Decision[] =>
    execFileSync(bin, ["decide"], { input: `${lines.join("\n")}\n`, encoding: "utf8" }).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const doubleTaps = (events: string[], over: object = {}) =>
    decide([config(over), ...events]).filter((d) => d.out.some((o) => o.t === "doubleTap")).length;

  /** A Command key down at `t` and up `held` later. */
  const tap = (t: number, key = KEY.leftCommand, held = 0.06) => [
    `flags ${t} ${key} ${key === KEY.leftCommand ? LEFT_COMMAND : RIGHT_COMMAND}`,
    `flags ${(t + held).toFixed(3)} ${key} ${NONE}`,
  ];
  /** Command held round one other key: Command-C, Command-Tab. */
  const shortcut = (t: number, key: number) => [
    `flags ${t} ${KEY.leftCommand} ${LEFT_COMMAND}`, `down ${t + 0.04} ${key} ${LEFT_COMMAND}`, `up ${t + 0.05} ${key} ${LEFT_COMMAND}`,
    `flags ${t + 0.08} ${KEY.leftCommand} ${NONE}`,
  ];

  describe("a double-tap of Command", () => {
    it("fires on the second release, for either key", () => {
      const twice = decide([config(), ...tap(0), ...tap(0.18)]);
      expect(twice.map((d) => d.out.length)).toEqual([0, 0, 0, 1]);
      expect(twice[3]).toEqual({ swallow: false, out: [{ t: "doubleTap" }] });
      expect(doubleTaps([...tap(0), ...tap(0.18, KEY.rightCommand)])).toBe(1);
    });

    it("fires once for three taps", () => {
      expect(doubleTaps([...tap(0), ...tap(0.18), ...tap(0.36)])).toBe(1);
    });

    it("does not fire around a shortcut", () => {
      expect(doubleTaps([...shortcut(0, KEY.c), ...tap(0.2)])).toBe(0);
      expect(doubleTaps([...tap(0), ...shortcut(0.18, KEY.c)])).toBe(0);
      expect(doubleTaps([...shortcut(0, KEY.tab), ...shortcut(0.2, KEY.tab)])).toBe(0);
    });

    it("does not fire when either press is a hold", () => {
      expect(doubleTaps([...tap(0, KEY.leftCommand, 0.6), ...tap(0.72)])).toBe(0);
      expect(doubleTaps([...tap(0), ...tap(0.18, KEY.leftCommand, 0.6)])).toBe(0);
    });

    it("holds the two timings at their edges", () => {
      // Released at 0.06: a second press 0.30 later counts, 0.31 later does not.
      expect(doubleTaps([...tap(0), ...tap(0.36)])).toBe(1);
      expect(doubleTaps([...tap(0), ...tap(0.37)])).toBe(0);
      expect(doubleTaps([...tap(0), ...tap(0.56)])).toBe(0);
      expect(doubleTaps([...tap(0, KEY.leftCommand, 0.25), ...tap(0.4, KEY.leftCommand, 0.25)])).toBe(1);
      expect(doubleTaps([...tap(0, KEY.leftCommand, 0.26), ...tap(0.4)])).toBe(0);
    });

    it("takes its timings from main", () => {
      expect(doubleTaps([...tap(0), ...tap(0.56)], { maxGap: 0.5 })).toBe(1);
      expect(doubleTaps([...tap(0, KEY.leftCommand, 0.2), ...tap(0.3)], { maxHold: 0.1 })).toBe(0);
    });

    it("does not fire with another modifier in it", () => {
      const commandShift = [
        `flags 0 ${KEY.leftCommand} ${LEFT_COMMAND}`, `flags 0.02 ${KEY.shift} ${LEFT_COMMAND | SHIFT}`,
        `flags 0.04 ${KEY.shift} ${LEFT_COMMAND}`, `flags 0.06 ${KEY.leftCommand} ${NONE}`,
      ];
      expect(doubleTaps([...commandShift, ...tap(0.18)])).toBe(0);
      const bothCommands = [
        `flags 0 ${KEY.leftCommand} ${LEFT_COMMAND}`, `flags 0.03 ${KEY.rightCommand} ${LEFT_COMMAND | RIGHT_COMMAND}`,
        `flags 0.06 ${KEY.rightCommand} ${LEFT_COMMAND}`, `flags 0.09 ${KEY.leftCommand} ${NONE}`,
      ];
      expect(doubleTaps(bothCommands)).toBe(0);
    });

    it("does not fire across a click or a scroll: Command-click, Command-scroll", () => {
      const during = [`flags 0 ${KEY.leftCommand} ${LEFT_COMMAND}`, "pointer 0.03", `flags 0.06 ${KEY.leftCommand} ${NONE}`];
      expect(doubleTaps([...during, ...tap(0.18)])).toBe(0);
      expect(doubleTaps([...tap(0), "pointer 0.1", ...tap(0.18)])).toBe(0);
      expect(doubleTaps([...tap(0), `flags 0.18 ${KEY.leftCommand} ${LEFT_COMMAND}`, "pointer 0.2", `flags 0.24 ${KEY.leftCommand} ${NONE}`])).toBe(0);
    });

    it("is not reported while main has it off", () => {
      expect(doubleTaps([...tap(0), ...tap(0.18)], { doubleTap: false })).toBe(0);
    });

    it("is never swallowed", () => {
      expect(decide([config(), ...tap(0), ...tap(0.18)]).some((d) => d.swallow)).toBe(false);
    });
  });

  describe("a chord on the held key", () => {
    const fnDown = `flags 0 ${KEY.fn} ${FN}`;
    const fnUp = (t: number) => `flags ${t} ${KEY.fn} ${NONE}`;

    it("swallows nothing when no chord is registered", () => {
      const all = decide([config(), fnDown, `down 0.1 ${KEY.l} ${FN}`, `up 0.2 ${KEY.l} ${FN}`, fnUp(0.3)]);
      expect(all).toEqual(Array(4).fill({ swallow: false, out: [] }));
    });

    it("swallows a registered key's down and up, and reports it once", () => {
      const all = decide([config({ chords: [KEY.l] }), fnDown, `down 0.1 ${KEY.l} ${FN}`, `down 0.2 ${KEY.l} ${FN} repeat`, `up 0.3 ${KEY.l} ${FN}`, fnUp(0.4)]);
      expect(all).toEqual([
        { swallow: false, out: [] },
        { swallow: true, out: [{ t: "chord", code: KEY.l }] },
        { swallow: true, out: [] },
        { swallow: true, out: [] },
        { swallow: false, out: [] },
      ]);
    });

    it("passes an unregistered key pressed with the held key", () => {
      const all = decide([config({ chords: [KEY.l] }), fnDown, `down 0.1 ${KEY.j} ${FN}`, `up 0.2 ${KEY.j} ${FN}`]);
      expect(all.slice(1)).toEqual([{ swallow: false, out: [] }, { swallow: false, out: [] }]);
    });

    it("passes a registered key typed without the held key", () => {
      const all = decide([config({ chords: [KEY.l] }), `down 0 ${KEY.l} ${NONE}`, `up 0.1 ${KEY.l} ${NONE}`]);
      expect(all).toEqual([{ swallow: false, out: [] }, { swallow: false, out: [] }]);
    });

    it("goes by Fn's own key, not the Fn flag an arrow carries", () => {
      const all = decide([config({ chords: [KEY.rightArrow, KEY.l] }), `down 0 ${KEY.rightArrow} ${FN}`, `down 0.1 ${KEY.l} ${FN}`]);
      expect(all).toEqual([{ swallow: false, out: [] }, { swallow: false, out: [] }]);
    });

    it("passes a registered key when another modifier is held too", () => {
      const all = decide([config({ chords: [KEY.l] }), fnDown, `down 0.1 ${KEY.l} ${FN | SHIFT}`, `down 0.2 ${KEY.l} ${FN | LEFT_COMMAND}`]);
      expect(all.slice(1)).toEqual([{ swallow: false, out: [] }, { swallow: false, out: [] }]);
    });

    it("swallows the up of a key whose down it swallowed, after the held key lifts", () => {
      const all = decide([config({ chords: [KEY.l] }), fnDown, `down 0.1 ${KEY.l} ${FN}`, fnUp(0.2), `up 0.3 ${KEY.l} ${NONE}`, `down 0.4 ${KEY.l} ${NONE}`]);
      expect(all.map((d) => d.swallow)).toEqual([false, true, false, true, false]);
    });

    it("passes a registered key typed alone after a release it never saw", () => {
      const all = decide([config({ chords: [KEY.l] }), fnDown, `down 0.5 ${KEY.l} ${NONE}`]);
      expect(all[1]).toEqual({ swallow: false, out: [] });
    });

    it("uses Right Option or Right Command when chosen, and never the left one", () => {
      const rightOption = decide([config({ hold: "rightOption", chords: [KEY.l] }),
        `flags 0 ${KEY.rightOption} ${RIGHT_OPTION}`, `down 0.1 ${KEY.l} ${RIGHT_OPTION}`, `up 0.2 ${KEY.l} ${RIGHT_OPTION}`, `flags 0.3 ${KEY.rightOption} ${NONE}`,
        `flags 1 ${KEY.leftOption} ${LEFT_OPTION}`, `down 1.1 ${KEY.l} ${LEFT_OPTION}`,
        fnDown, `down 2 ${KEY.l} ${FN}`]);
      expect(rightOption.map((d) => d.swallow)).toEqual([false, true, true, false, false, false, false, false]);

      const rightCommand = decide([config({ hold: "rightCommand", chords: [KEY.l] }),
        `flags 0 ${KEY.rightCommand} ${RIGHT_COMMAND}`, `down 0.1 ${KEY.l} ${RIGHT_COMMAND}`, `up 0.2 ${KEY.l} ${RIGHT_COMMAND}`, `flags 0.3 ${KEY.rightCommand} ${NONE}`,
        `flags 1 ${KEY.leftCommand} ${LEFT_COMMAND}`, `down 1.1 ${KEY.l} ${LEFT_COMMAND}`]);
      expect(rightCommand.map((d) => d.swallow)).toEqual([false, true, true, false, false, false]);
    });

    it("passes the right key held with its left twin", () => {
      const all = decide([config({ hold: "rightOption", chords: [KEY.l] }),
        `flags 0 ${KEY.leftOption} ${LEFT_OPTION}`, `flags 0.1 ${KEY.rightOption} ${LEFT_OPTION | RIGHT_OPTION}`, `down 0.2 ${KEY.l} ${LEFT_OPTION | RIGHT_OPTION}`]);
      expect(all[2]).toEqual({ swallow: false, out: [] });
    });

    it("says when the held key goes down and up only while a page watches, and never swallows it", () => {
      const quiet = decide([config(), fnDown, fnUp(0.2)]);
      expect(quiet).toEqual([{ swallow: false, out: [] }, { swallow: false, out: [] }]);
      const watching = decide([config({ reportHold: true }), fnDown, fnUp(0.2), `flags 0.3 ${KEY.rightOption} ${RIGHT_OPTION}`]);
      expect(watching).toEqual([
        { swallow: false, out: [{ t: "hold", down: true }] },
        { swallow: false, out: [{ t: "hold", down: false }] },
        { swallow: false, out: [] },
      ]);
    });
  });

  it("reports and swallows nothing before main has sent a config", () => {
    const all = decide([...tap(0), ...tap(0.18), `flags 1 ${KEY.fn} ${FN}`, `down 1.1 ${KEY.l} ${FN}`]);
    expect(all).toEqual(Array(6).fill({ swallow: false, out: [] }));
  });

  it("keeps the last good config when a line is not one", () => {
    const all = decide([config({ chords: [KEY.l] }), '{"hold":"capsLock","chords":[38]}', `flags 0 ${KEY.fn} ${FN}`, `down 0.1 ${KEY.l} ${FN}`]);
    expect(all).toEqual([{ error: "config" }, { swallow: false, out: [] }, { swallow: true, out: [{ t: "chord", code: KEY.l }] }]);
  });
});
