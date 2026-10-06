import type { LibraryRemoveResult, LibraryRestoreResult } from "@realm/contracts";

/**
 * What taking files out of the Library tells the person, as data.
 *
 * A removal is something that already happened, so what it says is a toast — and the toast carries the
 * way back, an Undo, which is why nothing asks first (design.md: a confirm is owed by an object a stray
 * click would cost you, and this one comes back with a click). So the sentence names what went, and
 * everything that went with it that the person would not otherwise see go: a message they sent the file
 * with, which can no longer open it, and a message they are still writing, whose chip came off.
 *
 * Pure, so every sentence is tested without a window.
 */

const files = (n: number): string => (n === 1 ? "1 file" : `${n} files`);

/** The removal's toast. `drafts` is how many prompters had the file as a chip and lost it. */
export function libraryRemoveNotice(r: Pick<LibraryRemoveResult, "removed" | "messages">, drafts = 0): string {
  const one = r.removed.length === 1;
  const said = `Removed ${one ? r.removed[0]!.name : files(r.removed.length)} from the Library.`;
  const gone: string[] = [];
  if (r.messages > 0) gone.push(`${r.messages === 1 ? "the message" : `the ${r.messages} messages`} ${one ? "it was" : "they were"} sent with`);
  if (drafts > 0) gone.push(`${gone.length > 0 ? "the one" : "the message"} you're writing`);
  return gone.length === 0 ? said : `${said} ${one ? "It's" : "They're"} gone from ${gone.join(" and ")}, too.`;
}

/** What an undo says, when it says anything: only a copy that could not go back under its own name,
 *  because a file added since has it. Back as it was is said by the list, where the file reappears. */
export function libraryRestoreNotice(r: LibraryRestoreResult): string | null {
  if (r.renamed.length === 0) return null;
  if (r.renamed.length === 1) {
    const { from, to } = r.renamed[0]!;
    return `${from} is back as ${to}, beside the file of that name added since.`;
  }
  return `${files(r.renamed.length)} are back under new names, beside the files of their names added since.`;
}
