import { basenameOf, documentKindFor, parseFileTarget, resolveEditor } from "@realm/contracts";
import { Menu, type MenuItem } from "../../components/Menu";
import { useApp } from "../../state/store";
import { canQuickLook, canShare, quickLook, shareFile } from "../../components/file-actions";
import { capabilities } from "../../platform";

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
 * Open and Preview take the path the same way, and so reach a file an agent made OUTSIDE the space —
 * in `/tmp`, in `~/Downloads`, beside it in another checkout — which is where most of what an agent
 * generates lands. Main resolves the path (`files.resolve`: `~`, the working directory, a `file://`
 * URL, a `:42` line), and then the file goes where Realm shows that kind: a video to the player in
 * the documents pane, a document to its editor, anything else to the viewer. Before, Open sent the
 * raw string to a pane that took it as relative to the space's folder and refused everything else.
 *
 * And the editor Settings ▸ General ▸ Open files in names, when this Mac has it — for a folder as
 * much as a file, since a folder is what an editor opens as a workspace. Offered beside Realm's own
 * open rather than instead of it: the documents pane is still the one that keeps the file in the
 * space, and an editor is somewhere else entirely.
 */
export function PathMenu({ path, anchorRef, environmentId, cwd, sessionId = null, onClose }: {
  path: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  /** The session's checkout, so the pane opens against the workspace this path belongs to rather
   *  than whichever one the space happens to default to. */
  environmentId: string | null;
  /** The session's working directory — what a relative path in its transcript is relative to. */
  cwd: string | null;
  /** The session the path was written in, which a file opened from it lands beside. */
  sessionId?: string | null;
  onClose: () => void;
}) {
  const openDocumentPath = useApp((s) => s.openDocumentPath);
  const openPathInEditor = useApp((s) => s.openPathInEditor);
  const openFilesIn = useApp((s) => s.openFilesIn);
  const editors = useApp((s) => s.editors);
  const editor = resolveEditor(openFilesIn, editors);
  const openViewer = useApp((s) => s.openViewer);
  const run = useApp((s) => s.run);
  // The file and the line, without the `:42` or the `file://` the agent wrote round it.
  const target = parseFileTarget(path) ?? { path, line: null };
  const name = basenameOf(target.path);
  // A trailing slash, or a name with no extension, is a folder as far as an offer goes. Being wrong
  // in this direction costs nothing: the Finder handles both, and the open below reports honestly.
  const looksLikeFile = !target.path.endsWith("/") && name.includes(".");
  const editable = looksLikeFile && documentKindFor(target.path) !== "unsupported";
  const missing = () => new Error(`Nothing is at ${path}. It may have been moved or deleted.`);
  const open = () => run(async () => {
    const resolve = window.realm?.files?.resolve;
    // No bridge (a test, the web build): the path goes as written, and the server says what it finds.
    const abs = resolve ? await resolve(path, cwd ?? undefined) : target.path;
    if (abs === null) throw missing();
    if (editable) {
      await openDocumentPath(abs, environmentId, null, { ...(target.line ? { line: target.line } : {}), ...(sessionId ? { beside: { sessionId } } : {}) });
    } else {
      openViewer({ files: [{ path: abs }], sessionId });
    }
  });

  const items: MenuItem[] = [
    ...(looksLikeFile ? [{
      label: editable ? `Open ${name}` : `Preview ${name}`,
      onSelect: open,
    }] : []),
    ...(editor ? [{ label: `Open in ${editor.name}`, onSelect: () => run(() => openPathInEditor(editor.id, path, cwd ?? undefined)) }] : []),
    { label: `Reveal in ${capabilities().fileManager}`, onSelect: () => run(async () => {
      const revealed = await window.realm?.files?.reveal?.(path, cwd ?? undefined);
      if (revealed === false) throw missing();
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
