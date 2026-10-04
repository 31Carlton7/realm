import { mediaUrl } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useState } from "react";
import { useApp } from "../state/store";

/** The first letter of a name, as a person would write it — a whole character even when the name
 *  starts with one that takes two code units. */
export const initialOf = (name: string): string => [...name.trim()][0]?.toLocaleUpperCase() ?? "";

/**
 * Your face, wherever Realm shows it: the picture you chose, or until then the first letter of your
 * name on the accent's tint. The accent is the colour you picked for the app, which is the closest
 * thing Realm has to a colour of yours.
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
  const name = useApp((s) => s.userName);
  const [failed, setFailed] = useState<string | null>(null);
  if (path && failed !== path) {
    // Decorative: every place this sits is beside the name it would announce.
    return <img className="avatar" data-size={size} src={mediaUrl(path)} alt="" draggable={false} onError={() => setFailed(path)} />;
  }
  const initial = initialOf(name);
  return (
    <span className="avatar avatar-initial" data-size={size} aria-hidden="true">
      {initial || <Icon name="user" size={size === 56 ? 20 : size === 24 ? 14 : 12} />}
    </span>
  );
}
