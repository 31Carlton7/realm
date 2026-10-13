import { readFileSync } from "node:fs";
import type { FakeScript } from "@realm/adapters";

/**
 * For live checks only: script entries read from the JSON file `REALM_FAKE_SCRIPT` names, put AHEAD
 * of the scripted agent's built-in script so a check's own triggers win. A scenario lives beside the
 * harness that drives it instead of in `defaultAdapters`, which every offline dev session also runs.
 *
 * Honoured ONLY with `REALM_ENABLE_FAKE_AGENT=1`, the flag every live check boots with: without it
 * there is no scripted agent to hand the entries to. A file that cannot be read, or is not a list of
 * `{ on, emit }` entries, stops the boot — a check that silently fell back to echoes would report its
 * own script as the product misbehaving.
 */
export function harnessFakeScript(env: NodeJS.ProcessEnv = process.env): FakeScript {
  const path = env.REALM_FAKE_SCRIPT?.trim();
  if (env.REALM_ENABLE_FAKE_AGENT !== "1" || !path) return [];
  const entries: unknown = JSON.parse(readFileSync(path, "utf8"));
  const ok = Array.isArray(entries) && entries.every((e) =>
    typeof e === "object" && e !== null && typeof (e as { on?: unknown }).on === "string" && Array.isArray((e as { emit?: unknown }).emit));
  if (!ok) throw new Error(`REALM_FAKE_SCRIPT (${path}) is not a list of { on, emit } entries`);
  return entries as FakeScript;
}
