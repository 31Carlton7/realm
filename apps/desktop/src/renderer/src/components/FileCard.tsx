import { Icon, type IconName } from "@realm/ui";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ArtifactType } from "@realm/contracts";
import { useThumbnail } from "./use-thumbnail";
import { fileDragProps, quickLookOnSpace } from "./file-actions";

/**
 * One file, as a card — the Library's grid and a session's file browser both lay files out with
 * this, and that is the reason it lives here rather than in either of them.
 *
 * design.md: an object reached from two lists opens ONE way, and it wears one face too. A second
 * card for the session's grid would have been a second answer to "what does this screenshot look
 * like", and the two would drift the first time either was touched. What genuinely differs between
 * the lists is what they KNOW about a file, and that is the caption's second line: the Library knows
 * which session made it, a folder listing knows its size. Each list hands its own line in as
 * children; everything above that line is this component's.
 */

/** One glyph per broad type. Coarse on purpose — a file browser's icon answers "what kind of thing
 *  is this" at a glance, and thirty glyphs answer it more slowly than seven. Exported because a
 *  list ROW wears the same mark as a card: the same file must not change glyph with the layout. */
export const TYPE_ICON: Record<ArtifactType, IconName> = {
  document: "documents", image: "image", video: "video", audio: "musicNote",
  data: "table", code: "code", other: "artifact",
};

/**
 * Which files a card asks main for a picture of.
 *
 * A picture instead of a glyph is worth a round trip exactly where the picture IS the file: a
 * screenshot, a mockup, a frame of video. Everything else keeps its glyph, and that is a cost
 * decision rather than a taste one — a `.css` or a `.pdf` has no in-process decoder, so main answers
 * it by spawning `qlmanage`, and a grid is dozens of cards. The preview, which is one file the user
 * deliberately opened, asks QuickLook for anything.
 */
const THUMBNAIL_TYPES = new Set<ArtifactType>(["image", "video"]);

/**
 * Whether the element has been on screen yet — and once it has, it stays so.
 *
 * The type gate above says WHICH cards may ask for a picture; this says WHEN. Asking on mount was
 * affordable while the only grid was the Library's, because its pager mounts sixty cards at a time.
 * A folder listing has no pager: it mounts everything the folder holds, up to `BROWSE_LIMIT`, so a
 * folder of four hundred screenshots would be four hundred decodes queued in main the moment the
 * grid opened — and a folder of phone photos, `.heic` files main has to hand to QuickLook, four
 * hundred child processes at once. Asking only for what has been SEEN bounds both by the screen
 * rather than by the folder, and the Library's pages get the same bound for free.
 *
 * Sticky, so scrolling a card back out never takes its picture away, and the observer is dropped
 * the moment it has answered — there is nothing left for it to say.
 */
function useSeen(ref: RefObject<Element | null>, watch: boolean): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!watch || seen || !el) return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) setSeen(true); });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, watch, seen]);
  return seen;
}

/**
 * The card: a picture over a caption.
 *
 * Its own component because of the hook: a thumbnail is per-path state, and a grid cannot ask for
 * sixty of them from inside a `map`.
 *
 * Every card opens, whatever the file is. `onOpen` is the LIST's decision, because the list is what
 * knows where a file of this kind goes — the Library opens its preview, a folder listing routes the
 * way its own rows do, and a folder card descends.
 */
export function FileCard({ path, name, type, title, onOpen, children }: {
  /** The file on disk, absolute — what a picture is minted from. */
  path: string;
  name: string;
  /** The broad type, or `folder` for a directory: a folder is not a kind of file, so it is its own
   *  answer here rather than a type the index would ever record. It is never asked for a picture. */
  type: ArtifactType | "folder";
  /** The tooltip. Each list says the path the way its own rows do. */
  title: string;
  onOpen: () => void;
  /** The caption's second line: whatever the list knows about the file beyond its name. */
  children?: ReactNode;
}) {
  const card = useRef<HTMLButtonElement>(null);
  const wantsPicture = type !== "folder" && THUMBNAIL_TYPES.has(type);
  const seen = useSeen(card, wantsPicture);
  const thumb = useThumbnail(wantsPicture ? path : null, "card", seen);
  return (
    // A card is a file the way a Finder icon is: Space shows it in Quick Look, and it drags out.
    <button ref={card} type="button" className="library-tile" title={title} onClick={onOpen}
      onKeyDown={quickLookOnSpace(path)} {...fileDragProps(path)}>
      {/* The card is a PICTURE over a caption, the way a drive lays out files: the preview field
          takes the top of the card, and the name and whatever the list knows sit under it. A picture
          fills the field edge to edge; a glyph sits in a tinted well at its centre, because a glyph
          needs the well around it to read as a mark at all and a picture is the subject.
          `data-thumb` is what the stylesheet keys the two treatments on. */}
      <span className="library-tile-art" data-type={type} data-thumb={thumb ? "" : undefined}>
        {/* alt="" on purpose — the name is right under it, and a screen reader must not read the
            file twice. */}
        {thumb ? <img className="library-tile-thumb" src={thumb} alt="" draggable={false} />
          : <span className="library-tile-mark" data-type={type}><Icon name={type === "folder" ? "folder" : TYPE_ICON[type]} size={20} /></span>}
      </span>
      <span className="library-tile-text">
        <span className="library-tile-name">{name}</span>
        {children}
      </span>
    </button>
  );
}
