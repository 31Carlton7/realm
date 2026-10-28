import { useEffect } from "react";
import { useApp } from "../../state/store";

/**
 * The profile's Learn from sessions switch: Realm reading quiet sessions for memory, whichever engine
 * ran them, and tidying the repo it writes. On by default; the line under it says what the switch
 * spends, because each pass is a call on the user's own account.
 */
export function MemoryLearningRow({ profileId }: { profileId: string }) {
  const on = useApp((s) => s.memoryLearning[profileId]);
  const refreshMemoryLearning = useApp((s) => s.refreshMemoryLearning);
  const setMemoryLearning = useApp((s) => s.setMemoryLearning);
  const run = useApp((s) => s.run);
  useEffect(() => { run(() => refreshMemoryLearning(profileId)); }, [profileId, refreshMemoryLearning, run]);
  // Drawn once the stored value is known: a switch shown on and then flipped off by the read would
  // claim, for a moment, something the server is not doing.
  if (on === undefined) return null;
  return (
    <div className="settings-group">
      <label className="settings-row"
        title="Realm reads what you and the agent said — never tool output — once a session has been quiet for ten minutes or is archived, and about once a week merges duplicates and drops what is stale. Every change is a commit in this repo's history, so any of it can be undone.">
        <div className="settings-row-main">
          <span className="settings-row-name">Learn from sessions</span>
          <span className="settings-row-desc">
            After a session goes quiet, Realm saves what it learned and keeps this memory tidy, using the same frontier model as your sessions, on your account.
          </span>
        </div>
        <input type="checkbox" role="switch" className="switch" aria-label="Learn from sessions"
          checked={on} onChange={(e) => run(() => setMemoryLearning(profileId, e.target.checked))} />
      </label>
    </div>
  );
}
