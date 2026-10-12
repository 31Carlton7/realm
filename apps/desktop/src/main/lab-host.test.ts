import { describe, expect, it } from "vitest";
import { LAB_SETTINGS_PANES } from "@realm/contracts";
import { decideHandoff } from "./handoff-policy";
import { labInstall, labOnConnected, labPreapprovesRestart, labSettingsUrl, labTakesUpdate, loginItemStatus, setLoginItem, type LabUpdateDeps } from "./lab-host";

describe("login item", () => {
  const fake = (packaged: boolean) => {
    let on = false;
    const writes: boolean[] = [];
    return { writes, d: { packaged, get: () => ({ openAtLogin: on }), set: (s: { openAtLogin: boolean }) => { writes.push(s.openAtLogin); on = s.openAtLogin; } } };
  };

  it("turns on and off again from the installed app, answering with what macOS then reports", () => {
    const f = fake(true);
    expect(loginItemStatus(f.d)).toEqual({ openAtLogin: false, canSet: true });
    expect(setLoginItem(f.d, true)).toEqual({ openAtLogin: true, canSet: true });
    expect(setLoginItem(f.d, false)).toEqual({ openAtLogin: false, canSet: true });
    expect(f.writes).toEqual([true, false]);
  });

  it("never touches the login items from a development build, or for a value that is not a yes or no", () => {
    const dev = fake(false);
    expect(setLoginItem(dev.d, true)).toEqual({ openAtLogin: false, canSet: false });
    const f = fake(true);
    setLoginItem(f.d, "yes");
    expect([...dev.writes, ...f.writes]).toEqual([]);
  });

  it("says unknown when macOS will not say", () => {
    expect(loginItemStatus({ packaged: true, get: () => { throw new Error("SMAppService"); }, set: () => {} })).toEqual({ openAtLogin: null, canSet: true });
  });
});

describe("System Settings panes", () => {
  it("maps every pane a check can name, and nothing else", () => {
    for (const p of LAB_SETTINGS_PANES) expect(labSettingsUrl(p)).toMatch(/^x-apple\.systempreferences:com\.apple\./);
    expect(labSettingsUrl("https://example.com")).toBeNull();
    expect(labSettingsUrl(null)).toBeNull();
  });
});

describe("the update window, main's side", () => {
  function fake(o: { lab: boolean; state?: { kind: string; version?: string }; server?: boolean }) {
    const calls: string[] = [];
    let installs = 0;
    const d: LabUpdateDeps = {
      version: "2.0.3",
      call: async (method, params) => {
        if (o.server === false) throw new Error("not connected");
        calls.push(`${method} ${JSON.stringify(params)}`);
        if (method === "settings.get") return { value: o.lab };
        return {};
      },
      updater: { status: () => ({ state: o.state ?? { kind: "idle" } }), install: () => { installs++; } },
    };
    return { d, calls, get installs() { return installs; } };
  }

  it("hands a downloaded update to the window on a lab, so no dialog waits for nobody", async () => {
    const f = fake({ lab: true });
    expect(await labTakesUpdate(f.d, "2.1.0")).toBe(true);
    expect(f.calls).toContain('lab.updateReady {"version":"2.1.0","from":"2.0.3"}');
  });

  it("leaves it to the dialog on a Mac that is not a lab, or with no server to ask", async () => {
    expect(await labTakesUpdate(fake({ lab: false }).d, "2.1.0")).toBe(false);
    expect(await labTakesUpdate(fake({ lab: true, server: false }).d, "2.1.0")).toBe(false);
  });

  it("says its version on connect, and reports an update downloaded before the server was up", async () => {
    const f = fake({ lab: true, state: { kind: "downloaded", version: "2.1.0" } });
    await labOnConnected(f.d);
    expect(f.calls[0]).toBe('lab.appVersion {"version":"2.0.3"}');
    expect(f.calls).toContain('lab.updateReady {"version":"2.1.0","from":"2.0.3"}');
  });

  it("installs only the update the updater holds", () => {
    const f = fake({ lab: true, state: { kind: "downloaded", version: "2.1.0" } });
    expect(labInstall(f.d, { version: "2.2.0" })).toBe(false);
    expect(f.installs).toBe(0);
    expect(labInstall(f.d, { version: "2.1.0" })).toBe(true);
    expect(f.installs).toBe(1);
    const idle = fake({ lab: true });
    expect(labInstall(idle.d, { version: "2.1.0" })).toBe(false);
  });

  it("restarts the replaced daemon without asking only while the window is installing", async () => {
    const asking = (value: unknown) => async () => ({ value });
    expect(await labPreapprovesRestart(asking({ kind: "installing", version: "2.1.0" }))).toBe(true);
    expect(await labPreapprovesRestart(asking({ kind: "draining" }))).toBe(false);
    expect(await labPreapprovesRestart(asking(null))).toBe(false);
    expect(await labPreapprovesRestart(async () => { throw new Error("old daemon"); })).toBe(false);
    // And the handoff honours it over work it would otherwise ask about.
    expect(decideHandoff({ why: "bundle", work: { working: 1, activeRuns: 3 }, preapproved: true })).toEqual({ kind: "restart" });
    expect(decideHandoff({ why: "bundle", work: { working: 1, activeRuns: 3 } }).kind).toBe("confirm");
  });
});
