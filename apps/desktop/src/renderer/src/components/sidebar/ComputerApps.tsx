import { useEffect } from "react";
import { useApp } from "../../state/store";

/**
 * The per-space computer-use allowed-apps list — the Connections tab's "Mac apps" section, below the
 * browser origins, since both are lists of things agents in this space may reach out to.
 *
 * Read-and-remove rather than an add field: an entry is a bundle id, which nobody knows by heart and
 * mistyping does not fail loudly — `com.apple.TextEdt` would simply never match and the user would
 * be left wondering why the card kept appearing. Entries arrive from the permission card instead,
 * where the app is the one actually in front of them and its identity comes from macOS. This is
 * where they are reviewed and taken away.
 */
export function ComputerApps({ spaceId }: { spaceId: string }) {
  const apps = useApp((s) => s.computerAllowedApps[spaceId]);
  const refresh = useApp((s) => s.refreshComputerAllowedApps);
  const setApps = useApp((s) => s.setComputerAllowedApps);
  const run = useApp((s) => s.run);

  useEffect(() => { run(() => refresh(spaceId)); }, [spaceId, refresh, run]);

  const listed = apps ?? [];
  const remove = (bundleId: string) => run(() => setApps(spaceId, listed.filter((a) => a !== bundleId)));

  return (
    <div className="field">
      <span>Mac apps</span>
      <p className="settings-hint">
        Apps agents in this space may control without asking again. An app lands here when you answer
        “Always allow” on its permission card.
      </p>
      {apps === undefined ? <p className="env-empty">Loading…</p>
        : listed.length === 0
          ? <p className="settings-hint">No apps allowed yet — every app is asked about the first time an agent tries to drive it.</p>
          : (
            <ul className="env-list">
              {listed.map((bundleId) => (
                <li key={bundleId} className="env-row">
                  <div className="env-main"><span className="env-name">{bundleId}</span></div>
                  <div className="env-actions">
                    <button type="button" className="btn-quiet" onClick={() => remove(bundleId)}>Remove</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
      <p className="settings-note">
        Removing an app takes effect at once, including in sessions that are already running. Realm,
        System Settings, password prompts and terminals can never be driven and can never be added.
      </p>
    </div>
  );
}
