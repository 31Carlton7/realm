import { z } from "zod";
import { IdSchema } from "./ids";
import { slugify } from "./documents";

/**
 * School workflows (Plan 22): lectures and the Plynn handoff.
 *
 * A **lecture** is a Markdown file under `lectures/` in a space's primary checkout — nothing more.
 * No table, no row, no item kind: the file IS the record, for the reason Plan 17 chose files for
 * documents in the first place — an agent can read and extend it with the tools it already has, the
 * documents pane shows it live, checkpoints and git cover it. What Realm adds is the naming
 * convention (so a folder of lectures sorts by date and a course's notes are findable without a
 * database) and the template (so every lecture starts with the same sections the wrap-up pass reads).
 *
 * **Plynn** is the user's local dictation app. Its meeting mode writes one Markdown file per
 * recording — the summary, a rule, then the transcript — into its own Application Support folder.
 * Realm READS that folder and never writes it, the same stance the import feature takes with
 * `~/.claude` and friends: importing copies the file under the course, and Plynn's copy stays.
 */

export const LECTURES_DIR = "lectures";
export const GUIDES_DIR = "guides";

/** `2026-09-02` for a local date. Local, not UTC: a 7pm lecture is today's lecture, not tomorrow's. */
export function localDateStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `lectures/2026-09-02-pipelining.md`, or `lectures/2026-09-02.md` when the title has no slug. */
export function lecturePath(date: Date, title: string): string {
  const slug = slugify(title);
  return `${LECTURES_DIR}/${localDateStamp(date)}${slug ? `-${slug}` : ""}.md`;
}

/**
 * The starting content for a lecture. Front-matter first so the wrap-up pass (and `docs_search`)
 * can read the course and date without parsing prose; then the sections in the order they fill up
 * during a class. "Questions" is deliberately its own heading: it is what the session answers from
 * the transcript, and what the wrap-up turns into flashcards.
 */
export function lectureTemplate(o: { course: string; title: string; date: Date }): string {
  const title = o.title.trim() || `Lecture ${localDateStamp(o.date)}`;
  return `---
course: ${yamlString(o.course)}
title: ${yamlString(title)}
date: ${localDateStamp(o.date)}
---

# ${title}

## Notes

-

## Questions

-

## Follow-ups

-
`;
}

function yamlString(s: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(s) ? s : JSON.stringify(s);
}

/** One lecture file as `lectures.list` reports it: the front-matter's title/date when present, the
 *  filename's otherwise. */
export const LectureSchema = z.object({
  /** Relative to the space's primary checkout, `/`-separated — an `openPaths` entry. */
  path: z.string(),
  title: z.string(),
  /** `YYYY-MM-DD`, or null when neither front-matter nor filename carries one. */
  date: z.string().nullable(),
  /** Whether the file has a `## Transcript` section — i.e. came from a recording. */
  hasTranscript: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
});
export type Lecture = z.infer<typeof LectureSchema>;

/** One recording in Plynn's meetings folder, as `plynn.list` reports it. */
export const PlynnMeetingSchema = z.object({
  /** Absolute path of the Markdown file — the key `plynn.import` takes back. */
  file: z.string(),
  title: z.string(),
  /** `YYYY-MM-DDTHH:MM` parsed from the filename (`yyyy-MM-dd HH.mm <title>.md`); null when the
   *  name does not follow Plynn's pattern. Local time, as Plynn wrote it. */
  startedAt: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  /** Whether Realm already imported this file somewhere (by file path). */
  imported: z.boolean(),
});
export type PlynnMeeting = z.infer<typeof PlynnMeetingSchema>;

export const PlynnImportResultSchema = z.object({
  imported: z.array(z.object({ file: z.string(), path: z.string() })),
  skipped: z.array(z.object({ file: z.string(), reason: z.string() })),
});
export type PlynnImportResult = z.infer<typeof PlynnImportResultSchema>;

/**
 * Parse Plynn's filename convention. `2026-09-02 14.05 EE 457 lecture.md` → title "EE 457 lecture",
 * startedAt "2026-09-02T14:05". Anything else → title = stem, startedAt null; still importable.
 */
export function parsePlynnFilename(name: string): { title: string; startedAt: string | null } {
  const stem = name.replace(/\.md$/i, "");
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2})\.(\d{2}) (.*)$/.exec(stem);
  if (!m) return { title: stem, startedAt: null };
  return { title: m[4]!.trim() || "Meeting", startedAt: `${m[1]}T${m[2]}:${m[3]}` };
}

/** Where an imported recording lands: `lectures/<date>-<slug>.md`, dated from the recording. */
export function importedLecturePath(meeting: { title: string; startedAt: string | null }, fallbackDate: Date): string {
  const date = meeting.startedAt ? meeting.startedAt.slice(0, 10) : localDateStamp(fallbackDate);
  const slug = slugify(meeting.title);
  return `${LECTURES_DIR}/${date}${slug ? `-${slug}` : ""}.md`;
}

/** The header Realm prepends to an imported recording so its origin is on the page, not only in a
 *  settings row. The body (Plynn's notes, a rule, the transcript) follows verbatim. */
export function importedLectureHeader(o: { course: string; meeting: { title: string; startedAt: string | null; file: string } }): string {
  return `---
course: ${yamlString(o.course)}
title: ${yamlString(o.meeting.title)}
date: ${o.meeting.startedAt ? o.meeting.startedAt.slice(0, 10) : ""}
source: plynn
source_file: ${JSON.stringify(o.meeting.file)}
---

`;
}

/**
 * Read a lecture file's front-matter title/date and whether it carries a transcript. Pure; the
 * server's `lectures.list` and the wrap-up prompt both use it, and it must not throw on a file that
 * is not a lecture at all (any `.md` under `lectures/` is listed).
 */
export function parseLectureFile(path: string, text: string): { title: string; date: string | null; hasTranscript: boolean } {
  const name = path.split("/").pop() ?? path;
  const stem = name.replace(/\.md$/i, "");
  const fromName = /^(\d{4}-\d{2}-\d{2})(?:-(.*))?$/.exec(stem);
  let title = fromName?.[2] ? fromName[2].replace(/-/g, " ") : stem;
  let date: string | null = fromName?.[1] ?? null;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text)?.[1];
  if (fm) {
    const t = /^title:\s*(.+)$/m.exec(fm)?.[1]?.trim();
    const d = /^date:\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(fm)?.[1];
    if (t) title = unquote(t);
    if (d) date = d;
  } else {
    const h1 = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
    if (h1) title = h1;
  }
  return { title, date, hasTranscript: /^##\s+Transcript\s*$/m.test(text) };
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s) as string; } catch { return s.slice(1, -1); }
  }
  return s;
}

export const StartLectureResultSchema = z.object({
  path: z.string(),
  documentsId: IdSchema,
  itemId: IdSchema,
  environmentId: IdSchema,
});
export type StartLectureResult = z.infer<typeof StartLectureResultSchema>;

/**
 * The wrap-up pass, as one message to a fresh session (Plan 22 W3). Written here rather than in the
 * renderer so it is testable and so a future server-side "wrap up on import" can send the same text.
 *
 * No `@`-mentions: a literal `@skill` must never reach an agent (see `mentions.ts`), and the skill
 * may not be enabled in this space. The prompt names the skills in prose and stands on its own
 * without them.
 */
export function lectureWrapUpPrompt(l: { path: string; title: string; date: string | null; hasTranscript: boolean }, o: { course: string }): string {
  const when = l.date ? ` (${l.date})` : "";
  return `Wrap up my lecture notes for ${o.course}: "${l.title}"${when}, in the file \`${l.path}\`.

1. Read the file. "## Notes" is what I typed during class, "## Questions" is what I want answered, "## Follow-ups" is what I said I would do.${l.hasTranscript ? ' "## Transcript" is the recording of what was said — treat it as the record and my notes as the emphasis.' : " There is no transcript; work from my notes and the course materials."}
2. Use docs_search (scope "${LECTURES_DIR}" and "${GUIDES_DIR}", then the whole folder) to connect this lecture to earlier lectures, slide decks and existing guides, and cite them by path.
3. Rewrite "## Notes" into clean, structured notes: keep my wording where it is mine, add what the lecture covered that I missed, and mark anything you are inferring rather than reading. Answer each question under "## Questions" in place. Keep "## Follow-ups" as a checklist.
4. Append "## Flashcards" with 8–15 question/answer pairs that cover the lecture's core ideas.
5. Create or extend the study guide for this topic under \`${GUIDES_DIR}/\` as a single self-contained HTML file following the study-guide skill if it is available: a short orientation, one rg-quiz section per concept with data-topic set, an rg-steps walkthrough for any procedure, math in KaTeX delimiters, and a sources footer naming the lecture file. Then call docs_open on it so I can see it.
6. Reply with a five-line summary of what changed and what I should review first.`;
}
