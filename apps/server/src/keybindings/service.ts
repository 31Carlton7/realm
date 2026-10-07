import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_KEYBINDINGS, KEYBINDINGS_FILE, KeybindingSchema, mergeDefaults, normalizeKeyChord,
  type Keybinding, type KeybindingsFile,
} from "@realm/contracts";

/**
 * `<REALM_HOME>/keybindings.json` — the one thing in this feature that touches disk.
 *
 * A file rather than a settings row, for the reason `~/Realm/themes` and `~/Realm/skills` are folders:
 * a keymap is something you hand-edit in your editor, diff, copy to another Mac, and keep in a
 * dotfiles repo. A row in SQLite is none of those. The cost of that choice is that the file can come
 * back malformed, which is the case this class exists to survive.
 *
 * Three rules:
 *
 *  1. **A malformed file never brings the app up without shortcuts, and never gets overwritten.**
 *     Realm falls back to the shipped defaults IN MEMORY and reports the parse error; the bytes on
 *     disk are left exactly as the user left them. Rewriting a file someone is halfway through
 *     editing — to "repair" it — destroys the only copy of what they were trying to say, and they
 *     would find out by noticing their shortcuts had reverted.
 *  2. **Newly shipped defaults are added, never re-imposed.** `mergeDefaults` skips any default whose
 *     command OR key the file already claims, so a rebinding is never fought by a default coming back
 *     next release. The merge is written to disk when it changes anything, because the file is also
 *     the documentation of what is bindable.
 *  3. **One bad rule is one rule, not the file.** An entry that is not a rule is dropped and named in
 *     the error; the other twenty keep working. Only a file that is not a JSON array at all is a
 *     total loss, because then there are no entries to salvage.
 */
export type KeybindingsDeps = {
  home: string;
  /** What Realm ships. Overridable only so tests can drive the merge with a two-rule table instead of
   *  the whole shipped one; production passes nothing. */
  defaults?: readonly Keybinding[];
  /** Where a parse error goes as well as into the answer. Injected rather than `console.error`d so a
   *  test can assert the file was reported and not silently swallowed. */
  onLog?: (line: string) => void;
};

export const keybindingsPath = (home: string): string => join(home, KEYBINDINGS_FILE);

export class KeybindingsService {
  readonly path: string;
  constructor(private d: KeybindingsDeps) { this.path = keybindingsPath(d.home); }

  private get defaults(): readonly Keybinding[] { return this.d.defaults ?? DEFAULT_KEYBINDINGS; }

  /**
   * The rules in force, seeding or merging the file as a side effect.
   *
   * Read is the write path on purpose: there is no separate "install" step that could be skipped on a
   * home restored from a backup, or on the first boot after a release that added a command. Every
   * client asking what the bindings are is also the moment Realm brings the file up to date.
   */
  read(): KeybindingsFile {
    if (!existsSync(this.path)) return this.persist([...this.defaults], null);

    let raw: string;
    try { raw = readFileSync(this.path, "utf8"); }
    catch (e) { return this.fallback(`could not be read (${message(e)})`); }

    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (e) { return this.fallback(`is not valid JSON (${message(e)})`); }
    if (!Array.isArray(parsed)) return this.fallback("is not a JSON array of rules");

    const problems: string[] = [];
    const existing: Keybinding[] = [];
    for (const [i, entry] of parsed.entries()) {
      const rule = KeybindingSchema.safeParse(entry);
      if (!rule.success) { problems.push(`rule ${i + 1} is not a keybinding`); continue; }
      // A key that will not parse can never fire, so it is named here rather than left as a rule the
      // user can see, can read, and will never be able to press. It is KEPT, not dropped: it is what
      // they wrote, and the fix is to correct that line rather than to have Realm delete it.
      if (normalizeKeyChord(rule.data.key) === null) problems.push(`rule ${i + 1} (${rule.data.command || "unbind"}) has an unrecognised key “${rule.data.key}”`);
      existing.push(rule.data);
    }

    const merged = mergeDefaults(existing, this.defaults);
    const error = problems.length === 0 ? null : `${KEYBINDINGS_FILE}: ${problems.join("; ")}`;
    if (error !== null) this.d.onLog?.(`[keybindings] ${error}`);
    /* Written back only when the merge added something AND the file was wholly understood. The first
       half is because a read that rewrites an unchanged file touches its mtime every boot, which is
       noise in a dotfiles repo and a lie to anything watching. The second is rule 1 again, in its
       quieter form: writing a merged file here would drop the very entry we just complained about,
       so the user's typo would be silently deleted by the release that happened to add a default. */
    const changed = merged.length !== existing.length;
    return changed && error === null ? this.persist(merged, null) : { path: this.path, rules: merged, error };
  }

  /**
   * Replace the file with `rules`, as a settings UI would.
   *
   * The rules are stored exactly as given — no normalising of `key`, no sorting, no deduplication.
   * Order IS precedence (the last matching rule wins), so a sort here would silently re-rank the
   * user's overrides, and rewriting their spellings would mean a file that never reads back the way
   * they typed it. Both are the editor deciding it knows better than the author.
   */
  write(rules: readonly Keybinding[]): KeybindingsFile {
    return this.persist([...rules], null);
  }

  /** Back to what Realm ships, discarding the file. The one operation that is allowed to destroy the
   *  user's rules, because it is the one they asked for by name. */
  reset(): KeybindingsFile {
    return this.persist([...this.defaults], null);
  }

  private persist(rules: Keybinding[], error: string | null): KeybindingsFile {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(rules, null, 2)}\n`);
    return { path: this.path, rules, error };
  }

  /** Rule 1: usable shortcuts, a sentence saying why they are not the user's, and the file untouched. */
  private fallback(why: string): KeybindingsFile {
    const error = `${KEYBINDINGS_FILE} ${why} — falling back to Realm's defaults. Your file has been left alone; fix it and restart, or reset keybindings to overwrite it.`;
    this.d.onLog?.(`[keybindings] ${error}`);
    return { path: this.path, rules: [...this.defaults], error };
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
