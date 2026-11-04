import { describe, expect, it } from "vitest";
import { DEFAULT_TURN, TurnTaker, type TurnEvent } from "./turn-taking";

const FRAME = 20;
const QUIET = 0.002;
const VOICE = 0.08;

/** Runs `ms` of frames at one level, from `t`, collecting what the machine said. */
function run(tt: TurnTaker, from: number, ms: number, level: number, talking = false, muted = false): { t: number; events: TurnEvent[] } {
  const events: TurnEvent[] = [];
  let t = from;
  for (; t < from + ms; t += FRAME) events.push(...tt.frame(level, t, { talking, muted }));
  return { t, events };
}

describe("TurnTaker, hands-free", () => {
  it("starts a turn once speech has held for the onset, and ends it after the pause", () => {
    const tt = new TurnTaker();
    let { t, events } = run(tt, 0, 400, QUIET);
    expect(events).toEqual([]);
    ({ t, events } = run(tt, t, 300, VOICE));
    expect(events).toEqual([{ type: "start", barge: false }]);
    // A pause shorter than the end-of-turn is a breath inside the turn.
    ({ t, events } = run(tt, t, DEFAULT_TURN.endOfTurnMs - 200, QUIET));
    expect(events).toEqual([]);
    ({ t, events } = run(tt, t, 200, VOICE));
    expect(events).toEqual([]);
    // THE MUTANT: end the turn on the first quiet frame. Every breath would send half a sentence.
    ({ events } = run(tt, t, DEFAULT_TURN.endOfTurnMs + FRAME * 2, QUIET));
    expect(events).toEqual([{ type: "end" }]);
  });

  it("takes the end-of-turn pause it is configured with", () => {
    const tt = new TurnTaker({ ...DEFAULT_TURN, endOfTurnMs: 1500 });
    let { t } = run(tt, 0, 300, QUIET);
    ({ t } = run(tt, t, 300, VOICE));
    // THE MUTANT: a fixed 700 ms. A person who set a longer pause is cut off mid-thought.
    expect(run(tt, t, 1000, QUIET).events).toEqual([]);
    expect(run(tt, t + 1000, 600, QUIET).events).toEqual([{ type: "end" }]);
  });

  it("does not take a click for speech", () => {
    const tt = new TurnTaker();
    const { t } = run(tt, 0, 300, QUIET);
    // Under the onset: one 60 ms burst.
    expect(run(tt, t, DEFAULT_TURN.onsetMs - 60, VOICE).events).toEqual([]);
    expect(run(tt, t + 100, 200, QUIET).events).toEqual([]);
  });

  it("follows the room's noise, so a steady hum is not a turn", () => {
    const tt = new TurnTaker();
    // A fan at 0.02, already running when voice mode opened, is louder than the absolute floor.
    // THE MUTANT: no warm-up — the fan is the first turn, and it never ends.
    expect(run(tt, 0, 10_000, 0.02).events).toEqual([]);
    expect(run(tt, 10_000, 2000, 0.02).events).toEqual([]);
    // And speech well above the hum still starts one.
    expect(run(tt, 12_000, 400, 0.2).events).toEqual([{ type: "start", barge: false }]);
  });

  it("needs more, for longer, to start a turn over Realm talking — and says it is a barge-in", () => {
    const tt = new TurnTaker();
    const { t } = run(tt, 0, 400, QUIET);
    // Echo residue a little above the room: enough to start a turn in silence, not over Realm.
    expect(run(tt, t, 1000, 0.012, true).events).toEqual([]);
    // Speech for less than the barge onset: still nothing.
    expect(run(tt, t + 1000, DEFAULT_TURN.bargeOnsetMs - 80, VOICE, true).events).toEqual([]);
    run(tt, t + 1200, 200, QUIET, true);
    // THE MUTANT: the same onset whether Realm is talking or not — a cough cuts Realm off.
    const loud = run(tt, t + 1400, DEFAULT_TURN.bargeOnsetMs + 60, VOICE, true);
    expect(loud.events).toEqual([{ type: "start", barge: true }]);
  });

  it("ends a turn that a noise starting mid-turn would otherwise hold open", () => {
    const tt = new TurnTaker();
    run(tt, 0, 400, QUIET);
    expect(run(tt, 400, 300, VOICE).events).toEqual([{ type: "start", barge: false }]);
    // A fan comes on as the person stops talking. THE MUTANT: the floor frozen during a turn.
    expect(run(tt, 700, 15_000, 0.03).events).toEqual([{ type: "end" }]);
  });

  it("starts nothing while muted, and drops a turn that was going when it was muted", () => {
    const tt = new TurnTaker();
    run(tt, 0, 400, QUIET);
    expect(run(tt, 400, 400, VOICE, false, true).events).toEqual([]);
    run(tt, 800, 300, QUIET);
    expect(run(tt, 1100, 300, VOICE).events).toEqual([{ type: "start", barge: false }]);
    // THE MUTANT: mute ends the turn — what was said is sent the moment the person reached for mute.
    expect(run(tt, 1400, 40, VOICE, false, true).events).toEqual([{ type: "cancel" }]);
  });
});

describe("TurnTaker, push-to-talk", () => {
  it("starts at the press and ends at the release, whatever the level says in between", () => {
    const tt = new TurnTaker();
    expect(tt.press(false)).toEqual([{ type: "start", barge: false }]);
    // THE MUTANT: the VAD's pause still ends a held turn. Holding the key through a long think
    // would send at the first silence.
    expect(run(tt, 0, 3000, QUIET).events).toEqual([]);
    expect(tt.release()).toEqual([{ type: "end" }]);
    expect(tt.release()).toEqual([]);
  });

  it("works while muted — the fallback for a noisy room", () => {
    const tt = new TurnTaker();
    run(tt, 0, 200, VOICE, false, true);
    expect(tt.press(false)).toEqual([{ type: "start", barge: false }]);
    expect(run(tt, 200, 400, VOICE, false, true).events).toEqual([]);
    expect(tt.release()).toEqual([{ type: "end" }]);
  });

  it("takes over a hands-free turn already going, and ends it at the release", () => {
    const tt = new TurnTaker();
    run(tt, 0, 300, QUIET);
    expect(run(tt, 300, 300, VOICE).events).toEqual([{ type: "start", barge: false }]);
    expect(tt.press(false)).toEqual([]);
    expect(tt.release()).toEqual([{ type: "end" }]);
  });
});
