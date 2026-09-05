import { z } from "zod";
import { IdSchema } from "./ids";

/**
 * Notification categories (Plan 12 W5) — the kinds of things that waited on the user. A union, not
 * free text, so every surface (feed grouping, settings toggles, dedup keys) agrees on the vocabulary;
 * extensible by adding a member here and teaching NotificationsService to write it.
 *
 * - `permission`      — a session entered `waiting_permission` (one row per request; pending until the
 *                       request is answered, from ANY surface).
 * - `session_done`    — a session's turn settled (running → idle/ended/error). The server writes one for
 *                       EVERY settle — it cannot know renderer focus — and the renderer immediately marks
 *                       the row read when the settled session was the focused pane, so only unfocused
 *                       settles surface as unread. See NotificationsService's doc comment.
 * - `mcp_health`      — a hub connection entered `error`/`circuit_open`. One open row per server until
 *                       it recovers (the dedup collapse).
 * - `agent_probe`     — a CLI that probed available before now probes unavailable.
 * - `worktree_hazard` — a worktree removal or checkpoint restore was REFUSED on a stale
 *                       acknowledgement (the tree moved under an open confirmation).
 * - `review_done`     — a requested review settled (Plan 13 W3): the reviewer's verdict is on the diff
 *                       pane. Terminal like `session_done` (born acted); `refId` is the ENVIRONMENT.
 * - `run_blocked`     — a durable run stopped and wants a human (a draft to sign off, a login wall).
 *                       NON-terminal, so it rides the dedup collapse: one open row per stuck run,
 *                       resolved by `runs.approve` however the answer arrives. `refId` is the RUN.
 * - `run_done`        — a durable run reached a terminal state. Terminal like `session_done` (born
 *                       acted); `refId` is the RUN, so a retried run reuses its unread row rather
 *                       than double-counting an outcome the user never saw.
 * - `budget`          — this month's agent spend crossed one of the user's configured thresholds
 *                       (usage.ts). Terminal (born acted): a ceiling being crossed is news, not a
 *                       task. `refId` is `<YYYY-MM>:<threshold>`, so each threshold announces itself
 *                       once per calendar month and the next month starts clean — the dedup key IS
 *                       the "don't tell me again" rule, rather than a flag stored somewhere else.
 */
export const NOTIFICATION_CATEGORIES = ["permission", "session_done", "mcp_health", "agent_probe", "worktree_hazard", "review_done", "run_blocked", "run_done", "budget"] as const;
export const NotificationCategorySchema = z.enum(NOTIFICATION_CATEGORIES);
export type NotificationCategory = z.infer<typeof NotificationCategorySchema>;

/**
 * One durable feed row. `refId` is the category's own reference — a permission requestId (which may be
 * a broker-minted `bperm_…`, hence plain string), an MCP server id, an agent kind, an environment id —
 * and, paired with `category`, the dedup key. `readAt` is about the USER (they saw it);
 * `actedAt` is about the WORLD (the underlying condition resolved — permission answered, server
 * recovered). A pending permission row is exactly `category: "permission", actedAt: null`.
 */
export const NotificationSchema = z.object({
  id: IdSchema,
  category: NotificationCategorySchema,
  spaceId: IdSchema.nullable(),
  sessionId: IdSchema.nullable(),
  refId: z.string().nullable(),
  title: z.string(),
  body: z.string().nullable(),
  createdAt: z.number().int(),
  readAt: z.number().int().nullable(),
  actedAt: z.number().int().nullable(),
});
export type Notification = z.infer<typeof NotificationSchema>;

/**
 * Settings key for the per-category off switches (stored as a string[] of disabled categories —
 * default-on polarity, like the skills disabled set). GLOBAL, because the feed is global: the sidebar
 * row lives above the space section and its count spans every space. A disabled category stops NEW
 * rows only; existing rows stay listed — they happened while the category was on, and a pending
 * permission row that vanished on a toggle would hide a question an agent is still blocked on.
 * The settings UI for these toggles is W6's; the service honors the key already.
 */
export const NOTIFICATIONS_DISABLED_KEY = "notifications.disabledCategories";

/**
 * Settings key for the desktop (OS) notification switch — the feed's last hop. Boolean, default-ON
 * when absent, the same polarity the category set uses.
 *
 * It gates the OS surface ONLY: with it off the feed still fills, the sidebar pill still counts, and
 * every category toggle still means what it meant. What stops is the toast and the dock badge — the
 * two things that can interrupt a user who is not looking at Realm. Rows the categories already
 * suppressed never reach here at all, so this is a narrowing of that set, never a widening.
 */
export const NOTIFICATIONS_DESKTOP_KEY = "notifications.desktop";

/**
 * Settings keys for the audible half of a desktop notification: whether a posted toast also plays a
 * cue, and how loud (0…1). Both NARROW the desktop switch rather than standing beside it — a cue is
 * only ever played to accompany a toast main actually posted, so with `NOTIFICATIONS_DESKTOP_KEY`
 * off there is no interruption for a sound to be part of.
 *
 * Default ON, at half volume: the cue inherits an opt-in the user already made, it can only sound
 * while Realm is in the background, and a cue nobody ever hears is a cue nobody ever finds in
 * Settings to keep. Half volume because the synthesiser's own output stage is generous and a cue
 * heard hundreds of times should sit under the room, not on top of it.
 */
export const NOTIFICATIONS_SOUND_KEY = "notifications.sound";
export const NOTIFICATIONS_SOUND_VOLUME_KEY = "notifications.soundVolume";
export const DEFAULT_NOTIFICATION_SOUND_VOLUME = 0.5;
