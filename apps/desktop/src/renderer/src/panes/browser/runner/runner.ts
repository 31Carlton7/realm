/**
 * The runner on a page that did not load: the rules, with no drawing and no clock of their own.
 *
 * A run is a plain object stepped forward by `step(run, input, dt)`. Everything that varies comes from
 * the run's seed, so the same seed and the same inputs make the same run — which is what lets the
 * suite hold a jump's height, a collision and the speed ramp to numbers.
 *
 * Units are the game's own pixels (the canvas draws one of them as a few device pixels), y points UP,
 * and the ground's flat surface is y = 0. The hero runs right; `x` is where it stands in the world.
 */

/** The world's constants. Exported so the drawing and the suite read the same numbers. */
export const RUN = {
  /** Running speed at the start, and its ceiling, in px/s; it climbs by `accel` px/s every second. */
  baseSpeed: 170,
  maxSpeed: 430,
  accel: 6,
  /** Downward pull, px/s², and what is left of it while a held jump is still rising. */
  gravity: 1700,
  holdGravity: 0.4,
  /** How long a held jump keeps the lighter pull. */
  holdMax: 0.32,
  /** Take-off speed, and the bounce off a popped critter. */
  jumpSpeed: 400,
  bounceSpeed: 330,
  /** A press this long before landing still jumps on landing; a press this long after running off
   *  an edge still jumps. */
  buffer: 0.12,
  coyote: 0.08,
  /** The hero is a ball of this radius standing on its lowest point. */
  radius: 10,
  spikeWidth: 16,
  spikeHeight: 13,
  critterRadius: 9,
  critterSpeed: 55,
  shardRadius: 6,
  /** Points: a stretch of distance, a shard, a critter. */
  pxPerPoint: 8,
  shardPoints: 10,
  popPoints: 50,
  /** Room before the first hazard, and how far ahead of the hero the world is laid. */
  runway: 520,
  lookahead: 1400,
} as const;

/** A seeded generator (Mulberry32): the same seed lays the same world. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Spike = { kind: "spike"; x: number };
export type Critter = { kind: "critter"; x: number; alive: boolean; spin: number };
export type Shard = { kind: "shard"; x: number; y: number; taken: boolean };
/** A wedge that rises as `h·u²` over `len` and drops straight down at its lip. */
export type Ramp = { kind: "ramp"; x: number; len: number; h: number };
export type Thing = Spike | Critter | Shard | Ramp;

export type RunEvent = "jump" | "shard" | "pop" | "over" | "land";

export type Run = {
  seed: number;
  rand: () => number;
  /** Seconds since the start. */
  t: number;
  x: number;
  y: number;
  vy: number;
  grounded: boolean;
  speed: number;
  /** Distance run: `x`, kept apart so the score never reads the world's coordinates. */
  distance: number;
  /** Time left on the held jump's lighter pull; 0 once released or spent. */
  hold: number;
  /** Time since a press that has not jumped yet, and since the hero last stood on something. */
  sincePress: number;
  sinceGround: number;
  shards: number;
  bonus: number;
  over: boolean;
  things: Thing[];
  /** Where the next stretch of world starts. */
  laidTo: number;
  /** The kind of the stretch laid last, so a ramp never follows a ramp. */
  lastPattern: string;
};

export type RunInput = {
  /** A jump key or pointer went down since the last step. */
  pressed: boolean;
  /** A jump key or pointer is down now. */
  held: boolean;
};

export function createRun(seed: number): Run {
  const run: Run = {
    seed, rand: seededRandom(seed), t: 0, x: 0, y: 0, vy: 0, grounded: true, speed: RUN.baseSpeed,
    distance: 0, hold: 0, sincePress: Infinity, sinceGround: 0, shards: 0, bonus: 0,
    over: false, things: [], laidTo: RUN.runway, lastPattern: "start",
  };
  layWorld(run);
  return run;
}

export const score = (run: Run): number => Math.floor(run.distance / RUN.pxPerPoint) + run.bonus;

/** The ground's height at `x`: flat, except along a ramp. */
export function groundAt(things: readonly Thing[], x: number): number {
  for (const t of things) {
    if (t.kind === "ramp" && x >= t.x && x < t.x + t.len) {
      const u = (x - t.x) / t.len;
      return t.h * u * u;
    }
  }
  return 0;
}

/** How long a stretch of hazards gives the hero to react, in seconds of running at the current speed. */
const gapFor = (run: Run) => run.speed * (0.75 + run.rand() * 0.7);

/** Lay the world out ahead of the hero, one pattern at a time, and drop what it has run past. */
function layWorld(run: Run) {
  while (run.laidTo < run.x + RUN.lookahead) {
    const at = run.laidTo;
    const r = run.rand();
    let pattern: string;
    if (run.distance > 900 && run.lastPattern !== "ramp" && r < 0.22) pattern = "ramp";
    else if (r < 0.5) pattern = "spikes";
    else if (r < 0.75) pattern = "critter";
    else pattern = "shards";
    let len = 0;
    switch (pattern) {
      case "spikes": {
        // One spike early on, up to three once the run is under way: a row the plain jump still clears.
        const n = 1 + Math.floor(run.rand() * (run.distance > 1500 ? 3 : 1.6));
        for (let i = 0; i < n; i++) run.things.push({ kind: "spike", x: at + i * RUN.spikeWidth });
        // A shard over the row says "jump here", and pays for it.
        run.things.push({ kind: "shard", x: at + (n * RUN.spikeWidth) / 2, y: 56, taken: false });
        len = n * RUN.spikeWidth;
        break;
      }
      case "critter":
        run.things.push({ kind: "critter", x: at + 40, alive: true, spin: 0 });
        len = 40;
        break;
      case "shards": {
        const high = run.rand() < 0.5;
        for (let i = 0; i < 5; i++) {
          const y = high ? 30 + Math.sin((i / 4) * Math.PI) * 44 : 12;
          run.things.push({ kind: "shard", x: at + i * 22, y, taken: false });
        }
        len = 88;
        break;
      }
      case "ramp": {
        const ramp: Ramp = { kind: "ramp", x: at, len: 96, h: 30 };
        run.things.push(ramp);
        // A trail of shards along the flight off the lip, and clear ground to land on.
        for (let i = 1; i <= 4; i++) run.things.push({ kind: "shard", x: at + ramp.len + i * 26, y: 44 + i * 6, taken: false });
        len = ramp.len + 200;
        break;
      }
    }
    run.lastPattern = pattern;
    run.laidTo = at + len + gapFor(run);
  }
  run.things = run.things.filter((t) => thingEnd(t) > run.x - 400);
}

function thingEnd(t: Thing): number {
  switch (t.kind) {
    case "ramp": return t.x + t.len;
    default: return t.x + 20;
  }
}

/** The hero's centre: it is a ball standing on its lowest point. */
export const heroCentre = (run: Run) => ({ x: run.x, y: run.y + RUN.radius });

/** Advance the run by `dt` seconds. Returns what happened, for sound and the drawing's flourishes. */
export function step(run: Run, input: RunInput, dt: number): RunEvent[] {
  const events: RunEvent[] = [];
  if (run.over) return events;
  run.t += dt;
  run.speed = Math.min(RUN.maxSpeed, run.speed + RUN.accel * dt);
  run.sincePress = input.pressed ? 0 : run.sincePress + dt;
  if (!input.held) run.hold = 0;

  const nextX = run.x + run.speed * dt;
  run.distance += nextX - run.x;
  if (run.grounded) {
    const g = groundAt(run.things, nextX);
    if (g < run.y - 0.5) {
      // The ground fell away (a ramp's lip): carry on at the slope's speed, now in the air.
      run.grounded = false;
    } else {
      run.vy = (g - run.y) / dt;
      run.y = g;
    }
  }
  run.x = nextX;
  if (run.grounded) run.sinceGround = 0;
  else run.sinceGround += dt;

  const canJump = run.grounded || run.sinceGround < RUN.coyote;
  if (run.sincePress < RUN.buffer && canJump) {
    run.vy = Math.max(run.vy, 0) + RUN.jumpSpeed;
    run.grounded = false;
    run.sinceGround = RUN.coyote;
    run.hold = input.held ? RUN.holdMax : 0;
    run.sincePress = Infinity;
    events.push("jump");
  }

  if (!run.grounded) {
    const lighter = run.hold > 0 && run.vy > 0;
    run.vy -= RUN.gravity * (lighter ? RUN.holdGravity : 1) * dt;
    run.hold = Math.max(0, run.hold - dt);
    run.y += run.vy * dt;
    const g = groundAt(run.things, run.x);
    if (run.y <= g && run.vy <= 0) {
      run.y = g;
      run.vy = 0;
      run.grounded = true;
      run.hold = 0;
      events.push("land");
    }
  }

  collide(run, events);
  for (const t of run.things) {
    if (t.kind === "critter" && t.alive) { t.x -= RUN.critterSpeed * dt; t.spin += RUN.critterSpeed * dt / RUN.critterRadius; }
  }
  layWorld(run);
  return events;
}

function collide(run: Run, events: RunEvent[]) {
  const c = heroCentre(run);
  const R = RUN.radius;
  for (const t of run.things) {
    if (t.kind === "shard" && !t.taken) {
      if (Math.hypot(t.x - c.x, t.y - c.y) < R + RUN.shardRadius) {
        t.taken = true;
        run.shards += 1;
        run.bonus += RUN.shardPoints;
        events.push("shard");
      }
    } else if (t.kind === "critter" && t.alive) {
      const cy = RUN.critterRadius;
      if (Math.hypot(t.x - c.x, cy - c.y) < R + RUN.critterRadius - 2) {
        if (!run.grounded && c.y > cy + 2) {
          // Curled into a ball in the air and over it: the critter pops, and one landed on bounces.
          t.alive = false;
          run.bonus += RUN.popPoints;
          if (run.vy < 0) run.vy = RUN.bounceSpeed;
          run.hold = 0;
          events.push("pop");
        } else {
          end(run, events);
        }
      }
    } else if (t.kind === "spike") {
      // The spike's box, a little forgiving at its tip: a ball that clears the point clears the spike.
      const left = t.x + 2, right = t.x + RUN.spikeWidth - 2, top = RUN.spikeHeight - 3;
      const nx = Math.max(left, Math.min(c.x, right));
      const ny = Math.max(0, Math.min(c.y, top));
      if (Math.hypot(nx - c.x, ny - c.y) < R - 1) end(run, events);
    }
    if (run.over) return;
  }
}

/** Any hit ends the run, as it does for the desert runner every browser keeps behind its own error page. */
function end(run: Run, events: RunEvent[]) {
  run.over = true;
  events.push("over");
}

/** The fixed step the loop advances the rules by, whatever the display's frame rate. */
export const TICK = 1 / 240;

/** Advance by a frame's worth of time in fixed ticks. A press counts on the first tick only. */
export function advance(run: Run, input: RunInput, frameDt: number): RunEvent[] {
  const events: RunEvent[] = [];
  const dt = Math.min(frameDt, 0.1);
  let pressed = input.pressed;
  for (let left = dt; left > 1e-9 && !run.over; left -= TICK) {
    events.push(...step(run, { pressed, held: input.held }, Math.min(TICK, left)));
    pressed = false;
  }
  return events;
}

/** The best score kept, from whatever storage held it; anything unreadable is no score yet. */
export function parseBest(raw: string | null): number {
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Keep the higher of a finished run's score and the best so far. */
export const nextBest = (best: number, finished: number): number => Math.max(best, finished);

/**
 * Whether a failed load offers the runner: only when the network is the thing in the way — a local
 * server that is not up yet, or no connection at all. Never on a certificate or security page, where
 * the page's one job is to say why Realm stopped, and a game beside it would make light of that.
 */
export function offersRunner(errorName: string): boolean {
  return errorName === "ERR_CONNECTION_REFUSED" || errorName === "ERR_INTERNET_DISCONNECTED";
}
