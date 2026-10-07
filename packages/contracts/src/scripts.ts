import { z } from "zod";
import { IdSchema } from "./ids";

/**
 * A named shell command attached to a space: `pnpm test`, with a name, a key binding and a terminal.
 *
 * Stored as ONE JSON blob per space in the settings KV under `scriptsKey(spaceId)` rather than in a
 * table of its own, on the same terms `reviewResultKey` sets out for a review verdict. The test is
 * whether a table would ever be QUERIED: nothing here is searched, joined, sorted by the database or
 * asked for across spaces — the only read is "this space's list, whole, in the order the user put
 * them in", and the only write is that same list back. A table would buy indexes nobody looks
 * things up by, at the price of a migration, a store and a delete-cascade.
 *
 * The cost, stated rather than hidden: nothing cascades a settings row, so deleting a space leaves
 * its `scripts:<id>` key behind. That is a few hundred bytes under an id that can never be issued
 * again, and the KV already carries the same orphan for `skills.disabled:<spaceId>` and every other
 * per-space preference. A migration to clean up dead preference keys would collect this one too.
 */
export const ScriptSchema = z.object({
  id: IdSchema,
  /** What the user calls it. Shown in the runner list and in the keybinding editor beside the key. */
  name: z.string().trim().min(1).max(80),
  /** The line handed to the shell, verbatim. Not parsed, not validated, not escaped: it is run BY a
   *  login shell in a terminal, so `pnpm test && open coverage/index.html` has to mean what it says. */
  command: z.string().trim().min(1),
  /** Where to run it. Null means the space's own folder. A relative path resolves against that folder
   *  — `apps/server` is what someone types, and resolving it against the SERVER's cwd (the other
   *  reading) would point at a directory the user never chose and cannot see. */
  cwd: z.string().nullable().default(null),
});
export type Script = z.infer<typeof ScriptSchema>;

/** A save, from a client that may not have an id yet. A null `id` creates; anything else updates that
 *  script in place, which is what keeps its `script.<id>.run` binding attached across a rename. */
export const ScriptInputSchema = ScriptSchema.omit({ id: true }).extend({ id: IdSchema.nullable().default(null) });
export type ScriptInput = z.infer<typeof ScriptInputSchema>;

/** Settings-KV key for one space's scripts. */
export const scriptsKey = (spaceId: string): string => `scripts:${spaceId}`;

/**
 * The command id a script is addressable by — `script.<id>.run`.
 *
 * The keybinding layer treats command ids as opaque strings, so this shape is a contract between the
 * two halves and nothing else may construct it by hand. Built on the script's ULID rather than its
 * name so that renaming a script does not silently break the key someone bound to it: the binding
 * stores the id, and the id is the thing that does not change.
 *
 * `.run` is a suffix rather than the whole id because a script will plausibly grow a second verb
 * (stop, open its terminal) and `script.<id>` alone would leave nowhere to put one.
 */
export const scriptCommandId = (scriptId: string): string => `script.${scriptId}.run`;

/** The script id inside a `script.<id>.run`, or null for anything else — including `script..run`, a
 *  stray `script.foo.run` from a hand-edited keymap, and a command id belonging to some other feature.
 *  The id is checked against `IdSchema` rather than a second copy of the ULID charset, which is also
 *  what makes the `[^.]+` split unambiguous. */
export function parseScriptCommandId(commandId: string): string | null {
  const m = /^script\.([^.]+)\.run$/.exec(commandId);
  return m && IdSchema.safeParse(m[1]).success ? m[1]! : null;
}
