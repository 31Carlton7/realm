export type AssistantAutoStartDeps = {
  /** MeetingWatch's `watchCalls`: the microphone is watched only while this is on. */
  watchCalls: (on: boolean) => void;
  /** The first-run sheet was accepted (`MEETING_CONSENT_KEY`), read at each start. */
  consented: () => Promise<boolean>;
  listening: () => boolean;
  /** Opens the panel, leaving the keyboard with the app in front, and tells its page to Start, the
   *  same Start as the button. */
  start: () => void;
};

/**
 * "Start the assistant when a call starts": a calendar meeting starting, or a calling app taking the
 * microphone, opens the panel and starts listening. Nothing happens before the first-run sheet has
 * been accepted once, or while a run is already listening.
 */
export class AssistantAutoStart {
  private on = false;

  constructor(private readonly deps: AssistantAutoStartDeps) {}

  /** The setting is on: a call starting opens the panel, so it is kept made. */
  get enabled(): boolean { return this.on; }

  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.deps.watchCalls(on);
  }

  async callStarted(): Promise<void> {
    if (!this.on || this.deps.listening()) return;
    const consented = await this.deps.consented().catch(() => false);
    // The setting may have been turned off while the consent was read.
    if (!consented || !this.on || this.deps.listening()) return;
    this.deps.start();
  }
}
