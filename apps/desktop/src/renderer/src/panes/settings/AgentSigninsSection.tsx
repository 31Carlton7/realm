import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "@realm/ui";
import type { AgentFill, AgentSigninsStatus, SecurityCodesStatus, UnlockSessionHours } from "@realm/contracts";
import { relativeTime } from "../../components/CheckpointsSheet";
import { useApp } from "../../state/store";
import { turnOnSignins } from "../../state/turn-on-signins";

/**
 * Settings ▸ Sign-ins ▸ Let agents finish sign-ins: main's switch (`agent-signins.ts`) and, once it is
 * on, one row per grant an agent's sign-in can need, each saying whether it is in place and offering
 * the one step that puts it there. The switch, Security codes and the unlock are main's IPC, answered
 * only for this window's top frame, and every control carries `data-no-agent`: an agent driving
 * Realm's window is not the person these are for.
 */

const api = () => window.realm?.credentials;

type Grant = { name: string; desc: string; granted: boolean; state: string; actions?: ReactNode };

export function AgentSigninsSection({ profileId, profileName }: { profileId: string | null; profileName: string }) {
  const [status, setStatus] = useState<AgentSigninsStatus | null>(null);
  const [codes, setCodes] = useState<SecurityCodesStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void api()?.signinsStatus?.().then((s) => { if (live) setStatus(s); }, () => {});
    void api()?.codesStatus?.().then((s) => { if (live) setCodes(s); }, () => {});
    return () => { live = false; };
  }, []);
  if (!status) return null;

  const toggle = async () => {
    setBusy(true);
    try {
      if (status.enabled) { setStatus((await api()?.setSignins?.(false)) ?? status); return; }
      const on = await turnOnSignins();
      setStatus(on.signins ?? status);
      if (on.codes) setCodes(on.codes);
    } finally { setBusy(false); }
  };

  return (
    <>
      <h3 className="settings-head" data-setting="agent-signins">Let agents finish sign-ins</h3>
      <div className="settings-group agent-signins" data-no-agent="agent sign-ins">
        <div className="settings-row" title="A fill on a page of another site still asks you every time, and Plan and Ask still refuse every fill.">
          <div className="settings-row-main">
            <span className="settings-row-name">Let agents finish sign-ins</span>
            <span className="settings-row-desc">
              {status.enabled
                ? "Agents fill saved passwords on their own sites, and the codes sites send you, without asking."
                : "Agents ask you before each password fill, and fill no codes."}
            </span>
          </div>
          <input type="checkbox" role="switch" className="switch" aria-label="Let agents finish sign-ins"
            checked={status.enabled} disabled={busy} onChange={() => { void toggle(); }} />
        </div>
        {status.enabled && <SigninGrants codes={codes} setCodes={setCodes} profileId={profileId} profileName={profileName} />}
      </div>
      {status.enabled && status.fills.length > 0 && <RecentFills fills={status.fills} />}
    </>
  );
}

/** One row per grant, in the order a sign-in reaches them. */
function SigninGrants({ codes, setCodes, profileId, profileName }: {
  codes: SecurityCodesStatus | null; setCodes: (s: SecurityCodesStatus) => void; profileId: string | null; profileName: string;
}) {
  const computer = useApp((s) => s.computerAccess);
  const requesting = useApp((s) => s.computerRequesting);
  const refreshComputerAccess = useApp((s) => s.refreshComputerAccess);
  const requestComputerAccess = useApp((s) => s.requestComputerAccess);
  const openMacAccessPane = useApp((s) => s.openMacAccessPane);
  const revealRealmApp = useApp((s) => s.revealRealmApp);
  const unlock = useApp((s) => (s.credentialsProfileId === profileId ? s.unlockPolicy : null));
  const setUnlockPolicy = useApp((s) => s.setUnlockPolicy);
  const run = useApp((s) => s.run);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  useEffect(() => { run(() => refreshComputerAccess()); }, [run, refreshComputerAccess]);

  const turnOnCodes = () => { void api()?.setCodes?.(true).then((s) => { if (s) setCodes(s); }); };
  const fullDisk = (
    <>
      <button type="button" className="btn-quiet" onClick={() => run(() => openMacAccessPane("fullDiskAccess"))}>Open System Settings</button>
      <button type="button" className="btn-quiet" onClick={() => run(() => revealRealmApp())}>Show app in Finder</button>
    </>
  );
  const sources = codes?.enabled ? codes.sources : null;
  const messages = sources?.Messages ?? null;
  const mail = sources?.Mail ?? null;
  const notifications = sources?.Notifications ?? null;

  const codesGrant: Grant = !codes?.enabled
    ? { name: "Read sign-in codes from Messages and Mail", desc: "Lets agents fill the code a site texts or emails you. Realm finds the code and types it, and the agent never sees it.",
        granted: false, state: "Off", actions: <button type="button" className="btn-quiet" onClick={turnOnCodes}>Turn on</button> }
    : messages === "ok"
      ? { name: "Read sign-in codes from Messages and Mail", desc: "", granted: true, state: "Granted" }
      : messages === "missing" && mail === "ok"
        ? { name: "Read sign-in codes from Messages and Mail", desc: "Only Mail can be read here.", granted: true, state: "Granted" }
        : messages === "missing" && mail === "missing"
          ? { name: "Read sign-in codes from Messages and Mail", desc: "There is no Messages history or mail on this Mac for Realm to read.", granted: false, state: "Nothing to read" }
          : { name: "Read sign-in codes from Messages and Mail", desc: "macOS has no dialog for Full Disk Access. Turn on Realm in System Settings ▸ Privacy & Security ▸ Full Disk Access.",
              granted: false, state: "Needs Full Disk Access", actions: fullDisk };

  // `missing` is believed only where Realm could look, so no grant would change it.
  const notificationsGrant: Grant = notifications === "ok"
    ? { name: "Codes from notifications on this Mac", desc: "", granted: true, state: "Granted" }
    : notifications === "missing"
      ? { name: "Codes from notifications on this Mac", desc: "This Mac has no notification history to read.", granted: false, state: "Nothing to read" }
      : notifications === "no_access" && messages === "ok"
        ? { name: "Codes from notifications on this Mac", desc: "Realm can't read notifications on this Mac.", granted: false, state: "Not granted" }
        : { name: "Codes from notifications on this Mac", desc: codes?.enabled ? "Comes with the same Full Disk Access." : "Comes with the row above.", granted: false, state: codes?.enabled ? "Needs Full Disk Access" : "Off" };

  const accessibility = computer?.rows.find((r) => r.id === "accessibility") ?? null;
  const appsGrant: Grant = accessibility?.state === "granted"
    ? { name: "Use apps on this Mac for a sign-in", desc: "", granted: true, state: "Granted" }
    : { name: "Use apps on this Mac for a sign-in", desc: "Accessibility, needed only to read a code from a notification or iPhone Mirroring.", granted: false, state: "Not granted",
        actions: accessibility && (
          <button type="button" className="btn-quiet" disabled={requesting !== null} title={accessibility.askExplanation ?? undefined}
            onClick={() => run(() => requestComputerAccess("accessibility"))}>
            {requesting === "accessibility" ? "Waiting for macOS…" : "Allow in System Settings"}
          </button>
        ) };

  const session = unlock?.policy.kind === "session" ? unlock.policy : null;
  const applyUnlock = (hours: UnlockSessionHours | null) => {
    if (!profileId) return;
    setUnlockError(null);
    void setUnlockPolicy(profileId, hours === null ? { kind: "touch-id" } : { kind: "session", hours }).then((r) => { if (!r.ok) setUnlockError(r.error); });
  };
  const unlockGrant: Grant = session
    ? { name: "Unlock passwords for agents", desc: `One Touch ID check lets agents fill ${profileName}'s passwords for ${session.hours} hours, while you're away too.`,
        granted: true, state: `For ${session.hours} hours`,
        actions: <button type="button" className="btn-quiet" onClick={() => applyUnlock(null)}>Ask for Touch ID each time</button> }
    : { name: "Unlock passwords for agents",
        desc: unlock?.policy.kind === "unattended"
          ? `Agents fill ${profileName}'s passwords without asking anyone.`
          : `Touch ID for each fill, so an agent waits for you while you're away.`,
        granted: unlock?.policy.kind === "unattended", state: unlock?.policy.kind === "unattended" ? "Without asking" : "Touch ID",
        actions: unlock?.policy.kind !== "unattended" && <button type="button" className="btn-quiet" disabled={!unlock} onClick={() => applyUnlock(8)}>Unlock for 8 hours</button> };

  return (
    <>
      {[codesGrant, notificationsGrant, appsGrant, unlockGrant].map((g) => (
        <div key={g.name} className="settings-row tcc-row" aria-label={`${g.name}: ${g.state}`}>
          <div className="settings-row-main">
            <span className="settings-row-name">{g.name}</span>
            <span className="tcc-state" data-state={g.granted ? "granted" : "unknown"}>
              {g.granted && <Icon name="check" size={12} />}
              {g.state}
            </span>
            {g.desc && <span className="settings-row-desc">{g.desc}</span>}
            {g === unlockGrant && unlockError !== null && <span className="settings-row-desc" role="alert">{unlockError}</span>}
          </div>
          {g.actions && <div className="mac-row-actions">{g.actions}</div>}
        </div>
      ))}
    </>
  );
}

const FILL_KIND: Record<AgentFill["kind"], string> = { password: "Saved password", generated: "New password", code: "Security code" };

/** The last agent fills main kept: the site, the kind and when, never a value. */
function RecentFills({ fills }: { fills: AgentFill[] }) {
  const now = Date.now();
  return (
    <>
      <h3 className="settings-head" data-setting="agent-fills">Recent agent fills</h3>
      <ul className="settings-list">
        {fills.map((f) => (
          <li key={`${f.at}|${f.site}|${f.kind}`} className="settings-row">
            <div className="settings-row-main">
              <span className="settings-row-name">{f.site}</span>
              <span className="settings-row-desc">{FILL_KIND[f.kind]} · {relativeTime(f.at, now)}</span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
