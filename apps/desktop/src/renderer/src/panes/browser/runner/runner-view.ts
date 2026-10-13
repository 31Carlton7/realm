/**
 * The runner on the page: a canvas, its frame loop, its keys, and its few sounds. The rules are
 * `runner.ts`; this only draws a run and feeds it presses.
 *
 * The world is drawn one game pixel to one CSS pixel, so a wider pane sees further ahead rather than a
 * bigger hero. Everything is painted from the window's own tokens (read from the canvas's computed
 * style, again whenever the theme changes), and the sky is left clear: the pane's ground shows through.
 *
 * A frame loop is outside the stylesheet's motion controls (design.md, Motion), so this re-implements
 * them: the loop runs only while a run is being played, and stops — holding its last frame — when the
 * window loses focus, the page is hidden, focus leaves the game, or the window goes quiet. Under
 * Reduce motion the game still plays when asked to, but the hills stand still, the ball does not spin
 * and nothing sparkles.
 */
import { colours, realmiteFromSeed, realmiteSvg, REALMITE_CSS, type Colours, type PaletteId, type RealmiteSpec } from "@realm/ui";
import { advance, createRun, heroCentre, nextBest, parseBest, RUN, score, type Run, type RunEvent } from "./runner";

/** The canvas's height in CSS pixels, and how much of it is earth below the running line. */
/** How many game pixels tall the view is, whatever its CSS height: the canvas scales the world to fit,
 *  so a taller view (the stylesheet grows it with the pane's width) draws everything bigger. */
const WORLD_HEIGHT = 170;
const EARTH = 30;
const CHECK = 13;
/** The Realmite on its feet, in game pixels: its body about as wide as the ball it curls into. */
const HERO_SIZE = 46;
/** The world's own scenery, laid by position so it scrolls with the ground and is the same each pass. */
const DECOR_STEP = 70;

const BEST_KEY = "realm.runner.best";
const SOUND_KEY = "realm.runner.sound";

/** Blue hues a runner never wears: a blue ball rolling through green hills is somebody else's hero. */
const BLUES: readonly PaletteId[] = ["sky", "realm", "iris", "teal"];
const WARMS: readonly PaletteId[] = ["rose", "apricot", "honey", "moss", "orchid", "clay"];

/** The Realmite that runs for a seed: the seed's own, recoloured from a warm hue if it came out blue. */
export function heroSpec(seed: string): RealmiteSpec {
  const spec = realmiteFromSeed(seed);
  if (!BLUES.includes(spec.palette)) return spec;
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { ...spec, palette: WARMS[h % WARMS.length]! };
}

export type RunnerState = "idle" | "running" | "paused" | "over";

type Palette = {
  green: string; orange: string; font: string; accent: string; accentInk: string; red: string; ink: string; ink2: string; ink3: string; hero: Colours;
};

/** A flourish that lives a moment: a sparkle where a shard was, dust where the hero landed, and the
 *  points it scored rising off it. In world coordinates, so they stay where they happened. */
type Effect = { kind: "spark" | "dust" | "points"; x: number; y: number; age: number; text?: string };
const EFFECT_LIFE = { spark: 0.4, dust: 0.35, points: 0.7 } as const;

function readStore(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function writeStore(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* a full or blocked store keeps no best */ }
}

/** A few blips, made on the spot by an oscillator: no files, and nothing until sound is switched on. */
class Synth {
  private ctx: AudioContext | null = null;
  /** Made on the click that switches sound on, so the window lets it play. */
  prime() {
    const AC = window.AudioContext;
    if (AC && !this.ctx) this.ctx = new AC();
    void this.ctx?.resume();
  }
  play(event: RunEvent) {
    this.prime();
    const ctx = this.ctx;
    if (!ctx) return;
    const tone = (from: number, to: number, dur: number, type: OscillatorType, gain: number, at = 0) => {
      const t = ctx.currentTime + at;
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(from, t);
      osc.frequency.exponentialRampToValueAtTime(to, t + dur);
      amp.gain.setValueAtTime(gain, t);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(amp).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + dur);
    };
    if (event === "jump") tone(330, 620, 0.12, "triangle", 0.08);
    else if (event === "shard") { tone(988, 988, 0.07, "sine", 0.06); tone(1319, 1319, 0.12, "sine", 0.05, 0.05); }
    else if (event === "pop") tone(520, 180, 0.14, "square", 0.04);
    else if (event === "over") { tone(392, 196, 0.22, "triangle", 0.08); tone(262, 131, 0.3, "triangle", 0.07, 0.16); }
  }
  close() { void this.ctx?.close(); this.ctx = null; }
}

export type RunnerViewOptions = {
  /** Picks the Realmite that runs: the same seed is always the same one. */
  seed: string;
  onChange: (view: { state: RunnerState; score: number; best: number; sound: boolean }) => void;
};

export class RunnerView {
  state: RunnerState = "idle";
  best: number;
  sound: boolean;
  private run: Run;
  /** Asked for at the first size the canvas has: a canvas that is never laid out never paints. */
  private ctx: CanvasRenderingContext2D | null = null;
  private raf = 0;
  private last = 0;
  private pressed = false;
  private held = false;
  private width = 0;
  private dpr = 1;
  private palette: Palette | null = null;
  private sprites: { run: HTMLImageElement; over: HTMLImageElement } | null = null;
  private spritesAsked = false;
  private effects: Effect[] = [];
  private height = 0;
  private shownScore = -1;
  private synth = new Synth();
  private reduce: MediaQueryList | null;
  private cleanups: (() => void)[] = [];

  constructor(private canvas: HTMLCanvasElement, private opts: RunnerViewOptions) {
    this.best = parseBest(readStore(BEST_KEY));
    this.sound = readStore(SOUND_KEY) === "on";
    this.run = createRun(1);
    this.reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;

    const onBlur = () => this.pause();
    const onVisible = () => { if (document.hidden) this.pause(); };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisible);
    canvas.addEventListener("blur", onBlur);
    this.cleanups.push(() => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisible);
      canvas.removeEventListener("blur", onBlur);
    });
    // The theme and the quiet switch both live on the root.
    const root = document.documentElement;
    const watch = new MutationObserver((changes) => {
      if (root.hasAttribute("data-quiet")) this.pause();
      if (!changes.some((c) => c.attributeName === "data-mode" || c.attributeName === "data-theme")) return;
      // A new face: new colours, and the hero redrawn in them (the old one stands in until it loads).
      this.palette = null;
      this.loadSprites();
      this.paint();
    });
    watch.observe(root, { attributes: true, attributeFilter: ["data-mode", "data-theme", "data-quiet"] });
    this.cleanups.push(() => watch.disconnect());
    const onReduce = () => this.paint();
    this.reduce?.addEventListener?.("change", onReduce);
    this.cleanups.push(() => this.reduce?.removeEventListener?.("change", onReduce));
    if (typeof ResizeObserver !== "undefined") {
      const resize = new ResizeObserver(() => this.resize());
      resize.observe(canvas);
      this.cleanups.push(() => resize.disconnect());
    }
    this.resize();
    this.emit();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    for (const c of this.cleanups) c();
    this.synth.close();
  }

  /** Play, Pause or Resume, whichever the run is ready for. */
  toggle() {
    if (this.state === "running") this.pause();
    else if (this.state === "paused") this.resume();
    else this.start();
  }

  /** A jump key or the pointer went down: starts a run that is not going, jumps in one that is. */
  press() {
    this.held = true;
    if (this.state === "running") this.pressed = true;
    else if (this.state === "paused") this.resume();
    else this.start();
  }

  release() { this.held = false; }

  pause() {
    if (this.state !== "running") return;
    this.state = "paused";
    this.held = false;
    cancelAnimationFrame(this.raf);
    this.paint();
    this.emit();
  }

  setSound(on: boolean) {
    this.sound = on;
    if (on) this.synth.prime();
    writeStore(SOUND_KEY, on ? "on" : "off");
    this.emit();
  }

  private start() {
    this.run = createRun((Math.random() * 2 ** 32) >>> 0);
    this.effects = [];
    this.state = "running";
    this.loop();
    this.emit();
  }

  private resume() {
    this.state = "running";
    this.loop();
    this.emit();
  }

  private loop() {
    cancelAnimationFrame(this.raf);
    this.last = performance.now();
    const frame = (now: number) => {
      if (this.state !== "running") return;
      const dt = Math.max(0, (now - this.last) / 1000);
      this.last = now;
      const events = advance(this.run, { pressed: this.pressed, held: this.held }, dt);
      this.pressed = false;
      this.react(events);
      for (const f of this.effects) f.age += dt;
      this.effects = this.effects.filter((f) => f.age < EFFECT_LIFE[f.kind]);
      this.paint();
      if (this.state === "running") this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private react(events: RunEvent[]) {
    for (const e of events) {
      if (this.sound) this.synth.play(e);
      if (!this.reduced()) {
        const c = heroCentre(this.run);
        if (e === "shard" || e === "pop") {
          this.effects.push({ kind: "spark", x: c.x, y: c.y, age: 0 });
          this.effects.push({ kind: "points", x: c.x, y: c.y + RUN.radius + 6, age: 0, text: `+${e === "shard" ? RUN.shardPoints : RUN.popPoints}` });
        } else if (e === "land") {
          this.effects.push({ kind: "dust", x: this.run.x, y: this.run.y, age: 0 });
        }
      }
      if (e === "over") {
        this.state = "over";
        this.held = false;
        // The last frame holds still, so a sparkle caught mid-flight would hang there: let them go.
        this.effects = [];
        const best = nextBest(this.best, score(this.run));
        if (best !== this.best) { this.best = best; writeStore(BEST_KEY, String(best)); }
        this.emit();
      }
    }
    const s = score(this.run);
    if (s !== this.shownScore) this.emit();
  }

  private emit() {
    this.shownScore = score(this.run);
    this.opts.onChange({ state: this.state, score: this.shownScore, best: this.best, sound: this.sound });
  }

  private reduced() { return this.reduce?.matches ?? false; }

  private resize() {
    const w = Math.round(this.canvas.clientWidth), h = Math.round(this.canvas.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    if (!w || !h || (w === this.width && h === this.height && dpr === this.dpr)) return;
    this.ctx ??= this.canvas.getContext("2d");
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.paint();
  }

  private readPalette(): Palette {
    const css = getComputedStyle(this.canvas);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const face = document.documentElement.getAttribute("data-mode") === "light" ? "light" : "dark";
    const spec = heroSpec(this.opts.seed);
    return {
      green: v("--green", "#3fb26b"), accent: v("--accent", "#4a8df8"), accentInk: v("--accent-ink", "#9cc1ff"),
      orange: v("--orange", "#e0913a"), font: getComputedStyle(this.canvas).fontFamily || "system-ui",
      red: v("--red", "#e5534b"), ink: v("--ink", "#f2f3f5"), ink2: v("--ink-2", "#a7abb3"), ink3: v("--ink-3", "#737882"),
      hero: colours(spec.palette, face),
    };
  }

  /** Draw the hero's two poses as images; they replace the ones shown once both have loaded. */
  private loadSprites() {
    const face = document.documentElement.getAttribute("data-mode") === "light" ? "light" : "dark";
    const spec = heroSpec(this.opts.seed);
    const image = (state: "working" | "needs-you") => {
      // The Realmite's own drawing, with its stylesheet carried inside so it paints as an image, and
      // without its bare `data-animate` (HTML, not XML: an image that kept it would not decode).
      const svg = realmiteSvg(spec, { size: 128, state, uid: `runner-${state}`, face })
        .replace(/ data-animate(?:="")?(?=[\s/>])/, "")
        .replace(/^<svg([^>]*)>/, `<svg$1><style>${REALMITE_CSS}</style>`);
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      return img;
    };
    const next = { run: image("working"), over: image("needs-you") };
    void Promise.all([next.run.decode(), next.over.decode()]).then(() => { this.sprites = next; this.paint(); }, () => {});
  }

  /** Draw the run as it stands. Cheap enough to call on any change while the loop is stopped. */
  paint() {
    const ctx = this.ctx;
    if (!ctx || !this.width) return;
    this.palette ??= this.readPalette();
    if (!this.spritesAsked) { this.spritesAsked = true; this.loadSprites(); }
    const p = this.palette;
    const run = this.run;
    const k = this.height / WORLD_HEIGHT;
    const W = this.width / k, H = WORLD_HEIGHT, ground = H - EARTH;
    const still = this.reduced();
    const heroX = Math.min(110, Math.round(W * 0.18));
    const sx = (x: number) => x - run.x + heroX;
    const sy = (y: number) => ground - y;

    ctx.setTransform(this.dpr * k, 0, 0, this.dpr * k, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // The sky's layers, each slower the further off it is. Under Reduce motion they stand still.
    const scroll = still ? 0 : run.distance;
    clouds(ctx, W, scroll * 0.08, p.accent);
    if (!still && this.state === "running" && run.speed >= RUN.maxSpeed * 0.9) speedLines(ctx, W, ground, run.t, p.ink);
    hills(ctx, W, ground, p.green, 0.06, scroll * 0.12, 74, 0.007, 0.4);
    hills(ctx, W, ground, p.green, 0.1, scroll * 0.3, 48, 0.012, 1.7);
    hills(ctx, W, ground, p.green, 0.16, scroll * 0.55, 24, 0.021, 4.1);

    // Scenery on the running line: posts, flowers, tufts. Behind everything that can be touched.
    const first = Math.floor((run.x - heroX - 20) / DECOR_STEP), last = Math.ceil((run.x - heroX + W + 20) / DECOR_STEP);
    // None stands in a spike row or on a ramp, where it could be read as part of the hazard.
    const blocked = run.things.filter((t) => t.kind === "spike" || t.kind === "ramp");
    for (let i = first; i <= last; i++) {
      const at = i * DECOR_STEP + hash(i + 1000) * 40;
      if (blocked.some((t) => at > t.x - 16 && at < t.x + (t.kind === "ramp" ? t.len : RUN.spikeWidth) + 16)) continue;
      decor(ctx, i, sx(at), ground, p);
    }

    // Earth: a checker in the accent, scrolling with the ground, darker under the grass.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, ground, W, EARTH);
    ctx.clip();
    ctx.fillStyle = p.accent;
    const off = ((run.x % (CHECK * 2)) + CHECK * 2) % (CHECK * 2);
    for (let row = 0; row * CHECK < EARTH; row++) {
      const fade = 1 - row * 0.28;
      for (let x = -off - CHECK * 2; x < W + CHECK; x += CHECK) {
        const dark = (Math.round((x + off) / CHECK) + row) % 2 === 0;
        ctx.globalAlpha = (dark ? 0.24 : 0.1) * fade;
        ctx.fillRect(x, ground + row * CHECK, CHECK, CHECK);
      }
    }
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, ground + 5, W, 3);
    ctx.restore();
    ctx.globalAlpha = 1;

    // Ramps: a wedge of the same earth under the same grass.
    for (const t of run.things) {
      if (t.kind !== "ramp" || sx(t.x + t.len) < 0 || sx(t.x) > W) continue;
      ctx.beginPath();
      ctx.moveTo(sx(t.x), ground);
      for (let i = 0; i <= 24; i++) { const u = i / 24; ctx.lineTo(sx(t.x + u * t.len), sy(t.h * u * u)); }
      ctx.lineTo(sx(t.x + t.len), ground);
      ctx.closePath();
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = p.accent;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      for (let i = 0; i <= 24; i++) { const u = i / 24; ctx.lineTo(sx(t.x + u * t.len), sy(t.h * u * u)); }
      ctx.strokeStyle = p.green;
      ctx.lineWidth = 5;
      ctx.lineCap = "round";
      ctx.stroke();
    }

    // The grass lip: a band, a lighter edge along its top, and a scallop hanging over the earth.
    ctx.fillStyle = p.green;
    ctx.fillRect(0, ground - 1, W, 6);
    const bOff = ((run.x % 9) + 9) % 9;
    ctx.beginPath();
    for (let x = -bOff; x < W + 9; x += 9) { ctx.moveTo(x, ground + 5); ctx.arc(x + 4.5, ground + 5, 4.5, Math.PI, 0, true); }
    ctx.fill();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, ground - 1, W, 1.2);
    ctx.globalAlpha = 1;

    for (const t of run.things) {
      const x = sx(t.x);
      if (x < -30 || x > W + 30) continue;
      if (t.kind === "spike") spike(ctx, x, ground, p);
      else if (t.kind === "shard" && !t.taken) {
        const turn = still ? 1 : Math.max(0.25, Math.abs(Math.cos(run.t * 4 + t.x * 0.05)));
        hexagon(ctx, x, sy(t.y), RUN.shardRadius, turn, p.accent);
        hexagon(ctx, x, sy(t.y), RUN.shardRadius * 0.45, turn, p.accentInk);
      } else if (t.kind === "critter" && t.alive) {
        critter(ctx, x, sy(RUN.critterRadius), still ? 0 : -t.spin, p);
      }
    }

    for (const f of this.effects) {
      const a = f.age / EFFECT_LIFE[f.kind];
      ctx.globalAlpha = 1 - a;
      if (f.kind === "spark") {
        ctx.strokeStyle = p.accentInk;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        hexPath(ctx, sx(f.x), sy(f.y), 7 + a * 16, 1);
        ctx.stroke();
        ctx.fillStyle = p.accentInk;
        for (let i = 0; i < 6; i++) {
          const ang = (i * Math.PI) / 3;
          ctx.fillRect(sx(f.x) + Math.cos(ang) * (8 + a * 22) - 1, sy(f.y) + Math.sin(ang) * (8 + a * 22) - 1, 2, 2);
        }
      } else if (f.kind === "dust") {
        ctx.fillStyle = p.ink2;
        ctx.globalAlpha = 0.35 * (1 - a);
        for (const d of [-1, 1]) {
          ctx.beginPath();
          ctx.arc(sx(f.x) + d * (6 + a * 14), sy(f.y) - 3 - a * 3, 3 + a * 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    // The hero: on its feet, the Realmite at work; in the air, curled into a ball.
    const hx = heroX, hy = sy(run.y);
    if (run.grounded || this.state === "over") {
      const img = this.state === "over" ? this.sprites?.over : this.sprites?.run;
      const moving = this.state === "running" && !still;
      const bob = moving ? Math.abs(Math.sin(run.distance / 11)) * 2 : 0;
      if (img) {
        ctx.save();
        ctx.translate(hx, hy);
        if (moving) ctx.rotate(0.05 + (run.speed / RUN.maxSpeed) * 0.05);
        ctx.drawImage(img, -HERO_SIZE / 2, -HERO_SIZE * (58 / 64) - bob, HERO_SIZE, HERO_SIZE);
        ctx.restore();
      }
    } else {
      ball(ctx, hx, hy - RUN.radius, RUN.radius, still ? 0 : run.distance / RUN.radius, p.hero);
    }

    // Words, in CSS pixels so they keep the type's own sizes.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const f of this.effects) {
      if (f.kind !== "points") continue;
      const a = f.age / EFFECT_LIFE.points;
      ctx.globalAlpha = 1 - a * a;
      ctx.font = `600 12px ${p.font}`;
      ctx.fillStyle = p.accentInk;
      ctx.fillText(f.text ?? "", sx(f.x) * k, (sy(f.y) - a * 18) * k);
    }
    ctx.globalAlpha = 1;
    const title = TITLES[this.state];
    if (title) {
      const cx = this.width / 2, cy = this.height * 0.3;
      ctx.font = `600 16px ${p.font}`;
      ctx.fillStyle = p.ink;
      ctx.fillText(title[0], cx, cy);
      ctx.font = `400 12px ${p.font}`;
      ctx.fillStyle = p.ink2;
      const line = this.state === "over" ? `${formatScore(score(run))}  ·  Best ${formatScore(this.best)}` : this.state === "idle" ? `Hold to jump higher  ·  Best ${formatScore(this.best)}` : title[1];
      ctx.fillText(line, cx, cy + 22);
      if (this.state === "over") { ctx.fillText(title[1], cx, cy + 40); }
    }
  }
}

/** What the canvas says while nothing is running: a headline, and the line under it. */
const TITLES: Partial<Record<RunnerState, [string, string]>> = {
  idle: ["Press Space to run", ""],
  paused: ["Paused", "Space to carry on"],
  over: ["Run over", "Space to run again"],
};

/** A small integer hash, so scenery is laid the same at the same place on every pass. */
function hash(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function clouds(ctx: CanvasRenderingContext2D, W: number, scroll: number, colour: string) {
  const step = 150;
  ctx.fillStyle = colour;
  ctx.globalAlpha = 0.09;
  for (let i = Math.floor(scroll / step) - 1; i * step - scroll < W + step; i++) {
    const r = hash(i * 7 + 3);
    if (r < 0.35) continue;
    const x = i * step - scroll + r * 60, y = 18 + hash(i * 13 + 1) * 34, s = 0.7 + r * 0.5;
    ctx.beginPath();
    ctx.arc(x, y, 9 * s, 0, Math.PI * 2);
    ctx.arc(x + 11 * s, y - 5 * s, 11 * s, 0, Math.PI * 2);
    ctx.arc(x + 24 * s, y, 8 * s, 0, Math.PI * 2);
    ctx.rect(x, y, 24 * s, 8 * s);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Thin streaks across the sky at top speed. */
function speedLines(ctx: CanvasRenderingContext2D, W: number, ground: number, t: number, colour: string) {
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.14;
  ctx.beginPath();
  for (let i = 0; i < 7; i++) {
    const y = 14 + hash(i + 40) * (ground - 30);
    const len = 30 + hash(i + 90) * 50;
    const x = W - ((t * (700 + i * 60) + hash(i) * W) % (W + len));
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** One piece of scenery for slot `i`: a hexagon-topped post, a flower, a tuft, or nothing. */
function decor(ctx: CanvasRenderingContext2D, i: number, at: number, ground: number, p: Palette) {
  const r = hash(i);
  if (r < 0.14) {
    ctx.strokeStyle = p.ink3;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(at, ground);
    ctx.lineTo(at, ground - 26);
    ctx.stroke();
    ctx.beginPath();
    hexPath(ctx, at, ground - 31, 6, 1);
    ctx.fillStyle = p.orange;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    hexPath(ctx, at, ground - 31, 2.4, 1);
    ctx.fillStyle = "#fff";
    ctx.globalAlpha = 0.6;
    ctx.fill();
    ctx.globalAlpha = 1;
  } else if (r < 0.5) {
    // Never the hazards' red nor the shards' blue: a flower is scenery, never a thing to jump or take.
    const petal = hash(i + 7) < 0.6 ? p.orange : p.ink2;
    const h = 8 + hash(i + 3) * 6;
    ctx.strokeStyle = p.green;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(at, ground);
    ctx.lineTo(at, ground - h);
    ctx.stroke();
    ctx.fillStyle = petal;
    for (let j = 0; j < 5; j++) {
      const a = (j * 2 * Math.PI) / 5;
      ctx.beginPath();
      ctx.arc(at + Math.cos(a) * 2.6, ground - h + Math.sin(a) * 2.6, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(at, ground - h, 1.3, 0, Math.PI * 2);
    ctx.fill();
  } else if (r < 0.85) {
    ctx.strokeStyle = p.green;
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (const [dx, h] of [[-3, 6], [0, 9], [3, 6]] as const) { ctx.moveTo(at + dx * 0.4, ground); ctx.lineTo(at + dx, ground - h); }
    ctx.stroke();
  }
}

function spike(ctx: CanvasRenderingContext2D, x: number, ground: number, p: Palette) {
  const w = RUN.spikeWidth, h = RUN.spikeHeight;
  ctx.beginPath();
  ctx.moveTo(x, ground);
  ctx.lineTo(x + w / 2, ground - h);
  ctx.lineTo(x + w, ground);
  ctx.closePath();
  ctx.fillStyle = p.ink3;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x + w / 2, ground - h);
  ctx.lineTo(x + w, ground);
  ctx.lineTo(x + w / 2 + 2, ground);
  ctx.closePath();
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.moveTo(x + w / 2, ground - h);
  ctx.lineTo(x + w / 2 - 3, ground - 3);
  ctx.strokeStyle = p.ink2;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function hills(ctx: CanvasRenderingContext2D, W: number, ground: number, colour: string, alpha: number, scroll: number, height: number, freq: number, phase: number) {
  ctx.beginPath();
  ctx.moveTo(0, ground);
  for (let x = 0; x <= W + 8; x += 8) {
    const u = x + scroll;
    const y = height * (0.55 + 0.3 * Math.sin(u * freq + phase) + 0.15 * Math.sin(u * freq * 2.3 + phase * 2));
    ctx.lineTo(x, ground - y);
  }
  ctx.lineTo(W + 8, ground);
  ctx.closePath();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.globalAlpha = 1;
}

function hexPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, squeeze: number) {
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    const px = x + Math.cos(a) * r * squeeze, py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function hexagon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, squeeze: number, colour: string) {
  ctx.beginPath();
  hexPath(ctx, x, y, r, squeeze);
  ctx.fillStyle = colour;
  ctx.fill();
}

/** A round little roller in the warning hue, its shell's seams turning as it comes. */
function critter(ctx: CanvasRenderingContext2D, x: number, y: number, spin: number, p: Palette) {
  const r = RUN.critterRadius;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = p.red;
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.strokeStyle = "rgba(0,0,0,0.28)";
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 3; i++) {
    const a = spin + (i * Math.PI) / 3;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    ctx.lineTo(x - Math.cos(a) * r, y - Math.sin(a) * r);
    ctx.stroke();
  }
  ctx.restore();
  // One eye, always looking at the hero.
  ctx.beginPath();
  ctx.arc(x - r * 0.45, y - r * 0.32, r * 0.3, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x - r * 0.53, y - r * 0.32, r * 0.15, 0, Math.PI * 2);
  ctx.fillStyle = "#111";
  ctx.fill();
}

/** The Realmite curled up: its body's colours in a ball, with a light seam that rolls. */
function ball(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, turn: number, c: Colours) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = c.body;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, Math.PI * 0.15, Math.PI * 0.85);
  ctx.arc(x, y + r * 0.2, r * 0.8, Math.PI * 0.85, Math.PI * 0.15, true);
  ctx.closePath();
  ctx.fillStyle = c.shade;
  ctx.fill();
  ctx.strokeStyle = c.light;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  for (let i = 0; i < 2; i++) {
    const a = turn + i * Math.PI;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.62, a, a + 1.1);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = c.ink;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Score as the readout shows it: five digits, like every arcade cabinet. */
export const formatScore = (n: number) => String(Math.min(99999, n)).padStart(5, "0");
