import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MEETINGS_DIR, type MeetingNotesFile, type MeetingNotesProgress, type MeetingSummaryOutcome, type SaveMeetingNotesParams, type SaveMeetingNotesResult } from "@realm/contracts";
import type { DocumentService } from "../documents/service";
import { writeAtomic } from "../documents/files";
import { resolveInRoot } from "../documents/paths";
import type { RpcServer } from "../rpc/server";
import {
  SUMMARY_NOT_WRITTEN, meetingNotesMarkdown, meetingNotesPath, parseSummary, summaryPrompt, summarySections, transcriptParagraphs, type MeetingSummary,
} from "./notes-file";
import { SummaryCancelled, SummaryUnavailable, type Summarise } from "./summary-turn";

const couldNotBeWritten = (reason: string): string => `The summary could not be written: ${reason.replace(/\s+/g, " ").trim().replace(/\.$/, "")}.`;

/**
 * A meeting's notes: one Markdown file under `meetings/` in the space's primary checkout, which the
 * Documents pane lists and `docs_search` reads like any other file there.
 *
 * `save` writes the file twice. First with the person's notes and the transcript, before the model is
 * asked for anything, so a summary that fails, is cancelled or never returns costs none of what was
 * said. Then the summary goes in where the first write left its one line.
 *
 * The transcript is in that file and in the one message to the model, and nowhere else: this service
 * logs nothing, and stores nothing in the database.
 */
export class MeetingNotesService {
  private summarising = new Map<string, AbortController>();

  constructor(private d: { documents: Pick<DocumentService, "rootForSpace">; rpc: Pick<RpcServer, "broadcast">; summarise: Summarise }) {}

  async save(p: SaveMeetingNotesParams): Promise<SaveMeetingNotesResult> {
    const root = this.d.documents.rootForSpace(p.spaceId);
    const meeting = { title: p.title, startedAt: p.startedAt, endedAt: p.endedAt, notes: p.notes, lines: p.lines };
    const progress = (path: string, stage: MeetingNotesProgress["stage"]) =>
      this.d.rpc.broadcast("meetings.notesProgress", { meetingId: p.meetingId, spaceId: p.spaceId, path, stage });

    if (transcriptParagraphs(p.lines).length === 0 && p.notes.trim() === "") {
      const path = await this.writeNew(root, p, meetingNotesMarkdown({ ...meeting, summary: "Nothing was said or noted, so there is no summary." }));
      progress(path, "saved");
      return { path, summary: "empty" };
    }

    const path = await this.writeNew(root, p, meetingNotesMarkdown({ ...meeting, summary: SUMMARY_NOT_WRITTEN }));
    progress(path, "summarising");
    const [outcome, summary] = await this.summaryOf(p);
    await this.putSummary(resolveInRoot(root, path), summary);
    progress(path, "saved");
    return { path, summary: outcome };
  }

  /** Every `.md` under `meetings/`. A name starts with its meeting's date and time, so names in
   *  reverse are the newest meeting first. */
  async list(spaceId: string): Promise<MeetingNotesFile[]> {
    const dir = join(this.d.documents.rootForSpace(spaceId), MEETINGS_DIR);
    const names = await readdir(dir).catch(() => [] as string[]);
    const notes: MeetingNotesFile[] = [];
    for (const name of names.sort().reverse()) {
      if (name.startsWith(".") || !name.toLowerCase().endsWith(".md")) continue;
      const file = await stat(join(dir, name)).catch(() => null);
      if (file?.isFile()) notes.push({ path: `${MEETINGS_DIR}/${name}`, modifiedAt: file.mtimeMs });
    }
    return notes;
  }

  /** Stop the summary a `save` is waiting on. False when that meeting has none in flight. */
  cancelSummary(meetingId: string): boolean {
    const abort = this.summarising.get(meetingId);
    abort?.abort();
    return abort !== undefined;
  }

  close(): void {
    for (const abort of this.summarising.values()) abort.abort();
  }

  private async summaryOf(p: SaveMeetingNotesParams): Promise<[MeetingSummaryOutcome, MeetingSummary | string]> {
    const abort = new AbortController();
    this.summarising.set(p.meetingId, abort);
    try {
      const summary = parseSummary(await this.d.summarise(summaryPrompt(p), abort.signal));
      return summary ? ["written", summary] : ["failed", couldNotBeWritten("the model's answer had no summary in it")];
    } catch (e) {
      if (e instanceof SummaryCancelled) return ["cancelled", couldNotBeWritten("it was cancelled")];
      if (e instanceof SummaryUnavailable) return ["unavailable", couldNotBeWritten("the Quick chat model is not signed in")];
      return ["failed", couldNotBeWritten(e instanceof Error && e.message ? e.message : "the model call failed")];
    } finally {
      if (this.summarising.get(p.meetingId) === abort) this.summarising.delete(p.meetingId);
    }
  }

  /** Write a file that did not exist. A second meeting with the same name and minute gets ` (2)`. */
  private async writeNew(root: string, p: SaveMeetingNotesParams, text: string): Promise<string> {
    for (let copy = 1; ; copy++) {
      const path = meetingNotesPath(new Date(p.startedAt), p.title, copy);
      const abs = resolveInRoot(root, path);
      await mkdir(dirname(abs), { recursive: true });
      try {
        // `wx` refuses a file that is already there, so two meetings saved at once cannot share one.
        await writeFile(abs, text, { flag: "wx" });
        return path;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
  }

  /** Put the summary where the first write's line is. A file whose line is gone was edited while the
   *  model wrote, and is left as the person has it. */
  private async putSummary(abs: string, summary: MeetingSummary | string): Promise<void> {
    const waiting = summarySections(SUMMARY_NOT_WRITTEN);
    const text = await readFile(abs, "utf8");
    if (!text.includes(waiting)) return;
    // A function, so a `$&` in the model's answer is text and not a replacement pattern.
    await writeAtomic(abs, text.replace(waiting, () => summarySections(summary)));
  }
}
