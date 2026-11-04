/**
 * When the person has started talking and when they have finished, from the microphone's level.
 *
 * Hands-free, a turn starts once the level has stood clear of the room's noise for a moment and ends
 * after a pause (`endOfTurnMs`, about 700 ms). While Realm is talking the bar to start is higher and
 * longer, because what is left of its own voice after echo cancellation must not read as the person
 * interrupting. Held, push-to-talk starts the turn at the press and ends it at the release, whatever
 * the level says. Muted, nothing but push-to-talk starts one.
 *
 * Pure and clocked by its caller, so every timing here is testable without a microphone.
 */

export type TurnConfig = {
  /** Silence after speech that ends the turn. */
  endOfTurnMs: number;
  /** How long the level must stay up before it counts as speech. */
  onsetMs: number;
  /** The same while Realm is talking: long enough that a cough or an echo does not cut it off. */
  bargeOnsetMs: number;
  /** The quietest level that can ever count as speech (RMS, 0–1). */
  minLevel: number;
  /** How far above the room's noise speech has to stand. */
  ratio: number;
  /** The same while Realm is talking. */
  bargeRatio: number;
};

export const DEFAULT_TURN: TurnConfig = { endOfTurnMs: 700, onsetMs: 120, bargeOnsetMs: 260, minLevel: 0.01, ratio: 3, bargeRatio: 5 };

/** The room's noise, as first assumed before any frame has been measured. */
const INITIAL_FLOOR = 0.004;
/** The first moments are spent learning the room, not listening for a turn: a fan already running
 *  when voice mode opened would otherwise be the first thing it heard. Capped, so someone who starts
 *  talking at once is not taken for the room. */
const WARM_UP_MS = 300;
const WARM_UP_FLOOR_CAP = 0.02;

export type TurnEvent =
  /** The person started talking. `barge` when Realm was talking at the time. */
  | { type: "start"; barge: boolean }
  /** The turn is over: send what was heard. */
  | { type: "end" }
  /** The turn is abandoned: drop what was heard. */
  | { type: "cancel" };

export type FrameContext = { talking: boolean; muted: boolean };

export class TurnTaker {
  private speaking = false;
  private held = false;
  private floor = INITIAL_FLOOR;
  private aboveSince: number | null = null;
  private lastVoice = 0;
  private firstFrame: number | null = null;

  constructor(private config: TurnConfig = DEFAULT_TURN) {}

  configure(config: TurnConfig): void { this.config = config; }

  /** One measurement of the microphone: its RMS level at `now` (ms). */
  frame(level: number, now: number, ctx: FrameContext): TurnEvent[] {
    if (this.held) return [];
    const c = this.config;
    if (ctx.muted) {
      this.aboveSince = null;
      if (!this.speaking) return [];
      this.speaking = false;
      return [{ type: "cancel" }];
    }
    this.firstFrame ??= now;
    if (now - this.firstFrame < WARM_UP_MS) {
      this.floor = Math.min(WARM_UP_FLOOR_CAP, this.floor + (level - this.floor) * 0.3);
      return [];
    }
    const threshold = Math.max(ctx.talking ? c.minLevel * 2 : c.minLevel, this.floor * (ctx.talking ? c.bargeRatio : c.ratio));
    if (this.speaking) {
      // Hysteresis: a word trailing off is still the turn.
      if (level > threshold * 0.6) this.lastVoice = now;
      else if (now - this.lastVoice >= c.endOfTurnMs) { this.speaking = false; return [{ type: "end" }]; }
      // A noise that began mid-turn and never stops is the room changing, not a person talking for
      // ever: the floor creeps towards it, and the turn ends once it stands under it.
      if (!ctx.talking) this.floor += (level - this.floor) * 0.002;
      return [];
    }
    if (level > threshold) {
      this.aboveSince ??= now;
      if (now - this.aboveSince >= (ctx.talking ? c.bargeOnsetMs : c.onsetMs)) {
        this.speaking = true;
        this.lastVoice = now;
        this.aboveSince = null;
        return [{ type: "start", barge: ctx.talking }];
      }
      return [];
    }
    this.aboveSince = null;
    // The room's noise: followed down at once, up slowly, and never while Realm is talking, whose
    // echo is not the room.
    if (!ctx.talking) this.floor += (level - this.floor) * (level < this.floor ? 0.3 : 0.02);
    return [];
  }

  /** Push-to-talk pressed. */
  press(talking: boolean): TurnEvent[] {
    if (this.held) return [];
    this.held = true;
    this.aboveSince = null;
    if (this.speaking) return [];
    this.speaking = true;
    return [{ type: "start", barge: talking }];
  }

  /** Push-to-talk released: the turn ends here, however the person trailed off. */
  release(): TurnEvent[] {
    if (!this.held) return [];
    this.held = false;
    if (!this.speaking) return [];
    this.speaking = false;
    return [{ type: "end" }];
  }
}
