import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LayaRecording, SimulatorAxElement, SimulatorAxTree } from "@realm/contracts";
import { RpcError } from "../store/rows";
import type { BenchElement, BenchScreen } from "./benchmark";

/**
 * Laya learning an app by WATCHING it used.
 *
 * While a person uses an app on a device in a simulator pane — their own phone included — Realm reads
 * each new screen and keeps it on this Mac, and the next training run learns from those screens as it
 * learns from the ones Realm ships. Realm taps nothing: the person's own hands do everything, so
 * nothing is liked, followed, viewed or sent by Realm, and nothing about the session looks automated
 * to the app — which matters for apps whose terms forbid automated use, and whose every tap is seen by
 * other people.
 *
 * What is kept is each screen's shape: the elements' kinds, their names and where they are. What
 * belongs to people is left out — no field's contents, no value but a switch's, and no long text (a
 * caption, a comment, a message) — and what is kept stays in `<REALM_HOME>/laya/recordings/`: never
 * shipped, never committed, and gone when the recording is deleted. Only the app it was started in (or
 * the apps it was asked for by name) is kept: a person who switches to Messages mid-recording has
 * recorded nothing of it.
 */
export type RecorderDeps = {
  /** `<REALM_HOME>/laya/recordings`. */
  dir: string;
  /** The device's live tree — `SimulatorService.ax`. */
  read(simulatorId: string): Promise<SimulatorAxTree>;
  /** The pane's device name, for the recording's label; throws for a pane that does not exist. */
  deviceName(simulatorId: string): string;
  onChange(): void;
  now?: () => Date;
  /** How often the screen is read. A phone's runner reads in a tenth of a second; a simulator's
   *  serve-sim in most of one. */
  intervalMs?: number;
  /** The screens one recording keeps before it ends itself; `MAX_SCREENS` unless a test says fewer. */
  maxScreens?: number;
};

/** A screen at most this alike to one already kept is the same screen, a little scrolled. */
const SAME_SCREEN = 0.85;
/** Text this long is somebody's words — a caption, a comment, a message — not a control's name. */
const LONG_TEXT = 60;
/** Every recording ends here. A feed shows new posts on every screen, so half an hour of scrolling
 *  keeps a screen a second or so; this holds a session of that and bounds the disk it takes (tens of
 *  MB), and what training takes from it is the training set's to decide. */
const MAX_SCREENS = 2_000;
const DEFAULT_INTERVAL_MS = 1_200;
const READ_ONLY_TEXT = /static ?text|^text$|label|heading/i;
const SWITCH = /switch|toggle|check ?box/i;

type Live = {
  meta: LayaRecording;
  timer: NodeJS.Timeout | null;
  kept: Set<string>[];
  stopped: boolean;
};

export class LayaRecorder {
  private live: Live | null = null;
  /** Between a start's call and its recording: the read that names the app in front. */
  private starting = false;
  private readonly now: () => Date;

  constructor(private readonly d: RecorderDeps) {
    this.now = d.now ?? (() => new Date());
  }

  /** The recording under way, if one is. */
  current(): LayaRecording | null {
    return this.live ? { ...this.live.meta } : null;
  }

  /**
   * Start keeping the screens of `apps` — by the name each app's tree calls itself, "Instagram" —
   * from the device in pane `simulatorId`. With no apps named, the app in front as it starts; on the
   * home screen there is none, and nothing is recorded.
   */
  async start(simulatorId: string, apps: readonly string[]): Promise<LayaRecording> {
    if (this.live) throw new RpcError("LAYA_RECORDING", `Laya is already recording ${this.live.meta.device}. Stop that first.`);
    if (this.starting) throw new RpcError("LAYA_RECORDING", "Laya is already starting a recording.");
    const device = this.d.deviceName(simulatorId);
    this.starting = true;
    let named: string[];
    try {
      named = apps.length > 0 ? [...apps] : [await this.inFront(simulatorId, device)];
    } finally {
      this.starting = false;
    }
    const startedAt = this.now().toISOString();
    const id = `rec-${startedAt.replace(/[:.]/g, "-")}`;
    mkdirSync(join(this.d.dir, id, "screens"), { recursive: true });
    const meta: LayaRecording = { id, simulatorId, device, apps: named, seen: [], screens: 0, startedAt, endedAt: null, lastError: null };
    this.live = { meta, timer: null, kept: [], stopped: false };
    this.save(meta);
    this.schedule(0);
    this.d.onChange();
    return { ...meta };
  }

  /** The app in front, by its own name — or a refusal on the home screen, which names none. */
  private async inFront(simulatorId: string, device: string): Promise<string> {
    const app = (await this.d.read(simulatorId)).app.trim();
    if (!app) throw new RpcError("LAYA_NO_APP", `Open the app you want Laya to learn on ${device} first — the home screen is not one.`);
    return app;
  }

  /** Stop, and keep what was recorded for training. */
  stop(): LayaRecording | null {
    const live = this.live;
    if (!live) return null;
    live.stopped = true;
    if (live.timer) clearTimeout(live.timer);
    live.meta.endedAt = this.now().toISOString();
    this.save(live.meta);
    this.live = null;
    this.d.onChange();
    return { ...live.meta };
  }

  /** Every recording on this Mac, newest first. */
  list(): LayaRecording[] {
    if (!existsSync(this.d.dir)) return [];
    return readdirSync(this.d.dir).flatMap((name) => {
      try { return [JSON.parse(readFileSync(join(this.d.dir, name, "recording.json"), "utf8")) as LayaRecording]; } catch { return []; }
    }).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Every recording and what it kept, gone — the one under way included. */
  deleteAll(): void {
    this.stop();
    rmSync(this.d.dir, { recursive: true, force: true });
    this.d.onChange();
  }

  /** Every kept screen, as a training run reads a screen. */
  screens(): BenchScreen[] {
    return this.list().flatMap((r) => {
      const dir = join(this.d.dir, r.id, "screens");
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().flatMap((f) => {
        try { return [JSON.parse(readFileSync(join(dir, f), "utf8")) as BenchScreen]; } catch { return []; }
      });
    });
  }

  private schedule(ms: number): void {
    const live = this.live;
    if (!live || live.stopped) return;
    live.timer = setTimeout(() => { void this.look(live); }, ms);
  }

  /** One look at the screen: kept when it is one of the apps asked for and not a screen already kept. */
  private async look(live: Live): Promise<void> {
    try {
      const tree = await this.d.read(live.meta.simulatorId);
      if (live.stopped) return;
      live.meta.lastError = null;
      const app = tree.app.trim();
      if (wanted(app, live.meta.apps)) this.keep(live, app, tree);
      // Ended at the cap, where it would otherwise go on reading a phone for screens it throws away.
      if (live.meta.screens >= (this.d.maxScreens ?? MAX_SCREENS)) { this.stop(); return; }
    } catch (e) {
      if (live.stopped) return;
      const said = e instanceof Error ? e.message : String(e);
      if (said !== live.meta.lastError) { live.meta.lastError = said; this.save(live.meta); this.d.onChange(); }
    }
    this.schedule(this.d.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  private keep(live: Live, app: string, tree: SimulatorAxTree): void {
    const elements = tree.elements.flatMap((e) => kept(e));
    if (elements.length === 0) return;
    const shape = new Set(elements.map((e) => `${e.role}|${e.label}`));
    if (live.kept.some((k) => jaccard(k, shape) >= SAME_SCREEN)) return;
    live.kept.push(shape);
    const n = ++live.meta.screens;
    const screen: BenchScreen = { id: `${live.meta.id}-${String(n).padStart(4, "0")}`, app, from: `recording:${live.meta.id}`, elements };
    writeFileSync(join(this.d.dir, live.meta.id, "screens", `${screen.id}.json`), JSON.stringify(screen));
    if (!live.meta.seen.includes(app)) live.meta.seen.push(app);
    this.save(live.meta);
    this.d.onChange();
  }

  private save(meta: LayaRecording): void {
    mkdirSync(join(this.d.dir, meta.id), { recursive: true });
    writeFileSync(join(this.d.dir, meta.id, "recording.json"), JSON.stringify(meta, null, 2) + "\n");
  }
}

/** An app asked for, by its own name however it is written: "tiktok" is TikTok. The home screen names
 *  itself nothing, which is no app's name. */
function wanted(app: string, apps: readonly string[]): boolean {
  const a = fold(app);
  return apps.some((x) => fold(x) === a);
}

const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * An element as a recording keeps it, or nothing: only what has a name or an id; a field's name and
 * never its contents; a switch's on or off and no other value; and no long text, which is people's.
 */
function kept(e: SimulatorAxElement): BenchElement[] {
  const label = e.label.trim();
  if (!label && !e.id) return [];
  if (READ_ONLY_TEXT.test(e.role) && label.length > LONG_TEXT) return [];
  const out: BenchElement = {
    id: e.path, role: e.role, label: label.length > LONG_TEXT ? `${label.slice(0, LONG_TEXT - 1)}…` : label,
    frame: [Math.round(e.frame.x), Math.round(e.frame.y), Math.round(e.frame.width), Math.round(e.frame.height)],
  };
  if (SWITCH.test(e.role) && (e.value === "0" || e.value === "1")) out.value = e.value;
  return [out];
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  const either = a.size + b.size - both;
  return either === 0 ? 1 : both / either;
}
