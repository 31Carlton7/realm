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
export const VIEW_HEIGHT = 176;
const EARTH = 36;
const CHECK = 12;
const HERO_SIZE = 32;

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
  green: string; accent: string; accentInk: string; red: string; ink: string; ink2: string; ink3: string; hero: Colours;
};

type Spark = { x: number; y: number; age: number };

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
  private sparks: Spark[] = [];
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
    this.sparks = [];
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
      for (const s of this.sparks) s.age += dt;
      this.sparks = this.sparks.filter((s) => s.age < 0.35);
      this.paint();
      if (this.state === "running") this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private react(events: RunEvent[]) {
    for (const e of events) {
      if (this.sound) this.synth.play(e);
      if ((e === "shard" || e === "pop") && !this.reduced()) {
        const c = heroCentre(this.run);
        this.sparks.push({ x: c.x, y: c.y, age: 0 });
      }
      if (e === "over") {
        this.state = "over";
        this.held = false;
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
    const w = Math.round(this.canvas.clientWidth);
    const dpr = window.devicePixelRatio || 1;
    if (!w || (w === this.width && dpr === this.dpr)) return;
    this.ctx ??= this.canvas.getContext("2d");
    this.width = w;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(VIEW_HEIGHT * dpr);
    this.paint();
  }

  private readPalette(): Palette {
    const css = getComputedStyle(this.canvas);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const face = document.documentElement.getAttribute("data-mode") === "light" ? "light" : "dark";
    const spec = heroSpec(this.opts.seed);
    return {
      green: v("--green", "#3fb26b"), accent: v("--accent", "#4a8df8"), accentInk: v("--accent-ink", "#9cc1ff"),
      red: v("--red", "#e5534b"), ink: v("--ink", "#f2f3f5"), ink2: v("--ink-2", "#a7abb3"), ink3: v("--ink-3", "#737882"),
      hero: colours(spec.palette, face),
    };
  }

  /** Draw the hero's two poses as images; they replace the ones shown once both have loaded. */
  private loadSprites() {
    const face = document.documentElement.getAttribute("data-mode") === "light" ? "light" : "dark";
    const spec = heroSpec(this.opts.seed);
    const image = (state: "working" | "needs-you") => {
      // The Realmite's own drawing, with its stylesheet carried inside so it paints as an image.
      const svg = realmiteSvg(spec, { size: 64, state, uid: `runner-${state}`, face })
        .replace(/ data-animate=""/, "")
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
    const W = this.width, H = VIEW_HEIGHT, ground = H - EARTH;
    const still = this.reduced();
    const heroX = Math.min(88, Math.round(W * 0.16));
    const sx = (x: number) => x - run.x + heroX;
    const sy = (y: number) => ground - y;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Hills, far and near, in the grass's colour laid thin over the pane's ground.
    const scroll = still ? 0 : run.distance;
    hills(ctx, W, ground, p.green, 0.1, scroll * 0.15, 46, 0.011, 1.7);
    hills(ctx, W, ground, p.green, 0.18, scroll * 0.4, 26, 0.019, 4.1);

    // Earth: a checker in the accent, scrolling with the ground.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, ground, W, EARTH);
    ctx.clip();
    ctx.fillStyle = p.accent;
    const off = ((run.x % (CHECK * 2)) + CHECK * 2) % (CHECK * 2);
    for (let row = 0; row * CHECK < EARTH; row++) {
      ctx.globalAlpha = 0.2 - row * 0.045;
      for (let x = -off + (row % 2) * CHECK; x < W; x += CHECK * 2) ctx.fillRect(x, ground + row * CHECK, CHECK, CHECK);
    }
    ctx.restore();

    // Ramps: a wedge of the same earth under the same grass.
    for (const t of run.things) {
      if (t.kind !== "ramp" || sx(t.x + t.len) < 0 || sx(t.x) > W) continue;
      ctx.beginPath();
      ctx.moveTo(sx(t.x), ground);
      for (let i = 0; i <= 24; i++) { const u = i / 24; ctx.lineTo(sx(t.x + u * t.len), sy(t.h * u * u)); }
      ctx.lineTo(sx(t.x + t.len), ground);
      ctx.closePath();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = p.accent;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      for (let i = 0; i <= 24; i++) { const u = i / 24; ctx.lineTo(sx(t.x + u * t.len), sy(t.h * u * u)); }
      ctx.strokeStyle = p.green;
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.stroke();
    }

    // The grass along the top, with a scallop of blades.
    ctx.fillStyle = p.green;
    ctx.fillRect(0, ground - 1, W, 5);
    const bOff = ((run.x % 10) + 10) % 10;
    ctx.beginPath();
    for (let x = -bOff; x < W + 10; x += 10) { ctx.moveTo(x, ground + 4); ctx.arc(x + 5, ground + 4, 5, Math.PI, 0, true); }
    ctx.globalAlpha = 0.55;
    ctx.fill();
    ctx.globalAlpha = 1;

    for (const t of run.things) {
      const x = sx(t.x);
      if (x < -30 || x > W + 30) continue;
      if (t.kind === "spike") {
        ctx.beginPath();
        ctx.moveTo(x, ground);
        ctx.lineTo(x + RUN.spikeWidth / 2, ground - RUN.spikeHeight);
        ctx.lineTo(x + RUN.spikeWidth, ground);
        ctx.closePath();
        ctx.fillStyle = p.ink3;
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x + RUN.spikeWidth / 2, ground - RUN.spikeHeight);
        ctx.lineTo(x + RUN.spikeWidth / 2 + 3, ground - 2);
        ctx.strokeStyle = p.ink2;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (t.kind === "shard" && !t.taken) {
        const turn = still ? 1 : Math.cos(run.t * 4 + t.x * 0.05);
        hexagon(ctx, x, sy(t.y), RUN.shardRadius, Math.max(0.25, Math.abs(turn)), p.accent);
        hexagon(ctx, x, sy(t.y), RUN.shardRadius * 0.45, Math.max(0.25, Math.abs(turn)), p.accentInk);
      } else if (t.kind === "critter" && t.alive) {
        critter(ctx, x, sy(RUN.critterRadius), still ? 0 : -t.spin, p);
      }
    }

    for (const s of this.sparks) {
      const k = s.age / 0.35;
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = p.accentInk;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      hexPath(ctx, sx(s.x), sy(s.y), 6 + k * 14, 1);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // The hero: on its feet, the Realmite at work; in the air, curled into a ball.
    const hx = heroX, hy = sy(run.y);
    if (run.grounded || this.state === "over") {
      const img = this.state === "over" ? this.sprites?.over : this.sprites?.run;
      const bob = this.state === "running" && !still ? Math.abs(Math.sin(run.distance / 9)) * 1.5 : 0;
      if (img) {
        ctx.drawImage(img, hx - HERO_SIZE / 2, hy - HERO_SIZE * (58 / 64) - bob, HERO_SIZE, HERO_SIZE);
      }
    } else {
      ball(ctx, hx, hy - RUN.radius, RUN.radius, still ? 0 : run.distance / RUN.radius, p.hero);
    }
  }
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
  ctx.arc(x - 4, y - 3, 2.6, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x - 4.8, y - 3, 1.3, 0, Math.PI * 2);
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
