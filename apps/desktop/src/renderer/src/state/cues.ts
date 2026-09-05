/**
 * The sound cues, and the one table that says which feed rows earn one.
 *
 * Cues are synthesised by cuelume (github.com/Danilaa1/cuelume, MIT © Daniel Belyi) — no audio files,
 * one lazily-created `AudioContext`, every tone built from oscillators the moment it plays. Two
 * shipped WAVs would have cost more bytes than the whole library and would still have needed a
 * decoder, a loader and a cache; a synthesiser needs a function call.
 *
 * **cuelume's `bind()` is never called.** It wires every `data-cuelume-*` attribute for presses,
 * releases, toggles and hovers, which would put a sound on ordinary UI interaction. Only `play` is
 * used, and only from the sites below.
 */
import { DEFAULT_NOTIFICATION_SOUND_VOLUME, type NotificationCategory } from "@realm/contracts";

/** cuelume's own names for the two recipes Realm uses. */
export type CueName = "ready" | "chime";

/**
 * Which surfaced rows earn a sound, grouped by what they MEAN rather than by category:
 *
 * - `ready` — a thing you set going has finished and is waiting for you.
 * - `chime` — a thing you set going has STOPPED, and cannot go on until you decide something.
 *
 * `session_done` fires for error settles as well as clean ones, and the row carries no status to
 * tell them apart — only prose in `body`. `ready` is chosen because it stays true either way: the
 * turn is over and the session is yours again, however it ended. Splitting it would mean matching on
 * that prose.
 *
 * Absent deliberately: `mcp_health`, `agent_probe`, `budget`, `worktree_hazard`. Each is a fact about
 * the machine that its toast already carries, and none is a person being called back to do
 * something — a sound on every category is how an app becomes one you mute.
 */
export const CUE_BY_CATEGORY: Partial<Record<NotificationCategory, CueName>> = {
  session_done: "ready",
  run_done: "ready",
  review_done: "ready",
  permission: "chime",
  run_blocked: "chime",
};

/** Read a stored volume. Out-of-range and unreadable values fall back to the default rather than
 *  clamping to silence — a preference nobody could read is not a preference for no sound. */
export const cueVolume = (raw: unknown): number =>
  typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_NOTIFICATION_SOUND_VOLUME;
