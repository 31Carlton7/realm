import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { encode } from "uqr";
import { connect } from "./client";
import { runCtl, type CtlIo } from "./commands";
import { terminalQr } from "./qr";
import { launchdPlist, LAUNCHD_LABEL, systemdUnit, type ServiceSpec } from "./service";
import { tailnetName, tailscaleServe, type Exec } from "./tailscale";

/** An exec that records what it was asked to run and answers from a script of replies. */
function fakeExec(reply: (cmd: string, args: string[]) => { code?: number; stdout?: string; stderr?: string } | Error = () => ({})) {
  const ran: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    ran.push([cmd, ...args]);
    const r = reply(cmd, args);
    if (r instanceof Error) throw r;
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { exec, ran };
}

const spec: ServiceSpec = {
  argv: ["/opt/node/bin/node", "/srv/realm app/dist/realm.js", "serve", "--home", "/home/ada/Realm", "--listen", "127.0.0.1:7420", "--tailscale"],
  path: "/opt/node/bin:/usr/bin:/bin", runAsNode: false, home: "/home/ada/Realm",
};

describe("the service files", () => {
  it("a systemd unit runs exactly that realm serve, restarts it on failure, and holds no secret", () => {
    const unit = systemdUnit({ ...spec, argv: [...spec.argv, "--tls-cert", "/etc/100%/$HOME.pem"] });
    expect(unit).toContain('ExecStart="/opt/node/bin/node" "/srv/realm app/dist/realm.js" "serve" "--home" "/home/ada/Realm" "--listen" "127.0.0.1:7420" "--tailscale"');
    // systemd expands % and $ in ExecStart; a path that has them is passed through as written.
    expect(unit).toContain('"/etc/100%%/$$HOME.pem"');
    expect(unit).toContain('Environment="REALM_SERVICE=1"');
    expect(unit).toContain('Environment="PATH=/opt/node/bin:/usr/bin:/bin"');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).not.toMatch(/rlm_|token/i);
  });

  it("a launchd agent is well-formed XML with every argument escaped", () => {
    const plist = launchdPlist({ ...spec, argv: [...spec.argv, "--tls-cert", "/Users/a&b/<cert>.pem"], runAsNode: true });
    expect(plist).toContain(`<key>Label</key><string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<string>/Users/a&amp;b/&lt;cert&gt;.pem</string>");
    expect(plist).toContain("<key>ELECTRON_RUN_AS_NODE</key><string>1</string>");
    expect(plist).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
    expect(plist).toContain(`<string>${join("/home/ada/Realm", "logs", "service.log")}</string>`);
    expect(plist).not.toContain("&b/<");
  });
});

/** `realm service …` with every outside effect faked, on the platform asked for. */
async function service(platform: string, argv: string[], reply?: Parameters<typeof fakeExec>[0]) {
  const { exec, ran } = fakeExec(reply);
  const files = new Map<string, string>();
  const out: string[] = [];
  const io: CtlIo = {
    out: (s) => out.push(s), err: () => {}, env: { PATH: "/opt/node/bin:/usr/bin", USER: "ada", REALM_HOME: "/home/ada/Realm" }, cwd: "/home/ada", connect, serve: async () => {},
    exec, self: { execPath: "/opt/node/bin/node", script: "/srv/realm/dist/realm.js", runAsNode: false },
    service: { platform, userHome: "/home/ada", uid: 501, writeFile: (p, t) => files.set(p, t), removeFile: (p) => files.delete(p), mkdir: () => {} },
  };
  const code = await runCtl(["--json", "service", ...argv], io);
  return { code, json: out.length ? JSON.parse(out.join("\n")) : null, ran, files };
}

describe("realm service", () => {
  it("installs a systemd user unit and starts it, saying how to keep it up after logout", async () => {
    const r = await service("linux", ["install", "--listen", "127.0.0.1:7420"], (cmd) => (cmd === "loginctl" ? { stdout: "no\n" } : {}));
    expect(r.code).toBe(0);
    const file = "/home/ada/.config/systemd/user/realm.service";
    expect(r.json.argv).toEqual(["/opt/node/bin/node", "/srv/realm/dist/realm.js", "serve", "--home", "/home/ada/Realm", "--listen", "127.0.0.1:7420"]);
    expect(r.files.get(file)).toContain('ExecStart="/opt/node/bin/node" "/srv/realm/dist/realm.js" "serve" "--home" "/home/ada/Realm" "--listen" "127.0.0.1:7420"');
    expect(r.ran).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "realm.service"],
      ["loginctl", "show-user", "ada", "--property=Linger", "--value"],
    ]);
  });

  it("refuses to install a listener the rules refuse, before writing anything", async () => {
    const r = await service("linux", ["install", "--listen", "0.0.0.0:7420"]);
    expect(r.json.error.code).toBe("LISTEN_REFUSED");
    expect(r.files.size).toBe(0);
    expect(r.ran).toEqual([]);
  });

  it("installs a launchd agent on a Mac, replacing one already loaded", async () => {
    const r = await service("darwin", ["install", "--tailscale"]);
    expect(r.code).toBe(0);
    const file = `/home/ada/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;
    expect(r.files.get(file)).toContain("<string>--tailscale</string>");
    expect(r.ran).toEqual([
      ["launchctl", "bootout", `gui/501/${LAUNCHD_LABEL}`],
      ["launchctl", "bootstrap", "gui/501", file],
    ]);
  });

  it("uninstalls, and reports status from the service manager", async () => {
    const off = await service("linux", ["uninstall"]);
    expect(off.ran[0]).toEqual(["systemctl", "--user", "disable", "--now", "realm.service"]);
    const up = await service("linux", ["status"], () => ({ stdout: "active\n" }));
    expect(up.json.running).toBe(true);
    const down = await service("darwin", ["status"], () => ({ code: 113, stdout: "" }));
    expect(down.code).toBe(1);
  });

  it("refuses a platform it has no service manager for, and a service for a server elsewhere", async () => {
    expect((await service("win32", ["install"])).json.error.code).toBe("UNSUPPORTED");
    expect((await service("linux", ["install", "--server", "wss://example.com"])).json.error.code).toBe("USAGE");
  });
});

describe("realm serve --tailscale", () => {
  const status = (over: object = {}) => JSON.stringify({ BackendState: "Running", Self: { DNSName: "vps.tail1234.ts.net." }, ...over });

  it("puts Tailscale Serve in front of a loopback listener, and takes it down again on exit", async () => {
    const { exec, ran } = fakeExec((_c, args) => (args[0] === "status" ? { stdout: status() } : {}));
    const served: unknown[] = []; const exits: string[][] = []; const err: string[] = [];
    const code = await runCtl(["serve", "--tailscale"], {
      out: () => {}, err: (s) => err.push(s), env: { REALM_HOME: "/tmp/h" }, cwd: "/", connect,
      serve: async (_h, o) => { served.push(o.listen); }, exec, atExit: (c, a) => exits.push([c, ...a]),
    });
    expect(code).toBeNull();
    expect(served).toEqual([{ host: "127.0.0.1", port: 7420, tls: null, allowPlaintext: false }]);
    expect(ran).toEqual([["tailscale", "status", "--json"], ["tailscale", "serve", "--bg", "--https=443", "http://127.0.0.1:7420"]]);
    expect(exits).toEqual([["tailscale", "serve", "--https=443", "off"]]);
    expect(err.join("\n")).toContain("wss://vps.tail1234.ts.net");
  });

  it("says so before booting anything on a machine that is not on a tailnet", async () => {
    for (const reply of [() => new Error("spawn tailscale ENOENT"), () => ({ stdout: status({ BackendState: "NeedsLogin" }) })]) {
      const { exec } = fakeExec(reply);
      const served: unknown[] = []; const out: string[] = [];
      const code = await runCtl(["serve", "--tailscale", "--json"], { out: (s) => out.push(s), err: () => {}, env: {}, cwd: "/", connect, serve: async () => { served.push(1); }, exec });
      expect(code).toBe(1);
      expect(JSON.parse(out[0]!).error.code).toBe("TAILSCALE");
      expect(served).toEqual([]);
    }
  });

  it("only fronts a loopback listener", async () => {
    const out: string[] = [];
    const code = await runCtl(["serve", "--tailscale", "--listen", "100.64.0.9:7420", "--json"], { out: (s) => out.push(s), err: () => {}, env: {}, cwd: "/", connect, serve: async () => {}, exec: fakeExec().exec });
    expect(code).toBe(2);
    expect(JSON.parse(out[0]!).error.message).toMatch(/loopback/);
  });

  it("names the URL with a port other than 443", async () => {
    const { exec } = fakeExec((_c, args) => (args[0] === "status" ? { stdout: status() } : {}));
    expect(await tailnetName(exec)).toBe("vps.tail1234.ts.net");
    expect(await tailscaleServe(exec, { name: "vps.tail1234.ts.net", port: 7420, httpsPort: 8443 })).toEqual({ url: "wss://vps.tail1234.ts.net:8443", off: ["serve", "--https=8443", "off"] });
  });
});

describe("the pairing code in a terminal", () => {
  const link = `https://realm.computer/pair#1.${"x".repeat(340)}`;

  it("draws every module of the code: two to a cell, black on white", () => {
    const qr = encode(link, { ecc: "M", border: 2 });
    const lines = terminalQr(link, { columns: 100, color: false }).split("\n");
    expect(lines).toHaveLength(Math.ceil(qr.size / 2));
    lines.forEach((line, row) => {
      expect([...line]).toHaveLength(qr.size);
      [...line].forEach((ch, x) => {
        const top = qr.data[row * 2]![x]!; const bottom = qr.data[row * 2 + 1]?.[x] ?? false;
        expect(ch).toBe(top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ");
      });
    });
    expect(terminalQr(link, { columns: 100 }).split("\n")[0]).toMatch(/^\x1b\[38;5;16;48;5;231m.*\x1b\[0m$/);
  });

  it("steps down to correction level L to fit an 80-column terminal", () => {
    const wide = terminalQr(link, { columns: 100, color: false }).split("\n")[0]!;
    const narrow = terminalQr(link, { columns: 80, color: false }).split("\n")[0]!;
    expect([...wide].length).toBeGreaterThan(80);
    expect([...narrow].length).toBeLessThanOrEqual(80);
  });
});
