/**
 * Realm's sessions, as the office's agents.
 *
 * The engine keeps one character per agent and is driven by a handful of calls — add, remove, is it
 * active, what tool is it holding, is it blocked. Realm already knows all five for every session, so
 * this is a reconcile between two sets rather than a translation: work out what changed since the
 * last frame and make exactly those calls.
 *
 * Kept pure and separate from the canvas for the usual reason — the mapping is the part with
 * judgment in it (which status is "working", what a blocked agent looks like), and judgment is what
 * a test should be able to reach without a DOM.
 */

/** What the office needs to know about one Realm session. A narrow view on purpose: the office has
 *  no business with transcripts, models or costs, and a wider type here would invite it to grow one. */
export type OfficeAgent = {
  /** The session id. Stable across frames; the office's own ids are derived from it. */
  id: string;
  /** Realm's live status. Only these four reach the office — a session nobody is watching is not
   *  drawn, and `ended` is a session whose process is gone. */
  status: "running" | "waiting_permission" | "error" | "idle";
  /** The tool the agent is holding right now, if Realm has heard one — `Bash`, `Edit`, `Grep`. What
   *  makes a character type rather than idle. Null when nothing has been heard. */
  tool: string | null;
  /** The folder it runs in, which is how upstream biases seating. Absent is fine. */
  folder?: string;
};

/** The slice of `OfficeState` this bridge drives. An interface rather than the class so a test can
 *  record the calls, and so the vendored engine can be re-synced without this file following it. */
export interface OfficeAgentSink {
  addAgent(id: number, preferredPalette?: number, preferredHueShift?: number, preferredSeatId?: string,
           skipSpawnEffect?: boolean, folderName?: string, nearAgentId?: number): void;
  removeAgent(id: number): void;
  setAgentActive(id: number, active: boolean): void;
  setAgentTool(id: number, tool: string | null): void;
  showPermissionBubble(id: number): void;
  clearPermissionBubble(id: number): void;
}

/** What the last reconcile left in the office, so the next one can tell what actually changed. */
export type OfficeCast = Map<string, { officeId: number; active: boolean; tool: string | null; blocked: boolean }>;

/**
 * A session id is a ULID; the engine wants a number, and a POSITIVE one — it hands negative ids to
 * sub-agents. FNV-1a over the string, masked to 31 bits and forced away from zero.
 *
 * A hash rather than a counter because the id has to survive a remount: the office is rebuilt when
 * the pane is reopened, and a counter would reseat everyone on every visit. Collisions cost two
 * agents one chair and are one in two billion; a reseat on every open is certain.
 */
export function officeIdFor(sessionId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 1) || 1);
}

/** Which of the pack's characters an agent wears. Derived from the id, so a session keeps its face
 *  across a remount for the same reason it keeps its chair. */
export function paletteFor(sessionId: string, characterCount: number): number {
  return characterCount > 0 ? officeIdFor(sessionId) % characterCount : 0;
}

/**
 * Bring the office in line with `agents`, and return the cast it now holds.
 *
 * Only differences are written. The engine's setters are cheap, but `setAgentTool` on every frame
 * would defeat the character FSM's own timers — it reads `currentTool` to decide when to stand up
 * and walk somewhere, and being told the same thing sixty times a second is not the same as being
 * told it once.
 */
export function reconcileOffice(
  office: OfficeAgentSink,
  previous: OfficeCast,
  agents: readonly OfficeAgent[],
  characterCount: number,
): OfficeCast {
  const next: OfficeCast = new Map();
  const live = new Set(agents.map((a) => a.id));

  for (const [sessionId, held] of previous) {
    if (!live.has(sessionId)) office.removeAgent(held.officeId);
  }

  for (const a of agents) {
    const held = previous.get(a.id);
    const officeId = held?.officeId ?? officeIdFor(a.id);
    if (!held) {
      office.addAgent(officeId, paletteFor(a.id, characterCount), 0, undefined, false, a.folder);
    }
    /* "Active" is the engine's word for AT YOUR DESK, not for Realm's `running` — an inactive
       character stands up and wanders the office, which is what the end of a turn looks like. A
       blocked agent has not finished anything: it is mid-turn holding a question for you, and
       sending it for a walk would say the opposite. So blocked stays seated and the bubble over its
       head is what distinguishes it. Only a failed turn is over, and only that one gets up. */
    const atDesk = a.status === "running" || a.status === "waiting_permission";
    /* The tool is what makes the character type, so it goes only while the agent is actually
       running: a blocked agent typing away under a "needs you" bubble is two claims at once. */
    const tool = a.status === "running" ? a.tool : null;
    const blocked = a.status === "waiting_permission";
    if (!held || held.active !== atDesk) office.setAgentActive(officeId, atDesk);
    if (!held || held.tool !== tool) office.setAgentTool(officeId, tool);
    if (!held || held.blocked !== blocked) {
      if (blocked) office.showPermissionBubble(officeId);
      else office.clearPermissionBubble(officeId);
    }
    next.set(a.id, { officeId, active: atDesk, tool, blocked });
  }
  return next;
}
