import { useEffect, useState, type FormEvent } from "react";
import { useApp } from "../../state/store";
import { ALLOWLIST_GUARDRAIL_NOTE, parseOriginInput } from "../../panes/browser/browser-client";

/**
 * The per-space browser origin allowlist's editor (Plan 14 W4) — the Connections tab's "Browser
 * origins" section, next to the MCP servers the same tab already owns.
 *
 * The posture is a real choice, surfaced as one: **All origins** is `null` in settings (W1's default,
 * no list configured) and **Only listed** is an array — including the honest-but-blocking empty one,
 * which the hint calls out rather than papering over. Entries are validated as ORIGINS, not URLs
 * (`parseOriginInput`), because that is exactly what the enforcement compares. Writes go through
 * `setBrowserAllowlist`, which persists the setting AND re-fences every live browser view of the
 * space in place — the guarantee this section's copy leans on.
 */
export function BrowserOrigins({ spaceId }: { spaceId: string }) {
  const list = useApp((s) => s.browserAllowlists[spaceId]);
  const refreshBrowserAllowlist = useApp((s) => s.refreshBrowserAllowlist);
  const setBrowserAllowlist = useApp((s) => s.setBrowserAllowlist);
  const run = useApp((s) => s.run);
  const [draft, setDraft] = useState("");
  const [rejected, setRejected] = useState<string | null>(null);

  useEffect(() => { run(() => refreshBrowserAllowlist(spaceId)); }, [spaceId, refreshBrowserAllowlist, run]);

  const fetched = list !== undefined;
  const listed = list ?? [];
  const allOrigins = list === null;

  const add = (e: FormEvent) => {
    e.preventDefault();
    const origin = parseOriginInput(draft);
    // Origins, not URLs: a stored path would silently widen to the whole origin, so it is refused
    // here with the normalized form the field expects — never quietly rewritten.
    if (origin === null) { setRejected(draft.trim() || "an empty entry"); return; }
    setRejected(null);
    setDraft("");
    run(() => setBrowserAllowlist(spaceId, [...new Set([...listed, origin])].sort()));
  };
  const remove = (origin: string) => run(() => setBrowserAllowlist(spaceId, listed.filter((o) => o !== origin)));

  return (
    <div className="field">
      <span>Browser origins</span>
      <p className="settings-hint">Where this space's browser panes may navigate. Changes apply to open panes immediately.</p>
      {!fetched ? <p className="env-empty">Loading…</p> : (
        <>
          <fieldset className="settings-tabs" aria-label="Browser origin posture">
            <label className="settings-tab" data-selected={allOrigins || undefined}>
              <input type="radio" name={`browser-origins-${spaceId}`} value="all" checked={allOrigins}
                onChange={() => run(() => setBrowserAllowlist(spaceId, null))} />
              All origins
            </label>
            <label className="settings-tab" data-selected={!allOrigins || undefined}>
              <input type="radio" name={`browser-origins-${spaceId}`} value="listed" checked={!allOrigins}
                onChange={() => run(() => setBrowserAllowlist(spaceId, listed))} />
              Only listed
            </label>
          </fieldset>
          {allOrigins
            ? <p className="settings-hint">All origins — no list is configured, and browser panes can go anywhere.</p>
            : (
              <>
                {listed.length === 0
                  ? <p className="settings-hint">No origins listed — browser panes can't go anywhere until one is added (or the posture goes back to All origins).</p>
                  : (
                    <ul className="env-list">
                      {listed.map((o) => (
                        <li key={o} className="env-row">
                          <div className="env-main"><span className="env-name">{o}</span></div>
                          <div className="env-actions">
                            <button type="button" className="btn-quiet" onClick={() => remove(o)}>Remove</button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                <form className="origin-add" onSubmit={add}>
                  <input aria-label="Origin to allow" value={draft} placeholder="https://example.com"
                    onChange={(e) => { setDraft(e.target.value); setRejected(null); }} />
                  <button type="submit" className="btn-quiet">Add origin</button>
                </form>
                {rejected !== null && (
                  <p className="settings-hint" role="alert">Not an origin: {rejected}. Enter scheme and host only — like https://example.com or http://localhost:3000 — with no path.</p>
                )}
              </>
            )}
        </>
      )}
      <p className="settings-note">{ALLOWLIST_GUARDRAIL_NOTE}</p>
    </div>
  );
}
