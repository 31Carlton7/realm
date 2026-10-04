import { mediaUrl } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useState } from "react";
import { useApp } from "../state/store";

/**
 * Your face, wherever Realm shows it: the picture you chose, or until then a person in a circle —
 * the picture a Mac gives an account before it has one of its own. It used to be the first letter
 * of your name, and at the foot of the rail that came to a bare "C" in the accent: no circle, so it
 * read as a stray glyph rather than as you.
 *
 * The picture is the server's COPY under the Realm home (`avatar.set`), loaded through
 * `realm-media://` like any other local image — the file you originally picked is never named here.
 * A copy that will not load (removed from the home by hand) falls back to the initial, not to a
 * broken-image glyph.
 *
 * Three sizes, one per place it appears: the page's head, the foot of the rail, and a menu row.
 */
export function Avatar({ size }: { size: 16 | 24 | 56 }) {
  const path = useApp((s) => s.avatarPath);
  const [failed, setFailed] = useState<string | null>(null);
  if (path && failed !== path) {
    // Decorative: every place this sits is beside the name it would announce.
    return <img className="avatar" data-size={size} src={mediaUrl(path)} alt="" draggable={false} onError={() => setFailed(path)} />;
  }
  return (
    <span className="avatar avatar-placeholder" data-size={size} aria-hidden="true">
      <Icon name="user" size={size === 56 ? 20 : size === 24 ? 14 : 12} />
    </span>
  );
}
