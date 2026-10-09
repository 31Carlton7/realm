import { Icon } from "@realm/ui";
import { LAB_DEFAULTS, labUpdateLine, type LabAccount, type LabCheck, type LabCheckState, type LabDevice, type LabDeviceKind, type LabSeenDevice } from "@realm/contracts";
import { useEffect, useId, useState } from "react";
import { CommandCopy } from "../../components/CommandCopy";
import { useApp } from "../../state/store";

/**
 * Settings ▸ Lab: a Mac set aside to run a team's work with nobody at it (teams plan §12).
 *
 * Four groups, in the order someone setting one up needs them: whether this Mac can be left alone (a
 * checklist that reads the Mac itself), when updates install, the phones on its cables, and how to
 * reach it from the laptop. Every fix that needs an administrator is the exact command, shown and
 * never run; the only fixes made here are switches, so each is undone by the same switch.
 */

const STATE_LABEL: Record<LabCheckState, string> = { ok: "Ready", attention: "Needs attention", unknown: "Can't tell", na: "Doesn't apply" };
/** The chip's tone, in the permission rows' vocabulary (`.tcc-state`). */
const STATE_TONE: Record<LabCheckState, string> = { ok: "granted", attention: "denied", unknown: "unknown", na: "unknown" };
const KIND_LABEL: Record<LabDeviceKind, string> = { iphone: "iPhone", simulator: "Simulator", android: "Android" };
const CAP_CHOICES = [15, 30, 60, 120] as const;
const SERVICES = ["TikTok", "Instagram", "YouTube", "X"];

const clock = (ms: number): string => {
  const d = new Date(ms);
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const hourLabel = (h: number): string => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? "AM" : "PM"}`;
const capLabel = (m: number): string => (m < 60 ? `${m} minutes` : m === 60 ? "1 hour" : `${m / 60} hours`);

export function LabSection() {
  const lab = useApp((s) => s.lab);
  const loadLab = useApp((s) => s.loadLab);
  const checkLab = useApp((s) => s.checkLab);
  const scanLabDevices = useApp((s) => s.scanLabDevices);
  const watchLab = useApp((s) => s.watchLab);
  const refreshTeams = useApp((s) => s.refreshTeams);
  const setLabEnabled = useApp((s) => s.setLabEnabled);
  const run = useApp((s) => s.run);
  useEffect(() => {
    // The scan after the first read: both answer with the device list, and a read that landed after
    // the scan would put back a list from before it.
    void run(async () => { await loadLab(); await scanLabDevices(); });
    void run(() => checkLab());
    // The teams a device can serve.
    void run(() => refreshTeams());
  }, [run, loadLab, checkLab, scanLabDevices, refreshTeams]);
  useEffect(() => watchLab(), [watchLab]);
  if (!lab) return <p className="env-empty">Checking…</p>;
  return (
    <div className="form lab-page">
      <ul className="settings-list">
        <li className="settings-row" data-setting="lab-mode" title="On a lab, an update does not ask before restarting. It waits for the update window, stops new team runs, lets running ones finish, then installs and starts them again.">
          <div className="settings-row-main">
            <span className="settings-row-name">This Mac is a lab</span>
            <span className="settings-row-detail">Updates wait for team runs, then install on their own</span>
          </div>
          <input type="checkbox" role="switch" className="switch" aria-label="This Mac is a lab"
            checked={lab.enabled} onChange={(e) => run(() => setLabEnabled(e.target.checked))} />
        </li>
      </ul>
      <Readiness />
      <UpdateWindow />
      <Devices />
      <Reach />
    </div>
  );
}

function Readiness() {
  const checks = useApp((s) => s.labChecks);
  const checking = useApp((s) => s.labChecking);
  const checkLab = useApp((s) => s.checkLab);
  const run = useApp((s) => s.run);
  const applicable = (checks ?? []).filter((c) => c.state !== "na");
  const ready = applicable.filter((c) => c.state === "ok").length;
  return (
    <div className="lab-readiness" data-setting="lab-readiness">
      <h3 className="settings-head">Ready to be left alone</h3>
      <div className="mac-access-head">
        <span className="settings-row-desc">{checks === null ? "Reading this Mac…" : `${ready} of ${applicable.length} ready`}</span>
        <button type="button" className="btn" disabled={checking} onClick={() => run(() => checkLab())}>{checking ? "Checking…" : "Check again"}</button>
      </div>
      {checks !== null && (
        <ul className="settings-list">
          {checks.map((c) => <CheckRow key={c.id} check={c} />)}
        </ul>
      )}
      <p className="settings-hint">Realm only reads these. A fix that needs an administrator is the command to run yourself.</p>
    </div>
  );
}

function CheckRow({ check: c }: { check: LabCheck }) {
  const loginItem = useApp((s) => s.labLoginItem);
  const setLabLoginItem = useApp((s) => s.setLabLoginItem);
  const preventSleep = useApp((s) => s.preventSleep);
  const setPreventSleep = useApp((s) => s.setPreventSleep);
  const openLabSettings = useApp((s) => s.openLabSettings);
  const run = useApp((s) => s.run);
  const needs = c.state === "attention";
  return (
    <li className="settings-row tcc-row lab-check" data-check={c.id} aria-label={`${c.label}: ${STATE_LABEL[c.state]}`}>
      <div className="settings-row-main">
        <span className="settings-row-name">{c.label}</span>
        <span className="tcc-state" data-state={STATE_TONE[c.state]}>
          {c.state === "ok" && <Icon name="check" size={12} />}
          {STATE_LABEL[c.state]}
        </span>
        <span className="settings-row-desc">{c.fact}</span>
        {needs && c.fix && <span className="settings-row-desc">{c.fix}</span>}
        {needs && c.command && <CommandCopy command={c.command} />}
        {/* The stopgap beside the real fix: Realm's own assertion, held only while agents work. */}
        {needs && c.action === "keep-awake" && (
          <label className="lab-inline-switch">
            <input type="checkbox" role="switch" className="switch" checked={preventSleep}
              onChange={(e) => run(() => setPreventSleep(e.target.checked))} />
            Keep the Mac awake while agents work
          </label>
        )}
      </div>
      {(c.action === "login-item" || (needs && c.settingsPane)) && (
        <div className="mac-row-actions">
          {c.action === "login-item" && (
            <input type="checkbox" role="switch" className="switch" aria-label="Open Realm at login"
              checked={loginItem?.openAtLogin === true} onChange={(e) => run(() => setLabLoginItem(e.target.checked))} />
          )}
          {needs && c.settingsPane && c.action !== "login-item" && (
            <button type="button" className="btn-quiet" onClick={() => run(() => openLabSettings(c.settingsPane!))}>Open System Settings</button>
          )}
        </div>
      )}
    </li>
  );
}

function UpdateWindow() {
  const lab = useApp((s) => s.lab)!;
  const setLabUpdateWindow = useApp((s) => s.setLabUpdateWindow);
  const labUpdateNow = useApp((s) => s.labUpdateNow);
  const run = useApp((s) => s.run);
  const line = labUpdateLine(lab.update, Date.now());
  return (
    <>
      <h3 className="settings-head">Update window</h3>
      <ul className="settings-list">
        <li className="settings-row" data-setting="lab-update-hour">
          <div className="settings-row-main"><span className="settings-row-name">Install updates at</span></div>
          <select aria-label="Install updates at" value={lab.updateHour}
            onChange={(e) => run(() => setLabUpdateWindow(Number(e.target.value), lab.updateCapMinutes))}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
        </li>
        <li className="settings-row" data-setting="lab-update-cap" title="Runs still going then are stopped by the restart and start again after it, without using up their attempts.">
          <div className="settings-row-main">
            <span className="settings-row-name">Wait for running work</span>
            <span className="settings-row-detail">Then it updates anyway</span>
          </div>
          <select aria-label="Wait for running work" value={lab.updateCapMinutes}
            onChange={(e) => run(() => setLabUpdateWindow(lab.updateHour, Number(e.target.value)))}>
            {[...new Set([...CAP_CHOICES, lab.updateCapMinutes])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{capLabel(m)}</option>)}
          </select>
        </li>
        <li className="settings-row lab-update-status" aria-live="polite">
          <div className="settings-row-main">
            <span className="settings-row-name">{lab.update.kind === "idle" ? "No update waiting" : "Update"}</span>
            <span className="settings-row-desc">
              {!lab.enabled ? "Lab mode is off, so an update asks before it restarts, as on any Mac." : line ?? "Realm checks for updates every few hours."}
            </span>
          </div>
          {lab.enabled && lab.update.kind === "waiting" && (
            <button type="button" className="btn" onClick={() => run(() => labUpdateNow())}>Update now</button>
          )}
        </li>
      </ul>
    </>
  );
}

function Devices() {
  const devices = useApp((s) => s.labDevices);
  const scanning = useApp((s) => s.labScanning);
  const scanLabDevices = useApp((s) => s.scanLabDevices);
  const run = useApp((s) => s.run);
  const n = devices?.devices.length ?? 0;
  return (
    <div className="lab-devices" data-setting="lab-devices">
      <h3 className="settings-head">Devices</h3>
      <div className="mac-access-head">
        <span className="settings-row-desc">
          {devices === null ? "Looking…" : `${n === 1 ? "1 device" : `${n} devices`}${devices.scannedAt ? `, looked at ${clock(devices.scannedAt)}` : ""}`}
        </span>
        <button type="button" className="btn" disabled={scanning} onClick={() => run(() => scanLabDevices())}>{scanning ? "Looking…" : "Look for devices"}</button>
      </div>
      {devices && n === 0 && devices.unregistered.length === 0 && (
        <p className="env-empty">No devices yet. Plug an iPhone into this Mac, trust it, and look again.</p>
      )}
      {devices && n > 0 && (
        <ul className="settings-list">
          {devices.devices.map((d) => <DeviceRow key={d.id} device={d} />)}
        </ul>
      )}
      {devices && devices.unregistered.length > 0 && (
        <>
          <p className="scope-group-label">On this Mac, not in the lab</p>
          <ul className="settings-list">
            {devices.unregistered.map((d) => <SeenRow key={d.udid} device={d} />)}
          </ul>
        </>
      )}
      <p className="settings-hint">Social apps need real phones: the Simulator has no App Store. Keep each phone to {LAB_DEFAULTS.accountsPerDevice} accounts, each one consented to.</p>
    </div>
  );
}

function SeenRow({ device: d }: { device: LabSeenDevice }) {
  const addLabDevice = useApp((s) => s.addLabDevice);
  const run = useApp((s) => s.run);
  return (
    <li className="settings-row lab-seen" aria-label={`${d.name}, ${KIND_LABEL[d.kind]}`}>
      <Icon name="simulator" size={16} className="lab-device-glyph" />
      <div className="settings-row-main">
        <span className="settings-row-name">{d.name}</span>
        <span className="settings-row-detail">{KIND_LABEL[d.kind]} · {d.runtime}</span>
      </div>
      <button type="button" className="btn-quiet" onClick={() => run(() => addLabDevice({ kind: d.kind, udid: d.udid, name: d.name, spaceId: null, accounts: [] }))}>Add to lab</button>
    </li>
  );
}

function DeviceRow({ device: d }: { device: LabDevice }) {
  const teams = useApp((s) => s.teams);
  const spaces = useApp((s) => s.spaces);
  const updateLabDevice = useApp((s) => s.updateLabDevice);
  const removeLabDevice = useApp((s) => s.removeLabDevice);
  const run = useApp((s) => s.run);
  const teamIds = [...new Set([...Object.keys(teams), ...(d.spaceId ? [d.spaceId] : [])])];
  const teamName = (id: string) => spaces.find((sp) => sp.id === id)?.name ?? (id === d.spaceId ? d.spaceName : null) ?? "A deleted space";
  const seen = d.connected ? "On the cable" : d.lastSeenAt ? `Last seen ${clock(d.lastSeenAt)}` : "Not seen yet";
  const setAccounts = (accounts: LabAccount[]) => run(() => updateLabDevice({ id: d.id, accounts }));
  return (
    <li className="settings-row lab-device" data-stack aria-label={`${d.name}, ${KIND_LABEL[d.kind]}, ${seen}`}>
      <div className="settings-row-main">
        <span className="settings-row-name">{d.name}</span>
        <span className="tcc-state" data-state={d.connected ? "granted" : "unknown"}>{seen}</span>
        <span className="settings-row-detail">
          {KIND_LABEL[d.kind]}{d.udid && <> · <span className="lab-udid">{d.udid}</span></>}
        </span>
      </div>
      <div className="lab-device-controls">
        <select aria-label={`Team for ${d.name}`} value={d.spaceId ?? ""}
          onChange={(e) => run(() => updateLabDevice({ id: d.id, spaceId: e.target.value || null }))}>
          <option value="">No team</option>
          {teamIds.map((id) => <option key={id} value={id}>{teamName(id)}</option>)}
        </select>
        <button type="button" className="btn-quiet" onClick={() => run(() => removeLabDevice(d.id))}>Remove from lab</button>
      </div>
      <div className="lab-accounts" aria-label={`Accounts on ${d.name}`}>
        {d.accounts.map((a, i) => (
          <span key={`${a.service}:${a.handle}`} className="lab-account">
            {a.service} <span className="lab-account-handle">{a.handle}</span>
            <button type="button" className="lab-account-remove" aria-label={`Remove ${a.service} ${a.handle}`} title="Remove"
              onClick={() => setAccounts(d.accounts.filter((_, j) => j !== i))}>
              <Icon name="close" size={12} />
            </button>
          </span>
        ))}
        {d.accounts.length < LAB_DEFAULTS.accountsPerDevice
          ? <AddAccount onAdd={(a) => setAccounts([...d.accounts, a])} name={d.name} />
          : <span className="settings-row-detail">{LAB_DEFAULTS.accountsPerDevice} of {LAB_DEFAULTS.accountsPerDevice} accounts</span>}
      </div>
    </li>
  );
}

function AddAccount({ onAdd, name }: { onAdd: (a: LabAccount) => void; name: string }) {
  const [service, setService] = useState("");
  const [handle, setHandle] = useState("");
  const list = useId();
  const ok = service.trim() !== "" && handle.trim() !== "";
  return (
    <form className="lab-account-add" onSubmit={(e) => {
      e.preventDefault();
      if (!ok) return;
      onAdd({ service: service.trim(), handle: handle.trim() });
      setService(""); setHandle("");
    }}>
      <input className="settings-text" list={list} aria-label={`Service for an account on ${name}`} placeholder="TikTok" value={service} onChange={(e) => setService(e.target.value)} />
      <datalist id={list}>{SERVICES.map((s) => <option key={s} value={s} />)}</datalist>
      <input className="settings-text" aria-label={`Handle for an account on ${name}`} placeholder="@handle" value={handle} onChange={(e) => setHandle(e.target.value)} />
      <button type="submit" className="btn-quiet" disabled={!ok}>Add account</button>
    </form>
  );
}

function Reach() {
  const lab = useApp((s) => s.lab)!;
  return (
    <>
      <h3 className="settings-head">Reach this Mac</h3>
      <ul className="settings-list">
        <li className="settings-row lab-reach" data-setting="lab-reach" data-stack>
          <div className="settings-row-main">
            <span className="settings-row-name">From your laptop</span>
            <span className="settings-row-desc">
              {lab.hostName
                ? "In Realm on your laptop, open a Machine, choose Another Mac, and enter this address. Screen Sharing has to be on here."
                : "This Mac's name could not be read. Use the address under General ▸ Sharing ▸ Screen Sharing."}
            </span>
          </div>
          {lab.hostName && <CommandCopy command={lab.hostName} />}
        </li>
      </ul>
      <p className="settings-hint">Answering Needs you and Review from your phone comes later, with Realm's mobile app.</p>
    </>
  );
}
