import { basenameOf, documentKindFor, resolveEditor } from "@realm/contracts";
import { Menu, type MenuItem } from "../../components/Menu";
import { useApp } from "../../state/store";
import { canQuickLook, canShare, quickLook, shareFile } from "../../components/file-actions";

/**
 * What clicking a file path in a transcript offers.
 *
 * A menu rather than a plain open, and the reason is that "open" genuinely means two different
 * things here and the app cannot pick for you: a Markdown file the documents pane edits, and the
 * folder it sits in, are both things an agent names in the same sentence. Guessing wrong sends a
 * click somewhere it cannot come back from — a pane that says "not a file" — where a two-item menu
 * costs one keystroke and is right every time.
 *
 * Reveal in Finder is always offered, because it is the one action that works for anything: a
 * directory, a binary, a path that has since been deleted. It is also the request as it was made —
 * "have the option to open in finder".
 *
 * It goes through `files.reveal` rather than `media.reveal`, and that is a fix rather than a
 * preference: the media gate admits only what an `img`/`video`/`audio` element can decode, so this
 * menu's one universal action silently did nothing for a `.ts`, a `.json` or a folder — which is
 * nearly everything an agent names. `files.reveal` gates on existence, which is the question
 * revealing actually asks.
 *
 * The path goes as the agent wrote it, with the session's working directory beside it: main expands
 * `~/…` and resolves a relative path against that directory, which is where the agent was standing.
 * And when there is nothing there, the menu says so — a reveal that quietly does nothing reads as a
 * broken button, not as a file that moved.
 * And the editor Settings ▸ General ▸ Open files in names, when this Mac has it — for a folder as
 * much as a file, since a folder is what an editor opens as a workspace. Offered beside Realm's own
 * open rather than instead of it: the documents pane is still the one that keeps the file in the
 * space, and an editor is somewhere else entirely.
 */
export function PathMenu({ path, anchorRef, environmentId, cwd, onClose }: {
  path: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  /** The session's checkout, so the pane opens against the workspace this path belongs to rather
   *  than whichever one the space happens to default to. */
  environmentId: string | null;
  /** The session's working directory — what a relative path in its transcript is relative to. */
  cwd: string | null;
  onClose: () => void;
}) {
  const openDocumentPath = useApp((s) => s.openDocumentPath);
  const openPathInEditor = useApp((s) => s.openPathInEditor);
  const openFilesIn = useApp((s) => s.openFilesIn);
  const editors = useApp((s) => s.editors);
  const editor = resolveEditor(openFilesIn, editors);
  const run = useApp((s) => s.run);
  const name = basenameOf(path);
  // A trailing slash, or a name with no extension, is a folder as far as an offer goes. Being wrong
  // in this direction costs nothing: the Finder handles both, and the open below reports honestly.
  const looksLikeFile = !path.endsWith("/") && name.includes(".");
  const editable = looksLikeFile && documentKindFor(path) !== "unsupported";

  const items: MenuItem[] = [
    ...(looksLikeFile ? [{
      label: editable ? `Open ${name}` : `Preview ${name}`,
      onSelect: () => run(() => openDocumentPath(path, environmentId)),
    }] : []),
    ...(editor ? [{ label: `Open in ${editor.name}`, onSelect: () => run(() => openPathInEditor(editor.id, path, cwd ?? undefined)) }] : []),
    { label: "Reveal in Finder", onSelect: () => run(async () => {
      const revealed = await window.realm?.files?.reveal?.(path, cwd ?? undefined);
      if (revealed === false) throw new Error(`Nothing is at ${path}. It may have been moved or deleted.`);
    }) },
    ...(canQuickLook() ? [{ label: "Quick Look", kbd: "Space", onSelect: () => quickLook(path, cwd ?? undefined) } as MenuItem] : []),
    ...(canShare() ? [{ label: "Share…", onSelect: () => shareFile(path, anchorRef.current, cwd ?? undefined) } as MenuItem] : []),
    { kind: "separator" } as MenuItem,
    { label: "Copy path", onSelect: () => { void navigator.clipboard.writeText(path); } },
  ];
  return <Menu items={items} anchorRef={anchorRef} onClose={onClose} label={path} />;
}

/** The anchor a menu opened from a path needs. The clicked element lives inside prose React does not
 *  own (the markdown is set imperatively), so it cannot be a ref — this wraps it as one. */
export const asRef = (el: HTMLElement): React.RefObject<HTMLElement | null> => ({ current: el });
