import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LECTURES_DIR, lecturePath, lectureTemplate, parseLectureFile, type Lecture, type StartLectureResult,
} from "@realm/contracts";
import type { SpacesStore } from "../store/spaces";
import { NotFoundError } from "../store/rows";
import type { DocumentService } from "../documents/service";
import { readIfExists, writeAtomic } from "../documents/files";
import { resolveInRoot } from "../documents/paths";

/**
 * Lectures (Plan 22 W3): dated Markdown files under `lectures/` in a space's primary checkout.
 *
 * `start` is the only write, and it is a file write: pick today's path (suffixed `-2`, `-3` when a
 * lecture with that name already exists — two sections of one course on one day is normal), write
 * the template, then hand the path to `DocumentService.openPath`, which owns the workspace, the tab
 * strip and the broadcast. This service never touches the database.
 */
export class LectureService {
  constructor(private d: { spaces: SpacesStore; documents: DocumentService; now?: () => Date }) {}

  async start(p: { spaceId: string; title: string }): Promise<StartLectureResult> {
    const space = this.d.spaces.get(p.spaceId); if (!space) throw new NotFoundError("space", p.spaceId);
    const root = this.d.documents.rootForSpace(p.spaceId);
    const date = (this.d.now ?? (() => new Date()))();
    const base = lecturePath(date, p.title);
    let rel = base;
    for (let n = 2; await readIfExists(resolveInRoot(root, rel)); n++) rel = base.replace(/\.md$/, `-${n}.md`);
    const abs = resolveInRoot(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeAtomic(abs, lectureTemplate({ course: space.name, title: p.title, date }));
    this.d.documents.noteWrite(abs, null);
    const opened = await this.d.documents.openPath({ spaceId: p.spaceId, path: rel });
    return { path: rel, ...opened };
  }

  /** Every `.md` under `lectures/`, newest date first (undated last, by name). */
  async list(spaceId: string): Promise<Lecture[]> {
    if (!this.d.spaces.get(spaceId)) throw new NotFoundError("space", spaceId);
    const root = this.d.documents.rootForSpace(spaceId);
    const dir = join(root, LECTURES_DIR);
    let names: string[];
    try { names = await readdir(dir); } catch { return []; }
    const out: Lecture[] = [];
    for (const name of names) {
      if (name.startsWith(".") || !/\.md$/i.test(name)) continue;
      const abs = join(dir, name);
      let st; try { st = await stat(abs); } catch { continue; }
      if (!st.isFile()) continue;
      // Only the head is needed for the front-matter; the transcript check wants the whole file, but
      // a lecture is small and this list is read on demand, not on every keystroke.
      const text = await readFile(abs, "utf8").catch(() => "");
      const rel = `${LECTURES_DIR}/${name}`;
      out.push({ path: rel, ...parseLectureFile(rel, text), sizeBytes: st.size });
    }
    out.sort((a, b) => {
      if (a.date && b.date && a.date !== b.date) return b.date.localeCompare(a.date);
      if (a.date && !b.date) return -1;
      if (!a.date && b.date) return 1;
      return b.path.localeCompare(a.path);
    });
    return out;
  }
}
