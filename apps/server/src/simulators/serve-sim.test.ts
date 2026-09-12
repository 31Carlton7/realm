import { describe, expect, it } from "vitest";
import { parseScreen, parseStream, serveSimCommand, parseUiState, parseAxTree, parseEvents } from "./serve-sim";

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

  it("leaves the Application node out — it is the screen, not a control on it", () => {
    // An overlay that drew it would put a box around everything and call it a button.
    const tree = parseAxTree(WIRE)!;
    expect(tree.elements.some((e) => e.role === "Application")).toBe(false);
    expect(tree.elements).toHaveLength(3);
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
