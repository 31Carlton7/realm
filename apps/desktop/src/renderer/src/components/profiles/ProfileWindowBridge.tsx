import { useEffect } from "react";
import { rpc } from "../../rpc/client";
import { useApp } from "../../state/store";

/**
 * A window per profile (Plan 27 Phase 2), the renderer's half. Two jobs, and it renders nothing:
 *
 *   - Tell main which profile this window shows, every time that changes. Main keeps a profile open in
 *     at most one window, and "Open in new window" for a profile already on screen brings its window
 *     forward — which only works if main knows what each window is showing, including the first
 *     window, which was opened for no profile and shows whichever it was last left in.
 *   - Keep `profiles` current when one is made, renamed or deleted — in this window or another: the
 *     server says so with `profiles.changed`, and every window's lists read the same rows.
 */
export function ProfileWindowBridge() {
  const profileId = useApp((s) => s.activeProfileId());
  const refreshProfiles = useApp((s) => s.refreshProfiles);
  const run = useApp((s) => s.run);
  useEffect(() => { window.realm?.windows?.setProfile(profileId); }, [profileId]);
  useEffect(() => rpc().on("profiles.changed", () => run(() => refreshProfiles())), [run, refreshProfiles]);
  return null;
}
