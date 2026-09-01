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
 */
export const NOTIFICATION_CATEGORIES = ["permission", "session_done", "mcp_health", "agent_probe", "worktree_hazard"] as const;
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
