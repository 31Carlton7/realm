import { ScriptInputSchema, type Script, type ScriptInput } from "@realm/contracts";

/**
 * The script editor's one rule: what the form holds is three strings, and what the server takes is a
 * `ScriptInput`. This is the crossing.
 *
 * It exists apart from the panel because the crossing is where a form lies. `ScriptInputSchema` is
 * already the authority on what a script may be — a name that is 80 characters and not 81, a command
 * that is not blank — so the editor asks IT rather than restating the same three bounds in JSX, where
 * they would drift from the contract the moment either side moved. The rejected alternative was the
 * ordinary one: disable Save until the fields "look right". A dead button says a refusal happened and
 * not which field caused it, and at 81 characters of a name nobody counts, that is the whole of what
 * the user needs to know.
 */

/** The form's own state. Strings, because that is what an `<input>` has; `id` is null for a new one. */
export type ScriptDraft = { id: string | null; name: string; command: string; cwd: string };

export function emptyDraft(): ScriptDraft {
  return { id: null, name: "", command: "", cwd: "" };
}

/** An existing script, opened for editing. The id travels so the save UPDATES rather than creates —
 *  which is what keeps a `script.<id>.run` binding attached across a rename (contracts/scripts.ts). */
export function draftFrom(script: Script): ScriptDraft {
  return { id: script.id, name: script.name, command: script.command, cwd: script.cwd ?? "" };
}

export type ScriptValidation =
  | { ok: true; input: ScriptInput }
  /** `field` is which input to point at; `message` is what to print under it. */
  | { ok: false; field: "name" | "command" | "cwd"; message: string };

export function validateScriptDraft(draft: ScriptDraft): ScriptValidation {
  const cwd = draft.cwd.trim();
  const parsed = ScriptInputSchema.safeParse({
    id: draft.id,
    name: draft.name,
    command: draft.command,
    // Blank IS null, never "". The schema takes any string for `cwd`, so an empty one would be stored
    // as a relative path of nothing — resolved against the space folder by accident rather than by the
    // rule that says a null cwd means the space folder, and printed on the row as a directory the user
    // never typed.
    cwd: cwd === "" ? null : cwd,
  });
  if (parsed.success) return { ok: true, input: parsed.data };

  const issue = parsed.error.issues[0];
  // A refusal with no issue attached cannot happen, and a form that renders nothing when it does is
  // the silent failure this whole module exists to avoid.
  if (!issue) return { ok: false, field: "name", message: "Realm could not read this script." };
  const at = issue.path[0];
  const field = at === "command" ? "command" : at === "cwd" ? "cwd" : "name";
  return { ok: false, field, message: sentenceFor(issue, field) };
}

/**
 * Realm's words for the two refusals this form can actually produce, and zod's for anything else.
 *
 * The fallback is the point: "String must contain at least 1 character(s)" is not copy Realm would
 * write, but it is true, and it names the constraint. If the schema grows a rule this function has
 * not met, printing the library's sentence is strictly better than printing a friendly one that is
 * about a different rule — and better than the third option, which is to say nothing and leave a Save
 * button that does not save.
 */
function sentenceFor(issue: { code: string; message: string; maximum?: number | bigint }, field: string): string {
  if (field === "name" && issue.code === "too_small") return "Give the script a name.";
  if (field === "name" && issue.code === "too_big") return `A name is at most ${String(issue.maximum)} characters.`;
  if (field === "command" && issue.code === "too_small") return "A script needs a command to run.";
  return issue.message;
}

/** The ids of `scripts`, with the one at `index` moved one place `by` (-1 up, +1 down) — the array
 *  `scripts.reorder` takes. Null when the move would fall off either end, so the caller renders a
 *  disabled control rather than sending a no-op write the user would read as a failure. */
export function reorderedIds(scripts: readonly Script[], index: number, by: -1 | 1): string[] | null {
  const to = index + by;
  if (index < 0 || index >= scripts.length || to < 0 || to >= scripts.length) return null;
  const ids = scripts.map((s) => s.id);
  const moved = ids[index]!;
  ids.splice(index, 1);
  ids.splice(to, 0, moved);
  return ids;
}
