import { z } from "zod";
import { IdSchema } from "./ids";

/**
 * Plan 12 W2 — where a skill, MCP server, or memory doc is **defined** (the User-vs-Workspace settings
 * pattern: VS Code user/workspace, GitHub org/repo, mapped onto Realm's Profile → Space hierarchy).
 *
 * - `{ kind: "space", spaceId }` — defined in one space; visible and effective there only, under that
 *   system's own enable polarity (skills: disabled-set, default on; MCP servers: enabled-set, default
 *   off — see each service for why the polarities differ).
 * - `{ kind: "space", spaceId: null }` — a **pre-scoping row**. Everything that existed before this
 *   model migrates here: visible in every space, per-space enable state exactly as before. This is what
 *   makes the migration a no-op on every space's effective set — no row is guessed into a space it
 *   might not belong to.
 * - `{ kind: "profile", profileId }` — defined at the profile; **inherited** by every space of that
 *   profile (and no space of any other profile). Inherited items are ON by default and toggleable per
 *   space via a per-space disable override; they are never editable from the inheriting space — editing
 *   happens at the defining scope, and promote/demote move the defining scope itself.
 */
export const ItemScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("space"), spaceId: IdSchema.nullable() }),
  z.object({ kind: z.literal("profile"), profileId: IdSchema }),
]);
export type ItemScope = z.infer<typeof ItemScopeSchema>;

/** The pre-scoping default: defined at space level, in no particular space (visible everywhere). */
export const LEGACY_SPACE_SCOPE: ItemScope = { kind: "space", spaceId: null };
