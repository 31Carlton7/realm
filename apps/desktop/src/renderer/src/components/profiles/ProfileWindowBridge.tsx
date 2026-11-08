import { useEffect } from "react";
import { rpc } from "../../rpc/client";
import { useApp } from "../../state/store";

/**
 * Realm's windows, the renderer's half. Two jobs, and it renders nothing:
 *
 *   - Tell main which profile and which space this window shows, every time either changes. "Open in
 *     new window" for a profile or a space already on screen brings its window forward, and a space is
 *     open in at most one window — which only works if main knows what each window is showing,
 *     including the first window, which was opened for no profile and shows whichever it was last
 *     left in.
 *   - Keep `profiles` current when one is made, renamed or deleted — in this window or another: the
 *     server says so with `profiles.changed`, and every window's lists read the same rows.
 */
export function ProfileWindowBridge() {
  const profileId = useApp((s) => s.activeProfileId);
  const spaceId = useApp((s) => s.activeSpaceId);
  const refreshProfiles = useApp((s) => s.refreshProfiles);
  const run = useApp((s) => s.run);
  useEffect(() => { window.realm?.windows?.setProfile(profileId); }, [profileId]);
  useEffect(() => { window.realm?.windows?.setSpace(spaceId); }, [spaceId]);
  useEffect(() => rpc().on("profiles.changed", () => run(() => refreshProfiles())), [run, refreshProfiles]);
  return null;
}
