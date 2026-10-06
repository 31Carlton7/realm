import { Icon, type IconName } from "@realm/ui";
import { Fragment, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
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
 * A file name with the places it may wrap: after each `_`, `-`, `.` or space inside its stem. A name
 * like `NextGen_Fellows_2026_application.pdf` then wraps between its words, and the last word keeps
 * its extension — where breaking anywhere, which Codex's own tiles do, leaves "…pd" over "f".
 * `<wbr>` adds no text, so the element's own text is still the whole name.
 */
export function breakableName(name: string): ReactNode {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const parts = stem.split(/(?<=[_\-. ])/);
  return (
    <>
      {parts.map((p, i) => <Fragment key={i}>{i > 0 && <wbr />}{i === parts.length - 1 && dot > 0 ? p + name.slice(dot) : p}</Fragment>)}
    </>
  );
}

/**
 * The card: the file, as a tile.
 *
 * Its own component because of the hook: a thumbnail is per-path state, and a grid cannot ask for
 * sixty of them from inside a `map`.
 *
 * Two faces on ONE square, the way Codex's library lays them out, so the grid's shape never changes
 * from file to file. A file whose picture IS the file — a screenshot, a frame of video — is that
 * picture, edge to edge, with its name over a scrim on hover and focus. Every other file is its name
 * at the top, its glyph in the middle, and what the list knows about it at the foot. Either way the
 * button's own text is the name and that line, so a reader hears the same file whichever face it
 * wears.
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
  /** The tile's foot: whatever the list knows about the file beyond its name. */
  children?: ReactNode;
}) {
  const card = useRef<HTMLButtonElement>(null);
  const wantsPicture = type !== "folder" && THUMBNAIL_TYPES.has(type);
  const seen = useSeen(card, wantsPicture);
  const thumb = useThumbnail(wantsPicture ? path : null, "card", seen);
  return (
    // A card is a file the way a Finder icon is: Space shows it in Quick Look, and it drags out.
    <button ref={card} type="button" className="library-tile" title={title} onClick={onOpen}
      data-type={type} data-thumb={thumb ? "" : undefined}
      onKeyDown={quickLookOnSpace(path)} {...fileDragProps(path)}>
      {thumb ? (
        <>
          {/* alt="" on purpose — the name is in the caption, and a screen reader must not read the
              file twice. */}
          <img className="library-tile-thumb" src={thumb} alt="" draggable={false} />
          <span className="library-tile-caption">
            <span className="library-tile-name">{breakableName(name)}</span>
            {children}
          </span>
        </>
      ) : (
        <>
          <span className="library-tile-name">{breakableName(name)}</span>
          <span className="library-tile-art">
            {/* off-ladder: the glyph stands in for a picture across a tile up to 260px square — Codex's
                are 32pt there — and the card rung's 20 is a speck in a field that size. */}
            <span className="library-tile-mark" data-type={type}><Icon name={type === "folder" ? "folder" : TYPE_ICON[type]} size={28} /></span>
          </span>
          {children}
        </>
      )}
    </button>
  );
}

/**
 * The same file as a ROW, for the Library's list view: its mark (the picture, small, where the
 * picture is the file), its name, what the list knows, and when. One component beside the card so
 * the two views can never disagree about which files get a picture or how a file opens and drags.
 */
export function FileRow({ path, name, type, title, onOpen, time, children }: {
  path: string;
  name: string;
  type: ArtifactType;
  title: string;
  onOpen: () => void;
  /** The time of day, already worded — the list is grouped by day, so the date is the heading's. */
  time: string;
  children?: ReactNode;
}) {
  const row = useRef<HTMLButtonElement>(null);
  const wantsPicture = THUMBNAIL_TYPES.has(type);
  const seen = useSeen(row, wantsPicture);
  const thumb = useThumbnail(wantsPicture ? path : null, "tile", seen);
  return (
    <button ref={row} type="button" className="library-row" title={title} onClick={onOpen}
      onKeyDown={quickLookOnSpace(path)} {...fileDragProps(path)}>
      <span className="library-row-mark" data-type={type} data-thumb={thumb ? "" : undefined}>
        {thumb ? <img src={thumb} alt="" draggable={false} /> : <Icon name={TYPE_ICON[type]} size={16} />}
      </span>
      <span className="library-row-name">{name}</span>
      {children}
      <span className="library-row-time">{time}</span>
    </button>
  );
}
