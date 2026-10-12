import { describe, expect, it } from "vitest";
import { advance, createRun, nextBest, offersRunner, parseBest, RUN, score, seededRandom, step, TICK, type Run, type Thing } from "./runner";

/** A run on bare ground with only the things a test puts there. */
function bare(things: Thing[] = []): Run {
  const run = createRun(1);
  run.things = things;
  run.laidTo = Infinity;
  return run;
}

const idle = { pressed: false, held: false };

/** Step in fixed ticks for `seconds`, pressing on the first tick if asked, holding throughout if asked. */
function play(run: Run, seconds: number, opts: { press?: boolean; hold?: boolean } = {}) {
  const events: string[] = [];
  let peak = run.y;
  for (let i = 0, n = Math.round(seconds / TICK); i < n; i++) {
    events.push(...step(run, { pressed: !!opts.press && i === 0, held: !!opts.hold }, TICK));
    peak = Math.max(peak, run.y);
  }
  return { events, peak };
}

describe("the world", () => {
  it("is laid the same from the same seed, and differently from another", () => {
    const a = createRun(42), b = createRun(42), c = createRun(43);
    expect(a.things).toEqual(b.things);
    expect(a.things).not.toEqual(c.things);
    const r = seededRandom(7), s = seededRandom(7);
    expect([r(), r(), r()]).toEqual([s(), s(), s()]);
  });

  it("leaves a runway clear of hazards at the start", () => {
    for (let seed = 0; seed < 50; seed++) {
      for (const t of createRun(seed).things) {
        if (t.kind !== "shard") expect(t.x).toBeGreaterThanOrEqual(RUN.runway);
      }
    }
  });
});

describe("jumping", () => {
  it("rises to v²/2g on a tap and lands again", () => {
    const run = bare();
    const { events, peak } = play(run, 1, { press: true });
    // Within the fixed tick's rounding of the parabola.
    expect(Math.abs(peak - RUN.jumpSpeed ** 2 / (2 * RUN.gravity))).toBeLessThan(1.5);
    expect(events.filter((e) => e === "jump")).toHaveLength(1);
    expect(events).toContain("land");
    expect(run.grounded).toBe(true);
  });

  it("goes higher while the key is held", () => {
    const tap = play(bare(), 1, { press: true }).peak;
    const held = play(bare(), 1, { press: true, hold: true }).peak;
    expect(held).toBeGreaterThan(tap * 1.6);
  });

  it("still jumps on landing for a press just before it", () => {
    const run = bare();
    play(run, 0.1, { press: true });
    // Fall until just above the ground, then press: the jump waits for the landing.
    while (run.y > 3 || run.vy > 0) step(run, idle, TICK);
    const { events } = play(run, 0.1, { press: true });
    expect(events).toEqual(expect.arrayContaining(["land", "jump"]));
  });

  it("runs the same at 60 and 144 frames a second", () => {
    const a = bare(), b = bare();
    for (let i = 0; i < 60; i++) advance(a, { pressed: i === 3, held: false }, 1 / 60);
    for (let i = 0; i < 144; i++) advance(b, { pressed: i === 7, held: false }, 1 / 144);
    expect(b.x).toBeCloseTo(a.x, 0);
    expect(b.y).toBeCloseTo(a.y, 0);
  });

  it("launches off a ramp's lip", () => {
    const run = bare([{ kind: "ramp", x: 20, len: 96, h: 30 }]);
    let launched = false;
    for (let i = 0; i < 240 && !launched; i++) {
      step(run, idle, TICK);
      launched = !run.grounded && run.vy > 0 && run.x > 116;
    }
    expect(launched).toBe(true);
  });
});

describe("collisions", () => {
  it("ends the run on a spike it runs into", () => {
    const run = bare([{ kind: "spike", x: 60 }]);
    const { events } = play(run, 1);
    expect(events).toContain("over");
    expect(run.over).toBe(true);
  });

  it("clears a spike it jumps", () => {
    const run = bare([{ kind: "spike", x: 60 }]);
    play(run, 0.1);
    play(run, 1, { press: true });
    expect(run.over).toBe(false);
    expect(run.x).toBeGreaterThan(100);
  });

  it("ends the run on a critter met on the ground", () => {
    const run = bare([{ kind: "critter", x: 80, alive: true, spin: 0 }]);
    expect(play(run, 1).events).toContain("over");
  });

  it("pops a critter landed on, scores it, and bounces", () => {
    const run = bare([{ kind: "critter", x: 110, alive: true, spin: 0 }]);
    const { events } = play(run, 1, { press: true });
    expect(events).toContain("pop");
    expect(run.over).toBe(false);
    expect(run.bonus).toBe(RUN.popPoints);
  });

  it("takes a shard once and scores it", () => {
    const run = bare([{ kind: "shard", x: 40, y: 12, taken: false }]);
    const { events } = play(run, 1);
    expect(events.filter((e) => e === "shard")).toHaveLength(1);
    expect(run.shards).toBe(1);
    expect(run.bonus).toBe(RUN.shardPoints);
  });

  it("stops at the end of a run", () => {
    const run = bare([{ kind: "spike", x: 30 }]);
    play(run, 1);
    const x = run.x;
    expect(play(run, 1).events).toEqual([]);
    expect(run.x).toBe(x);
  });
});

describe("speed and score", () => {
  it("speeds up by accel a second, up to the ceiling", () => {
    const run = bare();
    play(run, 10);
    expect(run.speed).toBeCloseTo(RUN.baseSpeed + 10 * RUN.accel, 3);
    play(run, 120);
    expect(run.speed).toBe(RUN.maxSpeed);
  });

  it("scores a point a stretch of distance, plus what was collected", () => {
    const run = bare();
    play(run, 2);
    expect(score(run)).toBe(Math.floor(run.distance / RUN.pxPerPoint));
    run.bonus = 30;
    expect(score(run)).toBe(Math.floor(run.distance / RUN.pxPerPoint) + 30);
  });
});

describe("best score", () => {
  it("keeps the higher of the two", () => {
    expect(nextBest(120, 80)).toBe(120);
    expect(nextBest(120, 200)).toBe(200);
  });

  it("reads anything unreadable as no score yet", () => {
    expect(parseBest(null)).toBe(0);
    expect(parseBest("nope")).toBe(0);
    expect(parseBest("-4")).toBe(0);
    expect(parseBest("312.7")).toBe(312);
  });
});

describe("which failed loads offer the runner", () => {
  it("offers it when the network is what is in the way", () => {
    expect(offersRunner("ERR_CONNECTION_REFUSED")).toBe(true);
    expect(offersRunner("ERR_INTERNET_DISCONNECTED")).toBe(true);
  });

  it("never on a certificate or security page, or another failure", () => {
    for (const name of ["ERR_CERT_AUTHORITY_INVALID", "ERR_CERT_DATE_INVALID", "ERR_SSL_PROTOCOL_ERROR", "ERR_NAME_NOT_RESOLVED", "ERR_BLOCKED_BY_CLIENT"]) {
      expect(offersRunner(name)).toBe(false);
    }
  });
});
