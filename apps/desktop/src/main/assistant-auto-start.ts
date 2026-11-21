import type { CallApp, Meeting } from "./meeting-rules";

/** An app that let go of the microphone is still in the call it held for this long: a mute in an app
 *  that releases the device, or a switch of microphone, comes back as the same call. */
export const CALL_REARM_MS = 2 * 60_000;

export type AssistantAutoStartDeps = {
  /** MeetingWatch's `watchCalls`: the microphone is watched only while this is on. */
  watchCalls: (on: boolean) => void;
  /** The first-run sheet was accepted (`MEETING_CONSENT_KEY`), read at each start. */
  consented: () => Promise<boolean>;
  listening: () => boolean;
  /** `open` gives the panel the keyboard; `openInactive` leaves it with the app in front. */
  panel: { open(): void; openInactive(): void };
  /** Tells the panel's page to Start, the same Start as the button. */
  start: () => void;
  now: () => number;
};

/** What a run that ended was part of: the calls going then, and the end of the meetings started. */
type Hold = { apps: Set<string>; until: number };

/**
 * "Start the assistant when a call starts": a calendar meeting starting, or a calling app taking the
 * microphone, opens the panel and starts listening. Nothing happens before the first-run sheet has
 * been accepted once, or while a run is already listening.
 *
 * A run that ends holds: nothing starts again for a call that was going when it ended, until that
 * app has let go of the microphone for `CALL_REARM_MS`, or for a meeting that had started, until its
 * end. A call or a meeting starting while it holds becomes part of it. So a Stop is kept through
 * joining early, the meeting's own start, and a microphone let go and taken back.
 */
export class AssistantAutoStart {
  private on = false;
  private running = false;
  private hold: Hold | null = null;
  /** Each app in a call: null while it holds the microphone, else when it let go. */
  private readonly calls = new Map<string, number | null>();
  /** The latest end of a meeting that has started. */
  private meetingsUntil = 0;

  constructor(private readonly deps: AssistantAutoStartDeps) {}

  /** The setting is on: a call starting opens the panel, so it is kept made. */
  get enabled(): boolean { return this.on; }

  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.deps.watchCalls(on);
    // The microphone is no longer watched, so no call will be said to end.
    if (!on) this.calls.clear();
  }

  meetingStarted(meeting: Meeting): Promise<void> {
    this.meetingsUntil = Math.max(this.meetingsUntil, meeting.end);
    const hold = this.holding();
    if (hold) hold.until = Math.max(hold.until, meeting.end);
    return this.callStarted();
  }

  appCallStarted(app: CallApp): Promise<void> {
    // Asked before the app is marked in a call, which would make a call long over hold again.
    const hold = this.holding();
    this.calls.set(app.id, null);
    hold?.apps.add(app.id);
    return this.callStarted();
  }

  appCallEnded(app: CallApp): void {
    this.calls.set(app.id, this.deps.now());
  }

  /** Whether a run listens, from `MeetingListening`: one going from listening to not starts a hold. */
  listeningChanged(listening: boolean): void {
    if (this.running && !listening) {
      const now = this.deps.now();
      const apps = [...this.calls.keys()].filter((id) => this.inCall(id, now));
      this.hold = { apps: new Set(apps), until: this.meetingsUntil };
    }
    this.running = listening;
  }

  async callStarted(): Promise<void> {
    if (!this.on || this.deps.listening() || this.holding()) return;
    const consented = await this.deps.consented().catch(() => false);
    // The setting may have been turned off while the consent was read.
    if (!consented || !this.on || this.deps.listening()) return;
    this.deps.panel.openInactive();
    this.deps.start();
  }

  private inCall(id: string, now: number): boolean {
    const letGo = this.calls.get(id);
    if (letGo === undefined) return false;
    if (letGo === null || now - letGo < CALL_REARM_MS) return true;
    this.calls.delete(id);
    return false;
  }

  /** The hold of a run that ended, while it holds: dropped once every call and meeting it was part of is over. */
  private holding(): Hold | null {
    if (!this.hold) return null;
    const now = this.deps.now();
    if (now < this.hold.until || [...this.hold.apps].some((id) => this.inCall(id, now))) return this.hold;
    this.hold = null;
    return null;
  }
}
