import { formatAttachmentSize, LIBRARY_ADD_MAX, MAX_ATTACHMENT_BYTES, type LibraryAddResult } from "@realm/contracts";
import type { ToastInput } from "./toasts";

/**
 * What adding files to the Library tells the person, as data: the toasts an add ends in, and the offer
 * a dropped folder becomes.
 *
 * An add is something that already happened, so what it says is a toast (design.md) — one for what came
 * in, one for what was already there, one for what was refused and why — never one per file, because a
 * drop of forty files is forty toasts of one sentence each. A folder is the exception: its files are
 * not copied until asked, and a question is not a toast, so that comes back as an offer for the page.
 *
 * Pure, so every sentence is tested without a window.
 */

type FolderNote = LibraryAddResult["folders"][number];

/** "a.png", "a.png and b.pdf", "a.png, b.pdf and 3 more" — a list of names as a person reads one. */
export function nameList(names: readonly string[], shown = 3): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= shown) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.slice(0, shown - 1).join(", ")} and ${names.length - shown + 1} more`;
}

const files = (n: number): string => (n === 1 ? "1 file" : `${n} files`);

/** The toasts an add ends in, in the order they happened to the files. */
export function libraryAddNotices(r: LibraryAddResult): ToastInput[] {
  const out: ToastInput[] = [];
  if (r.added.length > 0) {
    const what = r.added.length === 1 ? r.added[0]!.name : files(r.added.length);
    // A copy that took another name says so: the person looks for the name they chose.
    const renamed = r.renamed.length === 0 ? ""
      : r.renamed.length === 1 ? ` ${r.renamed[0]!.from} is kept as ${r.renamed[0]!.to}, beside the file of that name already there.`
      : ` ${r.renamed.length} are kept under new names, beside the files of their names already there.`;
    out.push({ tone: "success", text: `Added ${what} to the Library.${renamed}` });
  }
  const dups = r.skipped.filter((s) => s.reason === "duplicate");
  if (dups.length === 1) {
    const d = dups[0]!;
    out.push({ tone: "info", text: d.existing && d.existing !== d.name ? `${d.name} is already in the Library, as ${d.existing}.` : `${d.name} is already in the Library.` });
  } else if (dups.length > 1) {
    out.push({ tone: "info", text: `Already in the Library: ${nameList(dups.map((d) => d.name))}.` });
  }
  const refused: string[] = [];
  const large = r.skipped.filter((s) => s.reason === "too-large");
  if (large.length > 0) {
    refused.push(`Too large to add — the limit is ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)}: ${nameList(large.map((s) => (s.size === null ? s.name : `${s.name} (${formatAttachmentSize(s.size)})`)))}.`);
  }
  const links = r.skipped.filter((s) => s.reason === "link");
  if (links.length > 0) {
    refused.push(`${nameList(links.map((s) => s.name))} ${links.length === 1 ? "is a link" : "are links"}, which Realm doesn't follow. Add the file itself.`);
  }
  const unread = r.skipped.filter((s) => s.reason === "unreadable");
  if (unread.length > 0) refused.push(`Couldn't read ${nameList(unread.map((s) => s.name))}.`);
  if (refused.length > 0) out.push({ tone: "warning", text: refused.join(" ") });
  return out;
}

/**
 * The folders an add left alone, as what to ask about them: the ones whose files can be added, put to
 * the person as one offer, and the ones that cannot, said why at once — a folder with nothing in it to
 * add, or more than one add takes. Null offers nothing.
 */
export function folderOffer(folders: readonly FolderNote[]): { offer: FolderNote[] | null; notices: ToastInput[] } {
  const notices: ToastInput[] = [];
  const addable: FolderNote[] = [];
  for (const f of folders) {
    if (f.more) notices.push({ tone: "warning", text: `“${f.name}” holds more files than the Library takes at once (${LIBRARY_ADD_MAX}). Add the ones you want from inside it.` });
    else if (f.files === 0) notices.push({ tone: "info", text: f.subfolders > 0 ? `“${f.name}” holds only folders, so there is nothing in it to add.` : `“${f.name}” has no files in it to add.` });
    else addable.push(f);
  }
  const total = addable.reduce((n, f) => n + f.files, 0);
  if (total > LIBRARY_ADD_MAX) {
    notices.push({ tone: "warning", text: `Those folders hold ${total} files, more than the Library takes at once (${LIBRARY_ADD_MAX}). Add them one at a time.` });
    return { offer: null, notices };
  }
  return { offer: addable.length > 0 ? addable : null, notices };
}

/** The offer's sentence: what adding the folders' files would copy in, and what it leaves out. */
export function folderOfferText(offer: readonly FolderNote[]): string {
  const count = offer.reduce((n, f) => n + f.files, 0);
  const bytes = offer.reduce((n, f) => n + f.bytes, 0);
  const inside = offer.some((f) => f.subfolders > 0);
  const lead = offer.length === 1
    ? `“${offer[0]!.name}” is a folder of ${files(count)} (${formatAttachmentSize(bytes)}). Add ${count === 1 ? "it" : "them"} to the Library?`
    : `These ${offer.length} folders hold ${files(count)} (${formatAttachmentSize(bytes)}). Add them to the Library?`;
  return inside ? `${lead} The folders inside ${offer.length === 1 ? "it" : "them"} are left out.` : lead;
}

/** How many files the offer adds, for its button. */
export const offerCount = (offer: readonly FolderNote[]): number => offer.reduce((n, f) => n + f.files, 0);
