import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { parseScreen, parseStream, serveSimCommand, parseUiState, parseAxTree, parseEvents, parseClaim, serveSim, AxReadTimedOut, type ServeSimExec, type ServeSimStream } from "./serve-sim";

/** Both transcribed from a real `serve-sim@0.1.46` run against a booted iPhone 17 Pro. */
const DETACHED = '{"url":"http://127.0.0.1:3100","streamUrl":"http://127.0.0.1:3100/helper/75D1511C-5E00-41A6-9CA2-1650DEAAF571/stream.mjpeg","wsUrl":"ws://127.0.0.1:3100/helper/75D1511C-5E00-41A6-9CA2-1650DEAAF571/ws","port":3100,"device":"75D1511C-5E00-41A6-9CA2-1650DEAAF571"}';
const LISTED = '{"running":true,"url":"http://127.0.0.1:3100","streamUrl":"http://127.0.0.1:3100/helper/75D1511C-5E00-41A6-9CA2-1650DEAAF571/stream.mjpeg","wsUrl":"ws://127.0.0.1:3100/helper/75D1511C-5E00-41A6-9CA2-1650DEAAF571/ws","port":3100,"device":"75D1511C-5E00-41A6-9CA2-1650DEAAF571","pid":8827}';

describe("what serve-sim says it is doing", () => {
  it("reads the stream out of `--list`", () => {
    expect(parseStream(LISTED)).toEqual({
      running: true,
      device: "75D1511C-5E00-41A6-9CA2-1650DEAAF571",
      url: "http://127.0.0.1:3100",
      streamUrl: "http://127.0.0.1:3100/helper/75D1511C-5E00-41A6-9CA2-1650DEAAF571/stream.mjpeg",
      wsUrl: "ws://127.0.0.1:3100/helper/75D1511C-5E00-41A6-9CA2-1650DEAAF571/ws",
      port: 3100, pid: 8827,
    });
  });

  it("reads the one `--detach` prints, which carries no `running` field at all", () => {
    // THE flag-trusting mutant: require `running === true`. `--detach` reports the stream it just
    // started and never sets that field, so the pane would come up believing nothing was serving —
    // and start a second daemon on the next press.
    const s = parseStream(DETACHED);
    expect(s.running).toBe(true);
    expect(s.streamUrl).toContain("stream.mjpeg");
    expect(s.pid).toBeNull();
  });

  it("says nothing is running when nothing is", () => {
    expect(parseStream('{"running":false}')).toMatchObject({ running: false, streamUrl: null, wsUrl: null });
  });

  it("finds the JSON under a human-readable banner, and takes the last one", () => {
    // `-q` suppresses the banner, but a version that printed one anyway must not make this fail —
    // and a run that printed two objects is reporting its final state last.
    expect(parseStream(`serve-sim 0.1.46\nStreaming iPhone 17 Pro…\n${DETACHED}`).port).toBe(3100);
    expect(parseStream(`{"running":false}\n${DETACHED}`).streamUrl).toContain("stream.mjpeg");
  });

  it("degrades to nothing rather than throwing on junk", () => {
    for (const junk of ["", "command not found: serve-sim", "{oops", "null"]) {
      expect(parseStream(junk).streamUrl, junk).toBeNull();
    }
  });
});

describe("the screen's own size", () => {
  it("is read from /config once there is a frame", () => {
    expect(parseScreen('{"width":1206,"height":2622,"orientation":"portrait"}'))
      .toEqual({ width: 1206, height: 2622, orientation: "portrait" });
  });

  it("treats the zeroes serve-sim reports before the first frame as `not yet`", () => {
    // MEASURED: `/config` answers {"width":0,"height":0,"orientation":"portrait"} from the moment the
    // daemon is up until the capture engine has a frame. THE zero-trusting mutant scales the pane to
    // a 0×0 screen, which is a pane that is permanently blank and says it is live.
    expect(parseScreen('{"width":0,"height":0,"orientation":"portrait"}')).toBeNull();
    expect(parseScreen('{"width":-1,"height":10,"orientation":"portrait"}')).toBeNull();
    expect(parseScreen("not json")).toBeNull();
  });

  it("rounds to whole pixels and defaults an orientation it was not told", () => {
    expect(parseScreen('{"width":1206.4,"height":2622.6}')).toEqual({ width: 1206, height: 2623, orientation: "portrait" });
  });
});

describe("how the CLI is run", () => {
  it("goes through npx by default, and through a binary when one is named", () => {
    // npx needs the network the first time and costs seconds every time, so an installed serve-sim
    // wins — and the env var is what a packaged build, or a test, points at something else.
    expect(serveSimCommand({})).toEqual({ bin: "npx", prefix: ["--yes", "serve-sim@latest"] });
    expect(serveSimCommand({ REALM_SERVE_SIM_BIN: "/usr/local/bin/serve-sim" })).toEqual({ bin: "/usr/local/bin/serve-sim", prefix: [] });
    expect(serveSimCommand({ REALM_SERVE_SIM_BIN: "   " }).bin).toBe("npx");
  });
});

describe("the serve-sim binary npx has cached", () => {
  const UDID = "75D1511C-5E00-41A6-9CA2-1650DEAAF571";
  const CACHED = "/Users/someone/.npm/_npx/0123456789abcdef/node_modules/.bin/serve-sim";
  /** A fake npx and serve-sim: npx names the cached binary, the binary answers each command, and
   *  every run is written down. `cost` is how long each one takes, in ms. */
  const fakeExec = (o: { resolved?: string | null; cost?: { npx: number; bin: number }; missing?: () => boolean } = {}) => {
    const calls: { bin: string; args: string[] }[] = [];
    const exec: ServeSimExec = async (bin, args) => {
      calls.push({ bin, args });
      if (o.cost) await new Promise((r) => setTimeout(r, bin === "npx" ? o.cost!.npx : o.cost!.bin));
      if (bin !== "npx" && o.missing?.()) return { code: 1, stdout: "", stderr: "spawn ENOENT", missing: true };
      if (args.includes("--call")) return o.resolved === null ? { code: 1, stdout: "", stderr: "npm error 404" } : { code: 0, stdout: `${o.resolved ?? CACHED}\n`, stderr: "" };
      if (args.includes("--detach")) return { code: 0, stdout: DETACHED, stderr: "" };
      if (args.includes("--list")) return { code: 0, stdout: LISTED, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    return { exec, calls };
  };

  it("asks npx once where serve-sim is, and runs that binary for every command after", async () => {
    const { exec, calls } = fakeExec();
    const sim = serveSim({}, fetch, exec);
    expect((await sim.find(UDID)).streamUrl).toContain(UDID);
    expect((await sim.start(UDID)).stream.streamUrl).toContain(UDID);
    await sim.kill(UDID);
    expect(calls).toEqual([
      { bin: "npx", args: ["--yes", "--package", "serve-sim@latest", "--call", "command -v serve-sim"] },
      { bin: CACHED, args: ["--list", UDID] },
      { bin: CACHED, args: ["--detach", "-q", UDID] },
      { bin: CACHED, args: ["--kill", UDID] },
    ]);
  });

  it("asks npx once for calls that arrive together, while it is still answering", async () => {
    const { exec, calls } = fakeExec({ cost: { npx: 20, bin: 0 } });
    const sim = serveSim({}, fetch, exec);
    await Promise.all([sim.find(UDID), sim.find(UDID), sim.ui(UDID)]);
    expect(calls.filter((c) => c.bin === "npx")).toHaveLength(1);
  });

  it("goes through npx for each command when npx cannot name a binary", async () => {
    const { exec, calls } = fakeExec({ resolved: null });
    const sim = serveSim({}, fetch, exec);
    expect((await sim.find(UDID)).streamUrl).toContain(UDID);
    expect(calls.at(-1)).toEqual({ bin: "npx", args: ["--yes", "serve-sim@latest", "--list", UDID] });
  });

  it("asks npx again when the cached binary has been cleared away, and still answers", async () => {
    let gone = false;
    const { exec, calls } = fakeExec({ missing: () => gone && calls.filter((c) => c.bin === "npx").length < 2 });
    const sim = serveSim({}, fetch, exec);
    await sim.find(UDID);
    gone = true;
    expect((await sim.find(UDID)).streamUrl).toContain(UDID);
    expect(calls.filter((c) => c.bin === "npx")).toHaveLength(2);
  });

  it("never asks npx when a binary is named", async () => {
    const { exec, calls } = fakeExec();
    await serveSim({ REALM_SERVE_SIM_BIN: "/opt/serve-sim" }, fetch, exec).find(UDID);
    expect(calls).toEqual([{ bin: "/opt/serve-sim", args: ["--list", UDID] }]);
  });

  it("keeps a pane's connect inside its budget when npx is slow", async () => {
    // What opening a pane asks serve-sim, and then what the pane's menu asks, against an npx that
    // takes 250 ms a call — a quiet Mac's cost is 0.9 s, so this is generous to npx. Through npx
    // each time this is six calls and 1.5 s; through the cached binary it is one npx call.
    const { exec } = fakeExec({ cost: { npx: 250, bin: 2 } });
    const sim = serveSim({}, fetch, exec);
    const t0 = performance.now();
    await sim.find(UDID);
    await sim.start(UDID);
    await sim.ui(UDID);
    await sim.eventLog(UDID, 20);
    await sim.find(UDID);
    await sim.kill(UDID);
    expect(performance.now() - t0).toBeLessThan(600);
  });
});

describe("parseUiState", () => {
  it("reads `ui status --json` — captured from the CLI on a booted iPhone, not composed here", () => {
    const wire = '{"liquid-glass":"clear","color-filter":"none","reduce-motion":"off","show-borders":"off",'
      + '"reduce-transparency":"off","voiceover":"off","appearance":"light","text-size":"large","increase-contrast":"off"}';
    expect(parseUiState(wire)).toEqual({
      "liquid-glass": "clear", "color-filter": "none", "reduce-motion": "off", "show-borders": "off",
      "reduce-transparency": "off", voiceover: "off", appearance: "light", "text-size": "large",
      "increase-contrast": "off",
    });
  });

  it("keeps an option this build has never heard of", () => {
    // A newer serve-sim gains a switch; it belongs in the menu, not in the gap between two versions.
    expect(parseUiState('{"appearance":"dark","a-switch-from-2027":"on"}')).toEqual({ appearance: "dark", "a-switch-from-2027": "on" });
  });

  it("is no answer at all for anything that is not a flat object of strings", () => {
    expect(parseUiState("")).toBeNull();
    expect(parseUiState("not json")).toBeNull();
    expect(parseUiState("{}")).toBeNull();
    expect(parseUiState('{"appearance":{"nested":true}}')).toBeNull();
  });

  it("takes the LAST JSON line, the way every other read here does — npx prints its own noise first", () => {
    expect(parseUiState('npm warn exec\n{"appearance":"dark"}')).toEqual({ appearance: "dark" });
  });
});

describe("parseAxTree", () => {
  /** Captured from `/helper/<udid>/ax` on a booted iPhone 17 Pro Max — a NESTED array of roots,
   *  frames in POINTS. The skill's write-up describes a flat `{screen, elements}` body that this
   *  build does not send; a parser written from the documentation finds nothing at all. */
  const WIRE = JSON.stringify([{
    AXLabel: "Safari", AXValue: null, AXUniqueId: null, enabled: true, type: "Application",
    frame: { x: 0, y: 0, width: 440, height: 956 },
    children: [
      { AXLabel: "Back", AXValue: null, AXUniqueId: "BackButton", enabled: false, type: "Button",
        role_description: "button", frame: { y: 874, x: 34, width: 48, height: 48 }, children: [] },
      { AXLabel: "", AXValue: "localhost", AXUniqueId: null, enabled: true, type: "TextField",
        frame: { x: 90, y: 870, width: 200, height: 20 },
        children: [{ AXLabel: "Reload", AXValue: null, AXUniqueId: null, enabled: true, type: "Button", frame: { x: 250, y: 870, width: 30, height: 20 }, children: [] }] },
    ],
  }]);

  it("flattens the tree and keeps the index path as the handle", () => {
    const tree = parseAxTree(WIRE)!;
    expect(tree.app).toBe("Safari");
    expect(tree.screen).toEqual({ width: 440, height: 956 });
    expect(tree.elements.map((e) => e.path)).toEqual(["0.0", "0.1", "0.1.0"]);
    expect(tree.elements[0]).toMatchObject({ label: "Back", role: "Button", id: "BackButton", enabled: false, depth: 1 });
    expect(tree.elements[2]).toMatchObject({ label: "Reload", depth: 2 });
  });

  it("carries a value through, and reports frames in the points the tree speaks", () => {
    const tree = parseAxTree(WIRE)!;
    expect(tree.elements[1]).toMatchObject({ value: "localhost", frame: { x: 90, y: 870, width: 200, height: 20 } });
  });

  it("is no tree at all for anything unparseable, or for a root with no frame", () => {
    expect(parseAxTree("")).toBeNull();
    expect(parseAxTree("not json")).toBeNull();
    expect(parseAxTree("[]")).toBeNull();
    expect(parseAxTree(JSON.stringify([{ AXLabel: "No frame", children: [] }]))).toBeNull();
  });

  it("drops a node with a collapsed frame rather than drawing a zero-sized box on the picture", () => {
    const tree = parseAxTree(JSON.stringify([{
      AXLabel: "App", enabled: true, type: "Application", frame: { x: 0, y: 0, width: 440, height: 956 },
      children: [{ AXLabel: "Hidden", type: "Button", enabled: true, frame: { x: 0, y: 0, width: 0, height: 0 }, children: [] }],
    }]))!;
    expect(tree.elements).toHaveLength(0);
  });
});

describe("serveSim's tree read", () => {
  const stream: ServeSimStream = { running: true, device: "UDID", url: "http://127.0.0.1:3100", streamUrl: null, wsUrl: null, port: 3100, pid: 1 };
  const read = (answer: () => Promise<Response>) => serveSim({}, answer as unknown as typeof fetch).ax(stream, "UDID");

  it("is no tree for a 503 or a dropped connection — the device's \"not yet\"", async () => {
    expect(await read(async () => new Response("", { status: 503 }))).toBeNull();
    expect(await read(async () => { throw new TypeError("fetch failed"); })).toBeNull();
  });

  it("is an AxReadTimedOut when the daemon does not answer in time (#645)", async () => {
    // THE MUTANT: a timeout read as "not yet", which every step then asks again.
    await expect(read(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); })).rejects.toBeInstanceOf(AxReadTimedOut);
  });
});

describe("parseEvents", () => {
  it("reads the CLI's pretty-printed JSON, which is never one line", () => {
    const wire = `{\n  "events": [\n    {\n      "source": "hid",\n      "kind": "tap",\n      "summary": "Tap 0.5,0.1"\n    }\n  ]\n}`;
    expect(parseEvents(wire)).toEqual([{ source: "hid", kind: "tap", summary: "Tap 0.5,0.1", at: null }]);
  });

  it("falls back to the action when an event carries no kind, and is empty for anything else", () => {
    expect(parseEvents('{"events":[{"source":"cli","action":"button","summary":"Home"}]}')[0])
      .toMatchObject({ kind: "button", summary: "Home" });
    expect(parseEvents("nothing here")).toEqual([]);
    expect(parseEvents('{"not":"events"}')).toEqual([]);
  });
});

describe("serve-sim's own records of what it is streaming", () => {
  /** Transcribed from `$TMPDIR/serve-sim/server-<udid>.json` beside a live `serve-sim@0.1.47` stream. */
  const RECORD = `{
  "pid": 42849,
  "port": 3100,
  "device": "75D1511C-5E00-41A6-9CA2-1650DEAAF571",
  "url": "http://127.0.0.1:3100",
  "streamUrl": "http://127.0.0.1:3100/helper/75D1511C-5E00-41A6-9CA2-1650DEAAF571/stream.mjpeg",
  "wsUrl": "ws://127.0.0.1:3100/helper/75D1511C-5E00-41A6-9CA2-1650DEAAF571/ws"
}`;

  it("reads which device a record is for and the port it holds", () => {
    expect(parseClaim(RECORD)).toEqual({ device: "75D1511C-5E00-41A6-9CA2-1650DEAAF571", port: 3100 });
  });

  it("is no claim at all without a device and a real port", () => {
    // THE MUTANT: accept a record with no port. It then claims port `undefined`, and a guard that
    // compares loosely anywhere downstream refuses a URL that nothing is streaming on.
    expect(parseClaim('{"device":"X"}')).toBe(null);
    expect(parseClaim('{"device":"X","port":0}')).toBe(null);
    expect(parseClaim('{"device":"X","port":3100.5}')).toBe(null);
    expect(parseClaim('{"port":3100}')).toBe(null);
    expect(parseClaim("not json")).toBe(null);
  });

  it("lists every per-device record in the state directory, and nothing else there", async () => {
    const dir = tempDir("realm-serve-sim-state-");
    writeFileSync(join(dir, "server-75D1511C-5E00-41A6-9CA2-1650DEAAF571.json"), RECORD);
    writeFileSync(join(dir, "server-OTHER.json"), '{"device":"OTHER","port":3101,"pid":1}');
    // The deprecated single-stream file: `--list` itself skips it, since it names no device of its own.
    writeFileSync(join(dir, "server.json"), '{"device":"OLD","port":3099,"pid":1}');
    // A helper's log beside its record. Only `.json` files are records — `--list` reads nothing else —
    // so a log line that happens to parse is still not a claim on a port.
    writeFileSync(join(dir, "server-OTHER.log"), '{"device":"FROM-A-LOG","port":3102}');
    writeFileSync(join(dir, "server-BROKEN.json"), "{ half a file");
    const claims = await serveSim({ REALM_SERVE_SIM_STATE_DIR: dir }).claims();
    expect(claims.sort((a, b) => a.port - b.port)).toEqual([
      { device: "75D1511C-5E00-41A6-9CA2-1650DEAAF571", port: 3100 },
      { device: "OTHER", port: 3101 },
    ]);
  });

  it("is empty, not an error, on a Mac where serve-sim has never run", async () => {
    const missing = join(tempDir("realm-serve-sim-none-"), "serve-sim");
    expect(await serveSim({ REALM_SERVE_SIM_STATE_DIR: missing }).claims()).toEqual([]);
    mkdirSync(missing);
    expect(await serveSim({ REALM_SERVE_SIM_STATE_DIR: missing }).claims()).toEqual([]);
  });
});
