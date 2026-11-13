/**
 * When the person has started talking and when they have finished, from the microphone's level.
 *
 * Speech starts once the level has stood clear of the room's noise for a moment, and ends after a
 * pause (`endOfTurnMs`). Pure and clocked by its caller, so every timing here is testable without a
 * microphone.
 */

export type TurnConfig = {
  /** Silence after speech that ends the turn. */
  endOfTurnMs: number;
  /** How long the level must stay up before it counts as speech. */
  onsetMs: number;
  /** The quietest level that can ever count as speech (RMS, 0–1). */
  minLevel: number;
  /** How far above the room's noise speech has to stand. */
  ratio: number;
};

export const DEFAULT_TURN: TurnConfig = { endOfTurnMs: 700, onsetMs: 120, minLevel: 0.01, ratio: 3 };

/** The room's noise, as first assumed before any frame has been measured. */
const INITIAL_FLOOR = 0.004;
/** The first moments are spent learning the room, not listening for speech: a fan already running
 *  when the microphone opened would otherwise be the first thing it heard. Capped, so someone who
 *  starts talking at once is not taken for the room. */
const WARM_UP_MS = 300;
const WARM_UP_FLOOR_CAP = 0.02;

export type TurnEvent =
  /** The person started talking. */
  | { type: "start" }
  /** They stopped for the whole pause. */
  | { type: "end" };

export class TurnTaker {
  private speaking = false;
  private floor = INITIAL_FLOOR;
  private aboveSince: number | null = null;
  private lastVoice = 0;
  private firstFrame: number | null = null;

  constructor(private readonly config: TurnConfig = DEFAULT_TURN) {}

  /** One measurement of the microphone: its RMS level at `now` (ms). */
  frame(level: number, now: number): TurnEvent[] {
    const c = this.config;
    this.firstFrame ??= now;
    if (now - this.firstFrame < WARM_UP_MS) {
      this.floor = Math.min(WARM_UP_FLOOR_CAP, this.floor + (level - this.floor) * 0.3);
      return [];
    }
    const threshold = Math.max(c.minLevel, this.floor * c.ratio);
    if (this.speaking) {
      // Hysteresis: a word trailing off is still the turn.
      if (level > threshold * 0.6) this.lastVoice = now;
      else if (now - this.lastVoice >= c.endOfTurnMs) { this.speaking = false; return [{ type: "end" }]; }
      // A noise that began mid-turn and never stops is the room changing, not a person talking for
      // ever: the floor creeps towards it, and the turn ends once it stands under it.
      this.floor += (level - this.floor) * 0.002;
      return [];
    }
    if (level > threshold) {
      this.aboveSince ??= now;
      if (now - this.aboveSince >= c.onsetMs) {
        this.speaking = true;
        this.lastVoice = now;
        this.aboveSince = null;
        return [{ type: "start" }];
      }
      return [];
    }
    this.aboveSince = null;
    // The room's noise: followed down at once, up slowly.
    this.floor += (level - this.floor) * (level < this.floor ? 0.3 : 0.02);
    return [];
  }
}
