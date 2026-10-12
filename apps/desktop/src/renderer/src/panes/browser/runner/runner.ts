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
  holdGravity: 0.3,
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
  loopRadius: 46,
  /** How far the exit of a loop sits past its entry, so the track does not run back over itself. */
  loopShift: 70,
  /** After a hit that cost shards: how long nothing else can hurt, and what is left of the speed. */
  mercy: 1.4,
  hitSlow: 0.7,
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
/** A loop the hero runs round on its own at any speed. Entry at `x`, exit at `x + loopShift`. */
export type Loop = { kind: "loop"; x: number };
export type Thing = Spike | Critter | Shard | Ramp | Loop;

export type RunEvent = "jump" | "shard" | "pop" | "hit" | "over" | "land";

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
  /** Distance run, which the loop does not double back on the way `x` does. */
  distance: number;
  /** Time left on the held jump's lighter pull; 0 once released or spent. */
  hold: number;
  /** Time since a press that has not jumped yet, and since the hero last stood on something. */
  sincePress: number;
  sinceGround: number;
  /** The loop being run, and how far round it (radians, 0 → 2π). */
  loop: { at: Loop; theta: number } | null;
  shards: number;
  bonus: number;
  mercy: number;
  over: boolean;
  things: Thing[];
  /** Where the next stretch of world starts. */
  laidTo: number;
  /** The kind of the stretch laid last, so a loop never follows a loop. */
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
    distance: 0, hold: 0, sincePress: Infinity, sinceGround: 0, loop: null, shards: 0, bonus: 0, mercy: 0,
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

/** Where on a loop the hero is at `theta`: up the far wall, over the top, down the near one, out. */
export function loopPoint(loop: Loop, theta: number): { x: number; y: number } {
  const r = RUN.loopRadius;
  return {
    x: loop.x + r * Math.sin(theta) + (theta / (2 * Math.PI)) * RUN.loopShift,
    y: r - r * Math.cos(theta),
  };
}

/** How long a stretch of hazards gives the hero to react, in seconds of running at the current speed. */
const gapFor = (run: Run) => run.speed * (0.75 + run.rand() * 0.7);

/** Lay the world out ahead of the hero, one pattern at a time, and drop what it has run past. */
function layWorld(run: Run) {
  while (run.laidTo < run.x + RUN.lookahead) {
    const at = run.laidTo;
    const r = run.rand();
    const far = run.distance > 2400;
    let pattern: string;
    if (far && run.lastPattern !== "loop" && r < 0.1) pattern = "loop";
    else if (run.distance > 900 && run.lastPattern !== "ramp" && r < 0.22) pattern = "ramp";
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
      case "loop": {
        const loop: Loop = { kind: "loop", x: at + 30 };
        run.things.push(loop);
        for (let i = 1; i < 8; i++) {
          const p = loopPoint(loop, (i / 8) * 2 * Math.PI);
          run.things.push({ kind: "shard", x: p.x, y: p.y + RUN.radius, taken: false });
        }
        len = 30 + RUN.loopShift + 60;
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
    case "loop": return t.x + RUN.loopShift + RUN.loopRadius;
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
  run.mercy = Math.max(0, run.mercy - dt);
  run.sincePress = input.pressed ? 0 : run.sincePress + dt;
  if (!input.held) run.hold = 0;

  if (run.loop) {
    // Round the loop on rails: it is the one stretch the hero cannot jump out of.
    const { at } = run.loop;
    run.loop.theta = Math.min(2 * Math.PI, run.loop.theta + (run.speed / RUN.loopRadius) * dt);
    const p = loopPoint(at, run.loop.theta);
    run.x = p.x;
    run.y = p.y;
    run.distance += run.speed * dt;
    if (run.loop.theta >= 2 * Math.PI) { run.loop = null; run.y = 0; run.vy = 0; run.grounded = true; }
  } else {
    const dx = run.speed * dt;
    const nextX = run.x + dx;
    const entering = run.grounded
      ? run.things.find((t): t is Loop => t.kind === "loop" && run.x <= t.x && nextX > t.x)
      : undefined;
    if (entering) {
      run.loop = { at: entering, theta: 0 };
      run.x = entering.x;
      run.distance += entering.x - (nextX - dx);
    } else {
      run.distance += dx;
      if (run.grounded) {
        const g = groundAt(run.things, nextX);
        if (g < run.y - 0.5) {
          // The ground fell away (a ramp's lip): carry on at the slope's speed, now in the air.
          run.grounded = false;
        } else {
          run.vy = (g - run.y) / dt;
          run.y = g;
        }
        run.x = nextX;
      } else {
        run.x = nextX;
      }
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
        if (!run.grounded || run.loop) {
          // Curled into a ball in the air: the critter pops, and a falling hero bounces off it.
          t.alive = false;
          run.bonus += RUN.popPoints;
          if (run.vy < 0) run.vy = RUN.bounceSpeed;
          run.hold = 0;
          events.push("pop");
        } else {
          hurt(run, events);
        }
      }
    } else if (t.kind === "spike") {
      // The spike's box, a little forgiving at its tip: a ball that clears the point clears the spike.
      const left = t.x + 2, right = t.x + RUN.spikeWidth - 2, top = RUN.spikeHeight - 3;
      const nx = Math.max(left, Math.min(c.x, right));
      const ny = Math.max(0, Math.min(c.y, top));
      if (Math.hypot(nx - c.x, ny - c.y) < R - 1) hurt(run, events);
    }
    if (run.over) return;
  }
}

/** Shards are the hero's cover: a hit while holding any scatters them all; a hit with none ends the run. */
function hurt(run: Run, events: RunEvent[]) {
  if (run.mercy > 0) return;
  if (run.shards > 0) {
    run.shards = 0;
    run.mercy = RUN.mercy;
    run.speed = Math.max(RUN.baseSpeed, run.speed * RUN.hitSlow);
    run.vy = 260;
    run.grounded = false;
    run.hold = 0;
    events.push("hit");
    return;
  }
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
