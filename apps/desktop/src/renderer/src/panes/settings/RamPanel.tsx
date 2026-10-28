import {
  RESOURCE_CATEGORY_LABEL,
  type FreeAction, type MemoryPressure, type ResourceCategory, type ResourcePart, type ResourcePolicies, type ResourcePolicyKey, type ResourceReport,
} from "@realm/contracts";
import { useCallback, useEffect, useState } from "react";
import { capabilities } from "../../platform";
import { useApp } from "../../state/store";

/**
 * Settings ▸ RAM, in the order a person asks the questions — named RAM because Memory, everywhere else
 * in Realm, is what agents remember:
 *
 *   1. **How much is Realm holding, and how short is the Mac?** — one row: Realm's total beside the
 *      Mac's pressure, swap and load.
 *   2. **Where does it go?** — by category, each folding open to what it is made of: a session's
 *      engine, a terminal, a browser pane, a simulator Realm booted.
 *   3. **Can I have some back now?** — one button per kind of idle thing, each saying what it would
 *      let go of. None stops anything mid-work.
 *   4. **What happens on its own?** — the idle windows, and whether they shrink when memory is short.
 *   5. **What else is heavy?** — other apps, by name and size, which Realm never touches.
 *
 * Sizes are footprints (`apps/server/src/resources/machine.ts`): RSS reads small for exactly the
 * processes macOS has compressed or swapped out, which on a Mac short of memory is most of them.
 *
 * Off a Mac: Linux reads the same parts at their resident size, without Laya's or the simulators'
 * rows (neither exists there). Windows' processes are not read at all (`measure: "none"`), so the
 * page says so and keeps only the idle windows, which apply there as anywhere.
 */

const REFRESH_MS = 10_000;

/** "2.4 GB", "312 MB": a size as Activity Monitor writes it. */
export function bytesLabel(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
  const mb = bytes / 1024 ** 2;
  return mb >= 1 ? `${Math.round(mb)} MB` : "under 1 MB";
}

const sizeOf = (s: { footprintBytes: number | null; residentBytes: number }) => s.footprintBytes ?? s.residentBytes;

const PRESSURE_WORD: Record<MemoryPressure, string> = { normal: "Memory pressure is normal", warn: "Memory is short", critical: "Memory is critically short", unknown: "Memory pressure is not reported here" };

/** "10 minutes", "1 hour", "Never". */
export function windowLabel(minutes: number): string {
  if (minutes === 0) return "Never";
  if (minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

type WindowRow = {
  id: string; key: ResourcePolicyKey; label: string; title: string;
  value: (p: ResourcePolicies) => number; effective: (p: ResourcePolicies) => number; choices: number[];
  /** Whether this OS has the thing at all (Laya and the simulators are the Mac's). */
  available?: () => boolean;
};

const WINDOWS: WindowRow[] = [
  { id: "ram-engine-idle", key: "sessions.engineIdleMinutes", label: "Stop an idle engine after", value: (p) => p.engineIdleMinutes, effective: (p) => p.effective.engines, choices: [5, 10, 15, 30, 60, 120, 0],
    title: "An engine is idle when its turn has settled, nothing is queued for it, it is not waiting on you, and no goal, run, sub-agent or backgrounded command depends on it. Its next message starts it again on the same conversation." },
  { id: "ram-mcp-idle", key: "mcp.idleStopMinutes", label: "Stop an idle MCP server after", value: (p) => p.mcpIdleMinutes, effective: (p) => p.effective.mcp, choices: [5, 10, 15, 30, 60, 120, 0],
    title: "Only servers Realm runs as a process on this Mac, and never one with a call open. Sessions keep seeing its tools; the next call starts it again." },
  { id: "ram-laya-idle", key: "laya.idleStopMinutes", label: "Stop Laya after", value: (p) => p.layaIdleMinutes, effective: (p) => p.effective.laya, choices: [2, 5, 10, 30, 60, 0],
    title: "In Shadow, Laya starts when a step asks it and stops after this long with none. Steps that arrive while it starts are asked once it is up. Assist keeps it loaded.",
    available: () => capabilities().laya },
  { id: "ram-simulator-idle", key: "simulators.idleShutdownMinutes", label: "Shut down a simulator Realm booted after", value: (p) => p.simulatorIdleMinutes, effective: (p) => p.effective.simulators, choices: [10, 15, 30, 60, 120, 0],
    title: "Counted from the last time a pane showed it or anything acted on it. A simulator that was already running when Realm showed it is never shut down, nor one an xcodebuild or anything else is using.",
    available: () => capabilities().simulators },
  { id: "ram-browser-idle", key: "browser.discardHiddenMinutes", label: "Discard a hidden browser pane after", value: (p) => p.browserHiddenMinutes, effective: (p) => p.effective.browsers, choices: [5, 10, 20, 30, 60, 0],
    title: "The page and where it was scrolled are kept, and it loads again when the pane is shown. Never one an agent drove within the window, or one playing media, holding text you have not sent, loading or showing a sign-in window." },
];

const FREE_ROWS: { id: string; action: FreeAction; label: string; verb: string; noun: [string, string]; none: string; available?: () => boolean }[] = [
  { id: "ram-free-engines", action: "engines", label: "Stop idle engines", verb: "Stop", noun: ["engine", "engines"], none: "No engine is idle" },
  { id: "ram-free-simulators", action: "simulators", label: "Shut down simulators Realm booted", verb: "Shut down", noun: ["simulator", "simulators"], none: "None that nothing is showing",
    available: () => capabilities().simulators },
  { id: "ram-free-browsers", action: "browsers", label: "Discard hidden browser panes", verb: "Discard", noun: ["pane", "panes"], none: "No pane is hidden" },
  { id: "ram-free-laya", action: "laya", label: "Stop Laya", verb: "Stop", noun: ["process", "processes"], none: "Not running, or in the middle of a step",
    available: () => capabilities().laya },
];

const offered = <T extends { available?: () => boolean }>(rows: T[]): T[] => rows.filter((r) => r.available?.() !== false);

export function RamPanel() {
  const resourcesSnapshot = useApp((s) => s.resourcesSnapshot);
  const resourcesPolicies = useApp((s) => s.resourcesPolicies);
  const resourcesSetPolicy = useApp((s) => s.resourcesSetPolicy);
  const resourcesFree = useApp((s) => s.resourcesFree);
  const run = useApp((s) => s.run);
  const [report, setReport] = useState<ResourceReport | null>(null);
  const [policies, setPolicies] = useState<ResourcePolicies | null>(null);
  const [freed, setFreed] = useState<{ action: FreeAction; count: number } | null>(null);

  const load = useCallback(async (fresh: boolean) => {
    const [r, p] = await Promise.all([resourcesSnapshot(fresh), resourcesPolicies()]);
    setReport(r);
    setPolicies(p);
  }, [resourcesSnapshot, resourcesPolicies]);
  useEffect(() => {
    void run(() => load(false));
    const t = setInterval(() => { void load(false).catch(() => {}); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [run, load]);

  // Null is "not read yet": a total drawn against an unread report would lie for a frame.
  if (!report || !policies) return <p className="env-empty">Measuring…</p>;
  const m = report.machine;
  const machine = capabilities().machine;
  // Windows: Realm reads neither its processes nor the pressure there (`machine.ts`), so there is no
  // total to give, nothing priced to free, and no pressure for the windows to shrink under.
  const unread = report.measure === "none";
  const free = async (action: FreeAction) => {
    const r = await resourcesFree(action);
    setFreed({ action, count: r.freed });
    await load(true);
  };
  const setPolicy = async (key: ResourcePolicyKey, value: number | boolean) => setPolicies(await resourcesSetPolicy(key, value));

  return (
    <>
      <ul className="settings-list">
        {unread ? (
          <li className="settings-row ram-total">
            <div className="settings-row-main">
              <span className="settings-row-name">Realm does not measure its memory here yet</span>
              <span className="settings-row-detail">{`It reads its processes on macOS and Linux. On this ${machine}, idle work still goes after the windows below.`}</span>
            </div>
          </li>
        ) : (
          <>
            <li className="settings-row ram-total" data-pressure={m.pressure}>
              <div className="settings-row-main">
                <span className="settings-row-name">Realm is holding <span className="ram-size">{bytesLabel(sizeOf(report.realm))}</span></span>
                <span className="settings-row-detail">
                  {[
                    m.totalBytes > 0 ? `of this ${machine}'s ${bytesLabel(m.totalBytes)}` : null,
                    `${report.realm.processes} ${report.realm.processes === 1 ? "process" : "processes"}`,
                  ].filter(Boolean).join(" · ")}
                </span>
              </div>
            </li>
            <li className="settings-row ram-machine" title={capabilities().os === "mac"
              ? "Pressure is macOS's own reading, the one Activity Monitor colours, counted as short whenever the Mac is swapping out between two readings too."
              : "Pressure is the kernel's own reading: how much of the last ten seconds work spent waiting on memory."}>
              <div className="settings-row-main">
                <span className="settings-row-name">{PRESSURE_WORD[m.pressure]}</span>
                <span className="settings-row-detail">
                  {[
                    m.pressureWhy,
                    m.swap && m.swap.totalBytes > 0 ? `${bytesLabel(m.swap.usedBytes)} of ${bytesLabel(m.swap.totalBytes)} swap in use` : null,
                    `load ${m.load[0].toFixed(1)} on ${m.cpus} cores`,
                  ].filter(Boolean).join(" · ")}
                </span>
              </div>
            </li>
          </>
        )}
      </ul>

      {report.categories.length > 0 && <h3 className="settings-head">Where it goes</h3>}
      {report.categories.length > 0 && (
        <ul className="settings-list ram-categories">
          {report.categories.map((c) => (
            <Category key={c.category} category={c.category} size={sizeOf(c)} parts={report.parts.filter((p) => p.category === c.category)} />
          ))}
        </ul>
      )}

      {!unread && <h3 className="settings-head">Free memory now</h3>}
      {!unread && <ul className="settings-list">
        {offered(FREE_ROWS).map((r) => {
          const f = report.freeable?.[r.action] ?? { count: 0, bytes: 0 };
          const done = freed?.action === r.action ? freed.count : null;
          return (
            <li key={r.id} className="settings-row" data-setting={r.id}>
              <div className="settings-row-main">
                <span className="settings-row-name">{r.label}</span>
                <span className="settings-row-detail" aria-live="polite">
                  {done !== null
                    ? (done === 0 ? "Nothing could go: it was in use" : `${r.verb === "Shut down" ? "Shut down" : r.verb === "Discard" ? "Discarded" : "Stopped"} ${done} ${done === 1 ? r.noun[0] : r.noun[1]}`)
                    : f.count === 0 ? r.none : `${f.count} ${f.count === 1 ? r.noun[0] : r.noun[1]}${f.bytes > 0 ? `, ${bytesLabel(f.bytes)}` : ""}`}
                </span>
              </div>
              <button type="button" className="btn" disabled={f.count === 0}
                title={f.count === 0 ? r.none : undefined}
                onClick={() => run(() => free(r.action))}>{r.verb}</button>
            </li>
          );
        })}
      </ul>}

      <h3 className="settings-head">Let go of idle work</h3>
      <ul className="settings-list">
        {offered(WINDOWS).map((w) => {
          const value = w.value(policies);
          const now = w.effective(policies);
          return (
            <li key={w.id} className="settings-row" data-setting={w.id} title={w.title}>
              <div className="settings-row-main">
                <span className="settings-row-name">{w.label}</span>
                {/* Said only when the two differ: the window in force is shorter while memory is short. */}
                {now !== value && <span className="settings-row-detail">{windowLabel(now)} while memory is short</span>}
              </div>
              <select aria-label={w.label} value={value} onChange={(e) => run(() => setPolicy(w.key, Number(e.target.value)))}>
                {[...new Set([...w.choices, value])].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b)).map((v) => <option key={v} value={v}>{windowLabel(v)}</option>)}
              </select>
            </li>
          );
        })}
        <li className="settings-row" data-setting="ram-browser-keep" title="The panes hidden most recently stay loaded however long ago that was, so switching back to them is instant.">
          <div className="settings-row-main"><span className="settings-row-name">Hidden browser panes kept loaded</span></div>
          <select aria-label="Hidden browser panes kept loaded" value={policies.browserKeepHidden}
            onChange={(e) => run(() => setPolicy("browser.keepHidden", Number(e.target.value)))}>
            {[...new Set([0, 1, 2, 3, 5, 8, policies.browserKeepHidden])].sort((a, b) => a - b).map((v) => <option key={v} value={v}>{v === 0 ? "None" : String(v)}</option>)}
          </select>
        </li>
        {!unread && (
          <li className="settings-row" data-setting="ram-adaptive" title={`Only the waiting shrinks. Nothing mid-turn, waiting on you, or holding background work is stopped, however short of memory the ${machine} is.`}>
            <div className="settings-row-main">
              <span className="settings-row-name">Sooner when memory is short</span>
              <span className="settings-row-detail">Every window drops to 10 minutes under pressure, 5 when critical</span>
            </div>
            <input type="checkbox" role="switch" className="switch" aria-label="Sooner when memory is short"
              checked={policies.adaptive} onChange={(e) => run(() => setPolicy("resources.adaptive", e.target.checked))} />
          </li>
        )}
      </ul>

      {report.others.length > 0 && <h3 className="settings-head">{`Other apps on this ${machine}`}</h3>}
      {report.others.length > 0 && (
        <ul className="settings-list ram-others" title="Listed by name and size only. Realm never stops, slows or reads another app.">
          {report.others.map((o) => (
            <li key={o.name} className="settings-row">
              <div className="settings-row-main"><span className="settings-row-name">{o.name}</span></div>
              <span className="ram-size">{bytesLabel(sizeOf(o))}</span>
            </li>
          ))}
        </ul>
      )}

      {!unread && (
        <p className="settings-hint">
          {report.measure === "footprint"
            ? "Sizes are memory footprint, as Activity Monitor's Memory column shows it: what a process holds in RAM, in the compressor and in swap."
            : "Sizes are resident memory: this system does not report what was compressed or swapped out."}
        </p>
      )}
    </>
  );
}

/** One category's total, folding open to its parts, heaviest first. */
function Category({ category, size, parts }: { category: ResourceCategory; size: number; parts: ResourcePart[] }) {
  const label = RESOURCE_CATEGORY_LABEL[category];
  return (
    <li className="settings-row ram-category">
      <details>
        <summary aria-label={`${label}, ${bytesLabel(size)}`}>
          <span className="settings-row-name">{label}</span>
          <span className="ram-size">{bytesLabel(size)}</span>
        </summary>
        <ul className="ram-parts">
          {parts.map((p) => (
            <li key={p.id} className="ram-part">
              <span className="ram-part-main">
                <span className="ram-part-name">{p.label}</span>
                {p.detail && <span className="settings-row-detail">{p.detail}</span>}
              </span>
              <span className="ram-size">{bytesLabel(sizeOf(p))}</span>
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}
