import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  importedLectureHeader, importedLecturePath, parsePlynnFilename,
  type PlynnImportResult, type PlynnMeeting,
} from "@realm/contracts";
import type { SettingsStore } from "../store/settings";
import type { SpacesStore } from "../store/spaces";
import { NotFoundError, RpcError } from "../store/rows";
import type { DocumentService } from "../documents/service";
import { readIfExists, writeAtomic } from "../documents/files";
import { resolveInRoot } from "../documents/paths";

/**
 * The Plynn handoff (Plan 22 W4).
 *
 * Plynn (the user's local dictation app) records a lecture in meeting mode and, when the recording
 * stops, writes ONE Markdown file — its summary, a rule, the transcript — to
 * `~/Library/Application Support/Plynn/Meetings/<yyyy-MM-dd HH.mm> <title>.md`. That file is the
 * whole interface. Realm lists that folder and copies chosen files under the course's `lectures/`,
 * with a front-matter header naming the source. Plynn's folder is READ-ONLY to Realm — the same
 * promise the CLI import makes about `~/.claude` — and Plynn's own SQLite store is never opened:
 * a database is a private format that changes with the app; a folder of Markdown is a contract.
 *
 * Two consequences of "the file is the interface", stated so nobody re-litigates them:
 *
 *  - There is no live transcript. Plynn writes at stop, so during a lecture the notes file in
 *    Realm is what the user types; the transcript joins it afterwards. A live feed would be a Plynn
 *    change (write the transcript periodically), and this importer would pick it up unchanged
 *    because it re-reads the file on every import.
 *  - Already-imported files are remembered by path (`plynn.imported` settings row), the same shape
 *    as the CLI import's `import.sources`: an import the user deliberately removed is not re-offered
 *    by accident, and clearing that row is how to re-import on purpose.
 */
const IMPORTED_KEY = "plynn.imported";
/** Largest recording imported; a three-hour transcript is well under a megabyte. */
export const PLYNN_MAX_BYTES = 8 * 1024 * 1024;

export function defaultPlynnMeetingsDir(home = homedir()): string {
  return join(home, "Library", "Application Support", "Plynn", "Meetings");
}

export class PlynnService {
  private readonly dir: string;
  constructor(private d: { spaces: SpacesStore; settings: SettingsStore; documents: DocumentService; meetingsDir?: string; now?: () => Date }) {
    this.dir = resolve(d.meetingsDir ?? defaultPlynnMeetingsDir());
  }

  /** Newest first. `available: false` when the folder is missing — not an error, a fact to show. */
  async list(): Promise<{ available: boolean; folder: string; meetings: PlynnMeeting[] }> {
    let names: string[];
    try { names = await readdir(this.dir); } catch { return { available: false, folder: this.dir, meetings: [] }; }
    const imported = new Set(this.d.settings.getIds(IMPORTED_KEY));
    const meetings: PlynnMeeting[] = [];
    for (const name of names) {
      if (name.startsWith(".") || !/\.md$/i.test(name)) continue;
      const file = join(this.dir, name);
      let st; try { st = await stat(file); } catch { continue; }
      if (!st.isFile()) continue;
      meetings.push({ file, ...parsePlynnFilename(name), sizeBytes: st.size, imported: imported.has(file) });
    }
    meetings.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "") || b.file.localeCompare(a.file));
    return { available: true, folder: this.dir, meetings };
  }

  async import(p: { spaceId: string; files: string[] }): Promise<PlynnImportResult> {
    const space = this.d.spaces.get(p.spaceId); if (!space) throw new NotFoundError("space", p.spaceId);
    const root = this.d.documents.rootForSpace(p.spaceId);
    const result: PlynnImportResult = { imported: [], skipped: [] };
    const imported = new Set(this.d.settings.getIds(IMPORTED_KEY));
    const now = (this.d.now ?? (() => new Date()))();
    let first: string | null = null;
    for (const file of p.files) {
      // Only files inside the meetings folder: the RPC takes absolute paths back from `list`, and
      // an absolute path from a client must not become "copy any file on disk into the space".
      if (!isAbsolute(file) || !resolve(file).startsWith(this.dir + sep)) {
        result.skipped.push({ file, reason: "not a file in Plynn's meetings folder" }); continue;
      }
      const name = file.slice(this.dir.length + 1);
      if (name.includes(sep) || !/\.md$/i.test(name)) { result.skipped.push({ file, reason: "not a meeting file" }); continue; }
      let st; try { st = await stat(file); } catch { result.skipped.push({ file, reason: "no longer exists" }); continue; }
      if (st.size > PLYNN_MAX_BYTES) { result.skipped.push({ file, reason: `larger than ${PLYNN_MAX_BYTES} bytes` }); continue; }
      const meeting = { ...parsePlynnFilename(name), file };
      const base = importedLecturePath(meeting, now);
      let rel = base;
      for (let n = 2; await readIfExists(resolveInRoot(root, rel)); n++) rel = base.replace(/\.md$/, `-${n}.md`);
      const body = await readFile(file, "utf8");
      const abs = resolveInRoot(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeAtomic(abs, importedLectureHeader({ course: space.name, meeting }) + normalizeBody(body, meeting.title));
      this.d.documents.noteWrite(abs, null);
      imported.add(file);
      result.imported.push({ file, path: rel });
      first ??= rel;
    }
    this.d.settings.set(IMPORTED_KEY, [...imported].sort());
    if (first) await this.d.documents.openPath({ spaceId: p.spaceId, path: first });
    if (result.imported.length === 0 && result.skipped.length > 0 && p.files.length === result.skipped.length) {
      throw new RpcError("INVALID_PARAMS", `nothing imported: ${result.skipped.map((s) => s.reason).join("; ")}`);
    }
    return result;
  }
}

/**
 * Plynn's body is `<notes>\n\n---\n\n## Transcript\n\n<transcript>`. The notes usually open with
 * their own `# Title`; when they do not, add one so the lecture list and the documents tab have a
 * heading to show. Nothing else is rewritten — the transcript is evidence and stays verbatim.
 */
export function normalizeBody(body: string, title: string): string {
  const trimmed = body.replace(/^\s+/, "");
  if (/^#\s/.test(trimmed)) return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
  return `# ${title}\n\n${trimmed}${trimmed.endsWith("\n") ? "" : "\n"}`;
}
