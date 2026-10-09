import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { statfs } from "node:fs/promises";
import { connect } from "node:net";
import { LAB_DEFAULTS, type LabCheck } from "@realm/contracts";

/**
 * Whether this Mac is ready to be left alone running a team's work (teams plan §12).
 *
 * Every probe READS. Nothing here runs `pmset`, `defaults write`, `sudo` or anything else that would
 * change the Mac: a fix that needs an administrator is shown as the exact command, for the person to
 * run, and the two fixes Realm makes itself (opening at login, staying awake while agents work) are
 * switches in the renderer, undone by the same switch.
 *
 * Split in two so each half is testable on its own: `probeFacts` asks the Mac and returns what it
 * said, raw; `evaluate` turns those facts into the checklist, and is pure.
 */

export type RunResult = { code: number; stdout: string };

export type ProbeDeps = {
  run: (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>;
  /** Free bytes on the volume holding `path`. */
  freeBytes: (path: string) => Promise<number>;
  /** Whether a host name resolves — the network's half that does not depend on any one server. */
  resolves: (host: string) => Promise<boolean>;
  /** Whether something on this Mac is listening on a loopback port. */
  listening: (port: number) => Promise<boolean>;
  home: string;
};

/** What the Mac said, before any judgement. A null is a probe that failed to answer. */
export type ReadinessFacts = {
  pmset: string | null;
  pmsetPs: string | null;
  fdesetup: string | null;
  /** The auto-login user, "" when none is set, null when the probe failed. */
  autoLoginUser: string | null;
  displaysJson: string | null;
  freeBytes: number | null;
  online: boolean | null;
  defaultInterface: string | null;
  hardwarePorts: string | null;
  screenSharing: boolean | null;
};

const ok = (r: RunResult | null): string | null => (r && r.code === 0 ? r.stdout : null);

export async function probeFacts(d: ProbeDeps): Promise<ReadinessFacts> {
  const safe = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
  const [pmset, pmsetPs, fdesetup, autoLogin, displays, free, online, route, ports, sharing] = await Promise.all([
    safe(d.run("/usr/bin/pmset", ["-g"], 5_000)),
    safe(d.run("/usr/bin/pmset", ["-g", "ps"], 5_000)),
    safe(d.run("/usr/bin/fdesetup", ["status"], 5_000)),
    safe(d.run("/usr/bin/defaults", ["read", "/Library/Preferences/com.apple.loginwindow", "autoLoginUser"], 5_000)),
    safe(d.run("/usr/sbin/system_profiler", ["SPDisplaysDataType", "-json"], 15_000)),
    safe(d.freeBytes(d.home)),
    safe(d.resolves("github.com")),
    safe(d.run("/sbin/route", ["-n", "get", "default"], 5_000)),
    safe(d.run("/usr/sbin/networksetup", ["-listallhardwareports"], 5_000)),
    safe(d.listening(5900)),
  ]);
  return {
    pmset: ok(pmset), pmsetPs: ok(pmsetPs), fdesetup: ok(fdesetup),
    // `defaults read` exits 1 when the key is absent, which is the answer "nobody logs in by itself".
    autoLoginUser: autoLogin === null ? null : autoLogin.code === 0 ? autoLogin.stdout.trim() : "",
    displaysJson: ok(displays),
    freeBytes: free, online,
    defaultInterface: ok(route)?.match(/interface:\s*(\S+)/)?.[1] ?? null,
    hardwarePorts: ok(ports), screenSharing: sharing,
  };
}

/** `pmset -g`'s settings as numbers, keyed by name. A trailing "(sleep prevented by …)" is dropped. */
export function parsePmset(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z ]*?)\s+(-?\d+)\b/);
    if (m) out[m[1]!.trim()] = Number(m[2]);
  }
  return out;
}

/** What `pmset -g ps` says carries this Mac through a power cut. */
export function parsePowerBackup(text: string): "ups" | "battery" | "none" {
  if (/\bUPS\b|-UPS|UPS Power/i.test(text)) return "ups";
  if (/InternalBattery/.test(text)) return "battery";
  return "none";
}

export type DisplayFact = { name: string; builtIn: boolean };

/** The displays `system_profiler` lists, across every GPU. */
export function parseDisplays(json: string): DisplayFact[] {
  try {
    const data = JSON.parse(json) as { SPDisplaysDataType?: { spdisplays_ndrvs?: { _name?: string; spdisplays_connection_type?: string }[] }[] };
    return (data.SPDisplaysDataType ?? []).flatMap((gpu) => (gpu.spdisplays_ndrvs ?? []).map((x) => ({
      name: x._name ?? "Display", builtIn: x.spdisplays_connection_type === "spdisplays_internal",
    })));
  } catch { return []; }
}

/** The hardware port name of a device ("Wi-Fi", "Ethernet", "Thunderbolt Bridge"). */
export function hardwarePortOf(listing: string, device: string): string | null {
  const blocks = listing.split(/\n\s*\n/);
  for (const b of blocks) {
    const port = b.match(/Hardware Port:\s*(.+)/)?.[1]?.trim();
    const dev = b.match(/Device:\s*(\S+)/)?.[1];
    if (port && dev === device) return port;
  }
  return null;
}

const GB = 1024 ** 3;

/** The checklist from the facts. Pure: every judgement the page shows is made here. */
export function evaluate(f: ReadinessFacts): LabCheck[] {
  const none = { command: null, settingsPane: null, action: null } as const;
  const checks: LabCheck[] = [];
  const pm = f.pmset ? parsePmset(f.pmset) : null;

  // Sleep. `SleepDisabled 1` (pmset disablesleep) or `sleep 0` both keep it up.
  if (!pm) {
    checks.push({ id: "sleep", label: "Never sleeps", state: "unknown", fact: "pmset did not answer.", fix: null, ...none });
  } else {
    const sleep = pm["sleep"];
    const awake = pm["SleepDisabled"] === 1 || sleep === 0;
    checks.push(awake
      ? { id: "sleep", label: "Never sleeps", state: "ok", fact: "This Mac does not sleep on its own.", fix: null, ...none }
      : {
          id: "sleep", label: "Never sleeps", state: "attention",
          fact: sleep === undefined ? "This Mac sleeps when idle." : `This Mac sleeps after ${sleep === 1 ? "1 minute" : `${sleep} minutes`} idle, and a team's clock stops with it.`,
          fix: "Run this once in Terminal. Until then, Realm can keep it awake while agents are working.",
          command: "sudo pmset -a sleep 0 disksleep 0", settingsPane: "energy", action: "keep-awake",
        });
  }

  // Restart after a power failure: `autorestart`, which pmset lists only on Macs that have it.
  if (!pm) {
    checks.push({ id: "power-failure", label: "Starts after a power failure", state: "unknown", fact: "pmset did not answer.", fix: null, ...none });
  } else if (pm["autorestart"] === undefined) {
    checks.push({ id: "power-failure", label: "Starts after a power failure", state: "na", fact: "This Mac has no such setting; a laptop rides out a cut on its battery.", fix: null, ...none });
  } else if (pm["autorestart"] === 1) {
    checks.push({ id: "power-failure", label: "Starts after a power failure", state: "ok", fact: "It starts up again when the power comes back.", fix: null, ...none });
  } else {
    checks.push({
      id: "power-failure", label: "Starts after a power failure", state: "attention",
      fact: "After a power cut it stays off until someone presses the button.",
      fix: "Run this once in Terminal, or turn on “Start up automatically after a power failure” in Energy.",
      command: "sudo pmset -a autorestart 1", settingsPane: "energy", action: null,
    });
  }

  // FileVault, and what it does to logging in by itself.
  const fv = f.fdesetup === null ? null : /FileVault is On/i.test(f.fdesetup);
  if (fv === null) {
    checks.push({ id: "filevault", label: "Comes back to the desktop after a restart", state: "unknown", fact: "fdesetup did not answer.", fix: null, ...none });
  } else if (fv) {
    checks.push({
      id: "filevault", label: "Comes back to the desktop after a restart", state: "attention",
      fact: "FileVault is on, so after any restart this Mac waits at the unlock screen and cannot log in by itself.",
      fix: "For a lab that must come back alone, turn FileVault off in Privacy & Security. Keep it on only if someone will unlock it after each restart.",
      command: null, settingsPane: "privacy", action: null,
    });
  } else {
    checks.push({ id: "filevault", label: "Comes back to the desktop after a restart", state: "ok", fact: "FileVault is off, so a restart does not stop at the unlock screen.", fix: null, ...none });
  }

  // Automatic login: GUI apps and their macOS grants need a logged-in user (TCC survives a detach).
  if (f.autoLoginUser === null) {
    checks.push({ id: "auto-login", label: "Logs in by itself", state: "unknown", fact: "The login window's settings could not be read.", fix: null, ...none });
  } else if (f.autoLoginUser) {
    checks.push({ id: "auto-login", label: "Logs in by itself", state: "ok", fact: `It logs in as ${f.autoLoginUser} when it starts.`, fix: null, ...none });
  } else {
    checks.push({
      id: "auto-login", label: "Logs in by itself", state: "attention",
      fact: "Nobody is logged in after a restart, and Realm, its windows and its phones need a user.",
      fix: fv ? "Turn FileVault off first; macOS hides automatic login while it is on. Then choose a user under “Automatically log in as”."
        : "Choose a user under “Automatically log in as” in Users & Groups.",
      command: null, settingsPane: "users", action: null,
    });
  }

  // A display: window capture and Screen Sharing need one, even with nobody looking.
  if (f.displaysJson === null) {
    checks.push({ id: "display", label: "Has a display", state: "unknown", fact: "system_profiler did not answer.", fix: null, ...none });
  } else {
    const shown = parseDisplays(f.displaysJson);
    checks.push(shown.length > 0
      ? { id: "display", label: "Has a display", state: "ok", fact: `${shown.map((x) => (x.builtIn ? `${x.name} (built in)` : x.name)).join(", ")}.`, fix: null, ...none }
      : {
          id: "display", label: "Has a display", state: "attention",
          fact: "No display is attached, and with none macOS draws no windows to capture.",
          fix: "Plug in an HDMI dummy plug, or keep a monitor on it.", command: null, settingsPane: "displays", action: null,
        });
  }

  // Disk.
  if (f.freeBytes === null) {
    checks.push({ id: "disk", label: `At least ${LAB_DEFAULTS.minFreeGb} GB free`, state: "unknown", fact: "The disk's free space could not be read.", fix: null, ...none });
  } else {
    const gb = Math.floor(f.freeBytes / GB);
    checks.push(gb >= LAB_DEFAULTS.minFreeGb
      ? { id: "disk", label: `At least ${LAB_DEFAULTS.minFreeGb} GB free`, state: "ok", fact: `${gb} GB free.`, fix: null, ...none }
      : {
          id: "disk", label: `At least ${LAB_DEFAULTS.minFreeGb} GB free`, state: "attention",
          fact: `${gb} GB free. A full disk can hang a Mac that is swapping.`,
          fix: `Free space until at least ${LAB_DEFAULTS.minFreeGb} GB is left.`, command: null, settingsPane: null, action: null,
        });
  }

  // Network.
  const port = f.defaultInterface && f.hardwarePorts ? hardwarePortOf(f.hardwarePorts, f.defaultInterface) : null;
  const over = f.defaultInterface ? ` over ${port ? `${port} (${f.defaultInterface})` : f.defaultInterface}` : "";
  if (f.online === null) {
    checks.push({ id: "network", label: "Online", state: "unknown", fact: "The network could not be checked.", fix: null, ...none });
  } else if (f.online) {
    checks.push({
      id: "network", label: "Online", state: "ok",
      fact: `Online${over}.${port === "Wi-Fi" ? " Ethernet is steadier for a Mac nobody is watching." : ""}`, fix: null, ...none,
    });
  } else {
    checks.push({
      id: "network", label: "Online", state: "attention", fact: `github.com does not resolve${over}, so updates and agents cannot reach their servers.`,
      fix: "Connect it to the network, by cable if you can.", command: null, settingsPane: "network", action: null,
    });
  }

  // A power cut.
  if (f.pmsetPs === null) {
    checks.push({ id: "power-backup", label: "Rides out a power cut", state: "unknown", fact: "pmset did not answer.", fix: null, ...none });
  } else {
    const backup = parsePowerBackup(f.pmsetPs);
    checks.push(backup === "ups"
      ? { id: "power-backup", label: "Rides out a power cut", state: "ok", fact: "It is on a UPS.", fix: null, ...none }
      : backup === "battery"
      ? { id: "power-backup", label: "Rides out a power cut", state: "ok", fact: "It runs on its own battery.", fix: null, ...none }
      : {
          id: "power-backup", label: "Rides out a power cut", state: "attention",
          fact: "No UPS is reported, so a flicker restarts it mid-run.",
          fix: "Plug it into a UPS. Runs that were stopped start again on their own after a restart.", command: null, settingsPane: null, action: null,
        });
  }

  // Screen Sharing: how the laptop reaches this Mac (the Machine pane's "Another Mac").
  if (f.screenSharing === null) {
    checks.push({ id: "screen-sharing", label: "Reachable from your laptop", state: "unknown", fact: "Screen Sharing could not be checked.", fix: null, ...none });
  } else if (f.screenSharing) {
    checks.push({ id: "screen-sharing", label: "Reachable from your laptop", state: "ok", fact: "Screen Sharing is on.", fix: null, ...none });
  } else {
    checks.push({
      id: "screen-sharing", label: "Reachable from your laptop", state: "attention",
      fact: "Screen Sharing is off, so your laptop's Realm cannot open this Mac as a machine.",
      fix: "Turn on Screen Sharing in General ▸ Sharing.", command: null, settingsPane: "sharing", action: null,
    });
  }
  return checks;
}

/* ── the real Mac ── */

export function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? (err as unknown as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });
}

export const macProbeDeps = (home: string): ProbeDeps => ({
  run: runCommand,
  freeBytes: async (path) => { const s = await statfs(path); return s.bavail * s.bsize; },
  resolves: async (host) => {
    try { await Promise.race([lookup(host), new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 3_000))]); return true; } catch { return false; }
  },
  listening: (port) => new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port });
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.setTimeout(1_000, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  }),
  home,
});
