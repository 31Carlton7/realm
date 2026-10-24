import { join } from "node:path";
import { CtlError } from "./errors";
import type { Exec } from "./tailscale";

/**
 * `realm service install`: `realm serve` as a background service of this user's, so a server keeps
 * running with nobody logged in to a terminal — a systemd user unit on Linux, a launchd agent on a Mac.
 *
 * What runs is written out in full: this very Node (or Realm.app's binary, as Node) on this very
 * `realm.js`, with the home and the listener spelled out as flags. Nothing secret goes in the file —
 * tokens stay in the home — and a service file that says exactly what it starts is one a person can
 * read before trusting it. Moving Realm or Node means installing again.
 */
export const SYSTEMD_UNIT = "realm.service";
export const LAUNCHD_LABEL = "co.charmtechnologies.realm.server";

export type ServiceSpec = {
  /** The program, then its arguments: `[node, realm.js, "serve", "--home", home, …]`. */
  argv: string[];
  /** PATH as it is now, so the agent CLIs and git a terminal finds are the ones the server finds. */
  path: string;
  /** Realm.app's binary has to be told to run as Node. */
  runAsNode: boolean;
  home: string;
};

export type ServicePlatform = "linux" | "darwin";

export function servicePlatform(platform: string): ServicePlatform {
  if (platform === "linux" || platform === "darwin") return platform;
  throw new CtlError("UNSUPPORTED", `realm service knows systemd (Linux) and launchd (macOS), not ${platform}; run realm serve under your own supervisor`);
}

export function serviceFile(platform: ServicePlatform, userHome: string, env: NodeJS.ProcessEnv): string {
  return platform === "linux"
    ? join(env.XDG_CONFIG_HOME || join(userHome, ".config"), "systemd", "user", SYSTEMD_UNIT)
    : join(userHome, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

/** One systemd word: quoted, with the specifier (`%`) and variable (`$`) characters it would expand
 *  escaped, so a path is passed through exactly as written. */
const systemdWord = (w: string): string => `"${w.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
const systemdEnv = (k: string, v: string): string => `Environment="${`${k}=${v}`.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export function systemdUnit(s: ServiceSpec): string {
  return [
    "[Unit]",
    "Description=Realm server (realm serve)",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${s.argv.map(systemdWord).join(" ")}`,
    systemdEnv("REALM_SERVICE", "1"),
    systemdEnv("PATH", s.path),
    ...(s.runAsNode ? [systemdEnv("ELECTRON_RUN_AS_NODE", "1")] : []),
    "WorkingDirectory=%h",
    "Restart=on-failure",
    "RestartSec=5",
    // A clean stop takes a moment: sessions are closed and terminals saved before the process exits.
    "TimeoutStopSec=30",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function launchdPlist(s: ServiceSpec): string {
  const log = join(s.home, "logs", "service.log");
  const env: [string, string][] = [["REALM_SERVICE", "1"], ["PATH", s.path], ...(s.runAsNode ? [["ELECTRON_RUN_AS_NODE", "1"] as [string, string]] : [])];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...s.argv.map((a) => `    <string>${xml(a)}</string>`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...env.map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`),
    "  </dict>",
    "  <key>RunAtLoad</key><true/>",
    // Restarted when it fails, not when it is stopped: a server that exits cleanly was asked to.
    "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    "  <key>ThrottleInterval</key><integer>10</integer>",
    `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export type ServiceDeps = {
  platform: ServicePlatform;
  userHome: string;
  env: NodeJS.ProcessEnv;
  uid: number;
  exec: Exec;
  writeFile: (path: string, text: string) => void;
  removeFile: (path: string) => boolean;
  mkdir: (path: string) => void;
};

async function must(exec: Exec, command: string, args: string[]): Promise<void> {
  const r = await exec(command, args);
  if (r.code !== 0) throw new CtlError("SERVICE", `${command} ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
}

/** Writes the service file and starts it. Returns what was written, and any advice worth printing. */
export async function installService(d: ServiceDeps, s: ServiceSpec): Promise<{ file: string; advice: string | null }> {
  const file = serviceFile(d.platform, d.userHome, d.env);
  d.mkdir(join(file, ".."));
  if (d.platform === "linux") {
    d.writeFile(file, systemdUnit(s));
    await must(d.exec, "systemctl", ["--user", "daemon-reload"]);
    await must(d.exec, "systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
    // A user's units stop when their last session ends, unless the user lingers.
    const user = d.env.USER || d.env.LOGNAME || "";
    const linger = await d.exec("loginctl", ["show-user", user, "--property=Linger", "--value"]).catch(() => null);
    const advice = linger?.stdout.trim() === "yes" ? null
      : `To keep it running after you log out, and start it at boot: loginctl enable-linger ${user}`;
    return { file, advice };
  }
  d.mkdir(join(s.home, "logs"));
  d.writeFile(file, launchdPlist(s));
  // Unloaded first, in case an older copy is running: bootstrap refuses a label that is loaded.
  await d.exec("launchctl", ["bootout", `gui/${d.uid}/${LAUNCHD_LABEL}`]).catch(() => null);
  await must(d.exec, "launchctl", ["bootstrap", `gui/${d.uid}`, file]);
  return { file, advice: `It starts when you log in. Its output goes to ${join(s.home, "logs", "service.log")}` };
}

export async function uninstallService(d: ServiceDeps): Promise<{ file: string; removed: boolean }> {
  const file = serviceFile(d.platform, d.userHome, d.env);
  if (d.platform === "linux") {
    await d.exec("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]).catch(() => null);
    const removed = d.removeFile(file);
    await d.exec("systemctl", ["--user", "daemon-reload"]).catch(() => null);
    return { file, removed };
  }
  await d.exec("launchctl", ["bootout", `gui/${d.uid}/${LAUNCHD_LABEL}`]).catch(() => null);
  return { file, removed: d.removeFile(file) };
}

export async function serviceStatus(d: ServiceDeps): Promise<{ file: string; running: boolean }> {
  const file = serviceFile(d.platform, d.userHome, d.env);
  if (d.platform === "linux") {
    const r = await d.exec("systemctl", ["--user", "is-active", SYSTEMD_UNIT]).catch(() => null);
    return { file, running: r?.stdout.trim() === "active" };
  }
  const r = await d.exec("launchctl", ["print", `gui/${d.uid}/${LAUNCHD_LABEL}`]).catch(() => null);
  return { file, running: r !== null && r.code === 0 && /\bstate = running\b/.test(r.stdout) };
}
