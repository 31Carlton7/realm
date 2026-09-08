import { basenameOf, documentKindFor } from "@realm/contracts";
import { Menu, type MenuItem } from "../../components/Menu";
import { useApp } from "../../state/store";

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
 */
export function PathMenu({ path, anchorRef, environmentId, onClose }: {
  path: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  /** The session's checkout, so the pane opens against the workspace this path belongs to rather
   *  than whichever one the space happens to default to. */
  environmentId: string | null;
  onClose: () => void;
}) {
  const openDocumentPath = useApp((s) => s.openDocumentPath);
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
    { label: "Reveal in Finder", onSelect: () => { void window.realm?.files?.reveal?.(path); } },
    { kind: "separator" } as MenuItem,
    { label: "Copy path", onSelect: () => { void navigator.clipboard.writeText(path); } },
  ];
  return <Menu items={items} anchorRef={anchorRef} onClose={onClose} label={path} />;
}

/** The anchor a menu opened from a path needs. The clicked element lives inside prose React does not
 *  own (the markdown is set imperatively), so it cannot be a ref — this wraps it as one. */
export const asRef = (el: HTMLElement): React.RefObject<HTMLElement | null> => ({ current: el });
