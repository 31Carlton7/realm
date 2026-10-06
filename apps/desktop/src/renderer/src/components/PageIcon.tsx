import { Icon, type IconName } from "@realm/ui";
import { useState } from "react";
import type { Item } from "@realm/contracts";
import { TerminalMark } from "./ProgramMark";

/**
 * A page's own icon where Realm has one — a browser's tab, its sidebar row, a page in the history —
 * and the glyph it stands in for where it has none, or where the picture will not draw.
 *
 * Only ever a `data:` image: main fetched the icon on the pane's own session and handed over the
 * bytes, so drawing one makes no request from this window (its CSP admits no remote image), and a
 * value that is anything else draws the glyph. A picture that fails to decode draws the glyph too —
 * never a broken image — and the same picture is not tried again until it changes.
 */
export function PageIcon({ src, fallback, size }: { src: string | undefined; fallback: IconName | Item["kind"]; size: number }) {
  const [broken, setBroken] = useState<string | null>(null);
  if (!src || !src.startsWith("data:image/") || src === broken) return <Icon name={fallback} size={size} />;
  return <img className="page-icon" src={src} width={size} height={size} alt="" draggable={false} onError={() => setBroken(src)} />;
}

/** An item's mark: a browser's page icon once its page has offered one, a terminal's program while
 *  one runs in it (ProgramMark), and the kind's glyph otherwise. */
export function ItemIcon({ item, size }: { item: Item; size: number }) {
  if (item.kind === "terminal") return <TerminalMark terminalId={item.refId} size={size} />;
  return <PageIcon src={item.kind === "browser" ? item.favicon : undefined} fallback={item.kind} size={size} />;
}
