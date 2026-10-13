import { describe, expect, it } from "vitest";
import type { LabCheck } from "@realm/contracts";
import { evaluate, hardwarePortOf, parseDisplays, parsePmset, parsePowerBackup, probeFacts, type ProbeDeps, type ReadinessFacts, type RunResult } from "./readiness";

/* What this laptop answered (read-only, 2026-10-09), and what a Mac mini set up as a lab answers. */
const LAPTOP_PMSET = `System-wide power settings:
 SleepDisabled\t\t0
Currently in use:
 standby              1
 Sleep On Power Button 1
 hibernatefile        /var/vm/sleepimage
 powernap             1
 networkoversleep     0
 disksleep            10
 sleep                1 (sleep prevented by powerd, sharingd)
 hibernatemode        3
 ttyskeepawake        1
 displaysleep         0 (display sleep prevented by Realm)
 tcpkeepalive         1
 powermode            0
 womp                 0
`;
const MINI_PMSET = `System-wide power settings:
 SleepDisabled\t\t0
Currently in use:
 standby              0
 Sleep On Power Button 1
 autorestart          1
 hibernatefile        /var/vm/sleepimage
 powernap             1
 networkoversleep     0
 disksleep            0
 sleep                0
 hibernatemode        0
 ttyskeepawake        1
 displaysleep         10
 tcpkeepalive         1
 womp                 1
`;
const LAPTOP_PS = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=23789667)\t91%; discharging; 2:10 remaining present: true\n";
const MINI_PS_UPS = "Now drawing from 'AC Power'\n -Back-UPS ES 600M1 (id=1234)\t100%; charged; present: true\n";
const MINI_PS_NONE = "Now drawing from 'AC Power'\n";
const LAPTOP_DISPLAYS = JSON.stringify({ SPDisplaysDataType: [{ _name: "Apple M4 Pro", spdisplays_ndrvs: [{ _name: "Color LCD", spdisplays_connection_type: "spdisplays_internal" }] }] });
const HEADLESS_DISPLAYS = JSON.stringify({ SPDisplaysDataType: [{ _name: "Apple M4" }] });
const PORTS = "\nHardware Port: Ethernet\nDevice: en0\nEthernet Address: aa\n\nHardware Port: Wi-Fi\nDevice: en1\nEthernet Address: bb\n";

const GB = 1024 ** 3;

const laptop: ReadinessFacts = {
  pmset: LAPTOP_PMSET, pmsetPs: LAPTOP_PS, fdesetup: "FileVault is On.\n", autoLoginUser: "",
  displaysJson: LAPTOP_DISPLAYS, freeBytes: 120 * GB, online: true, defaultInterface: "en1", hardwarePorts: PORTS, screenSharing: false,
};
const readyMini: ReadinessFacts = {
  pmset: MINI_PMSET, pmsetPs: MINI_PS_UPS, fdesetup: "FileVault is Off.\n", autoLoginUser: "lab",
  displaysJson: LAPTOP_DISPLAYS.replace("spdisplays_internal", "spdisplays_hdmi").replace("Color LCD", "Dummy 4K"),
  freeBytes: 400 * GB, online: true, defaultInterface: "en0", hardwarePorts: PORTS, screenSharing: true,
};

const byId = (checks: LabCheck[]) => Object.fromEntries(checks.map((c) => [c.id, c]));

describe("parsers", () => {
  it("reads pmset's numbers and drops what it says about who is preventing sleep", () => {
    const pm = parsePmset(LAPTOP_PMSET);
    expect(pm["sleep"]).toBe(1);
    expect(pm["disksleep"]).toBe(10);
    expect(pm["SleepDisabled"]).toBe(0);
    expect(pm["Sleep On Power Button"]).toBe(1);
    expect(pm["autorestart"]).toBeUndefined();
    expect(parsePmset(MINI_PMSET)["autorestart"]).toBe(1);
  });
  it("tells a UPS from a battery from nothing", () => {
    expect(parsePowerBackup(MINI_PS_UPS)).toBe("ups");
    expect(parsePowerBackup(LAPTOP_PS)).toBe("battery");
    expect(parsePowerBackup(MINI_PS_NONE)).toBe("none");
  });
  it("lists displays across GPUs, and none for a headless Mac or bad JSON", () => {
    expect(parseDisplays(LAPTOP_DISPLAYS)).toEqual([{ name: "Color LCD", builtIn: true }]);
    expect(parseDisplays(HEADLESS_DISPLAYS)).toEqual([]);
    expect(parseDisplays("not json")).toEqual([]);
  });
  it("names the hardware port behind a device", () => {
    expect(hardwarePortOf(PORTS, "en1")).toBe("Wi-Fi");
    expect(hardwarePortOf(PORTS, "en0")).toBe("Ethernet");
    expect(hardwarePortOf(PORTS, "en9")).toBeNull();
  });
});

describe("evaluate", () => {
  it("passes a Mac mini set up as a lab on every check", () => {
    const checks = evaluate(readyMini);
    expect(checks.map((c) => [c.id, c.state])).toEqual([
      ["sleep", "ok"], ["power-failure", "ok"], ["filevault", "ok"], ["auto-login", "ok"], ["display", "ok"],
      ["disk", "ok"], ["network", "ok"], ["power-backup", "ok"], ["screen-sharing", "ok"],
    ]);
    expect(byId(checks)["auto-login"]!.fact).toBe("It logs in as lab when it starts.");
    expect(byId(checks)["network"]!.fact).toBe("Online over Ethernet (en0).");
  });

  it("says what this laptop lacks, with the exact admin command and never a one-click admin fix", () => {
    const c = byId(evaluate(laptop));
    expect(c["sleep"]).toMatchObject({ state: "attention", command: "sudo pmset -a sleep 0 disksleep 0", settingsPane: "energy", action: "keep-awake" });
    expect(c["sleep"]!.fact).toMatch(/sleeps after 1 minute idle/);
    expect(c["power-failure"]!.state).toBe("na");
    expect(c["filevault"]).toMatchObject({ state: "attention", settingsPane: "privacy", command: null });
    // FileVault on: macOS hides automatic login, and the fix says to deal with FileVault first.
    expect(c["auto-login"]!.state).toBe("attention");
    expect(c["auto-login"]!.fix).toMatch(/^Turn FileVault off first/);
    expect(c["display"]!.fact).toBe("Color LCD (built in).");
    expect(c["power-backup"]).toMatchObject({ state: "ok", fact: "It runs on its own battery." });
    expect(c["network"]!.fact).toMatch(/over Wi-Fi \(en1\)\. Ethernet is steadier/);
    expect(c["screen-sharing"]).toMatchObject({ state: "attention", settingsPane: "sharing" });
    // Nothing that needs an administrator is ever offered as a click.
    for (const check of Object.values(c)) if (check.command) expect(check.action === null || check.action === "keep-awake").toBe(true);
  });

  it("asks for a UPS, a display, disk and autorestart on a bare mini", () => {
    const c = byId(evaluate({
      ...readyMini, pmsetPs: MINI_PS_NONE, displaysJson: HEADLESS_DISPLAYS, freeBytes: 49.9 * GB,
      pmset: MINI_PMSET.replace("autorestart          1", "autorestart          0"),
    }));
    expect(c["power-backup"]!.state).toBe("attention");
    expect(c["display"]).toMatchObject({ state: "attention", fix: "Plug in an HDMI dummy plug, or keep a monitor on it." });
    expect(c["disk"]).toMatchObject({ state: "attention", fact: "49 GB free. A full disk can hang a Mac that is swapping." });
    expect(c["power-failure"]).toMatchObject({ state: "attention", command: "sudo pmset -a autorestart 1" });
  });

  it("counts `pmset disablesleep` as never sleeping", () => {
    expect(byId(evaluate({ ...laptop, pmset: LAPTOP_PMSET.replace("SleepDisabled\t\t0", "SleepDisabled\t\t1") }))["sleep"]!.state).toBe("ok");
  });

  it("says unknown, not ok, for every probe that failed", () => {
    const blind: ReadinessFacts = {
      pmset: null, pmsetPs: null, fdesetup: null, autoLoginUser: null, displaysJson: null, freeBytes: null,
      online: null, defaultInterface: null, hardwarePorts: null, screenSharing: null,
    };
    expect(new Set(evaluate(blind).map((c) => c.state))).toEqual(new Set(["unknown"]));
  });

  it("says offline when github.com does not resolve", () => {
    expect(byId(evaluate({ ...readyMini, online: false }))["network"]!.state).toBe("attention");
  });
});

describe("probeFacts", () => {
  /** A fake Mac: answers by command line, and records every command it was asked to run. */
  function fakeMac(answers: Record<string, RunResult>): ProbeDeps & { ran: string[] } {
    const ran: string[] = [];
    return {
      ran,
      run: async (cmd, args) => {
        const line = [cmd, ...args].join(" ");
        ran.push(line);
        const a = answers[line];
        if (!a) throw new Error(`unexpected ${line}`);
        return a;
      },
      freeBytes: async () => 80 * GB, resolves: async () => true, listening: async () => false, home: "/tmp/home",
    };
  }

  it("runs only read-only commands", async () => {
    const mac = fakeMac({
      "/usr/bin/pmset -g": { code: 0, stdout: MINI_PMSET },
      "/usr/bin/pmset -g ps": { code: 0, stdout: MINI_PS_UPS },
      "/usr/bin/fdesetup status": { code: 0, stdout: "FileVault is Off.\n" },
      "/usr/bin/defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser": { code: 1, stdout: "" },
      "/usr/sbin/system_profiler SPDisplaysDataType -json": { code: 0, stdout: HEADLESS_DISPLAYS },
      "/sbin/route -n get default": { code: 0, stdout: "   route to: default\n  interface: en0\n" },
      "/usr/sbin/networksetup -listallhardwareports": { code: 0, stdout: PORTS },
    });
    const facts = await probeFacts(mac);
    expect(facts.autoLoginUser).toBe("");
    expect(facts.defaultInterface).toBe("en0");
    expect(facts.freeBytes).toBe(80 * GB);
    expect(facts.screenSharing).toBe(false);
    for (const line of mac.ran) {
      expect(line).not.toMatch(/sudo|defaults write|pmset -a|pmset -c|systemsetup|sysadminctl|fdesetup (enable|disable|authrestart)/);
    }
    expect(mac.ran).toHaveLength(7);
  });

  it("turns a command that throws into a null fact, not a failed checklist", async () => {
    const facts = await probeFacts({
      run: async () => { throw new Error("spawn ENOENT"); },
      freeBytes: async () => { throw new Error("EACCES"); }, resolves: async () => true, listening: async () => true, home: "/x",
    });
    expect(facts.pmset).toBeNull();
    expect(facts.autoLoginUser).toBeNull();
    expect(facts.freeBytes).toBeNull();
    expect(facts.screenSharing).toBe(true);
  });
});
