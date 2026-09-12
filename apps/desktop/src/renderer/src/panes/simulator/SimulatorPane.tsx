import { Icon } from "@realm/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Simulator, SimulatorAxElement, SimulatorAxTree, SimulatorDevice, SimulatorState, SimulatorPlatform } from "@realm/contracts";
import type { PaneProps } from "../registry";
import { useApp } from "../../state/store";
import { rpc } from "../../rpc/client";
import { fitFramebuffer, PICTURE_RADIUS } from "../machine/fit";
import { squirclePath } from "../machine/squircle-path";
import { SimulatorInput, gestureFrame, keystrokeFrames, normalizedPoint } from "./sim-input";
import { fitFramed, frameMetrics } from "./device-frame";
import { artFor, fitDeviceArt } from "./device-art";
import { useFileDrop } from "../../components/use-file-drop";
import { sortForDevice } from "./device-files";
import { SimulatorHardware } from "./SimulatorBar";

/**
 * An Apple Simulator, shown and driven in a pane.
 *
 * The screen is an `<img>` on serve-sim's MJPEG stream — DOM, not a `WebContentsView` pointed at
 * serve-sim's own web UI. That is the same decision `MachinePane` makes and for the same reasons: a
 * native view composites above all DOM unconditionally, so menus, sheets and the command palette
 * would all have to dodge this pane, and `Page.captureScreenshot` would show a hole where the device
 * is. An `<img>` has none of that tax, and the stream is already inside the renderer's `img-src`.
 *
 * Input does NOT go through the picture. Taps, keys, buttons and rotation are frames on serve-sim's
 * websocket (`sim-input.ts`), which is the channel the device itself listens on — the preview page's
 * own controls are a different client of the same socket, not a layer to drive.
 */

const OFF = (simulatorId: string): SimulatorState =>
  ({ simulatorId, status: "off", udid: null, serial: null, streamUrl: null, wsUrl: null, screen: null, error: null, detail: null });

/** What the pane says about each failure. The service sends a WORD; this is the only place that
 *  turns one into a sentence — `MachinePane.REASONS`' arrangement, for its reason. */
const REASONS: Record<string, string> = {
  boot_failed: "That simulator would not boot.",
  serve_failed: "Realm could not start the stream for it.",
  no_frames: "The stream started, but the device has not drawn anything yet.",
  failed: "Something went wrong bringing the simulator up.",
};

export function SimulatorPane({ item, visible }: PaneProps) {
  const refId = item.refId;
  const state = useApp((s) => s.simulatorState[refId]) ?? OFF(refId);
  const applySimulatorState = useApp((s) => s.applySimulatorState);
  const [row, setRow] = useState<Simulator | null>(null);

  // Seed from the server once: the store only learns about a simulator when its state CHANGES, and
  // a pane that mounts onto a device chosen last week has missed every event that ever carried it.
  useEffect(() => {
    let live = true;
    void rpc().call("simulators.get", { simulatorId: refId }).then((r) => {
      if (!live) return;
      setRow(r.simulator);
      applySimulatorState(r.state);
    }).catch(() => {});
    return () => { live = false; };
  }, [refId, applySimulatorState]);

  const start = useCallback(async (udid: string | null, platform?: SimulatorPlatform) => {
    // `platform` rides with `udid` because they are one fact about one device. Omitted on a plain
    // retry, where the row already knows what it is pointed at.
    const r = await rpc().call("simulators.start", { simulatorId: refId, udid, platform });
    applySimulatorState(r.state);
    if (udid) setRow((s) => (s ? { ...s, udid, platform: platform ?? s.platform } : s));
  }, [refId, applySimulatorState]);

  const udid = state.udid ?? row?.udid ?? null;
  if (state.status === "running" && state.streamUrl && state.screen) {
    /* The platform comes off the ROW. The contract is explicit that it is carried rather than
       inferred, and it decides which device the stream is framed as — an emulator wearing an iPhone
       for the second before the row lands would be a worse answer than no frame for that second. */
    return <Screen state={state} visible={visible} simulatorId={refId} platform={row?.platform ?? null} />;
  }
  return (
    <div className="sim-pane">
      <div className="sim-body">
        {state.status === "failed"
          ? <Failed state={state} onRetry={() => void start(null)} onPick={(d, p) => void start(d, p)} />
          : state.status === "booting" || state.status === "serving"
            ? <Starting state={state} name={row?.name ?? null} />
            : <DevicePicker chosen={udid} onPick={(d, p) => void start(d, p)} />}
      </div>
    </div>
  );
}

/** The empty state, and the only place a device is chosen. A list rather than a select: the rows
 *  carry a runtime and a state each, which is what tells two iPhone 17 Pros apart. */
/** iOS first, then Android — the Mac's own platform leads, and a stable order beats one that
 *  changes with whatever happens to be booted. */
function groupsOf(devices: SimulatorDevice[]): [SimulatorPlatform, SimulatorDevice[]][] {
  const out: [SimulatorPlatform, SimulatorDevice[]][] = [];
  for (const platform of ["ios", "android"] as const) {
    const rows = devices.filter((d) => d.platform === platform);
    if (rows.length) out.push([platform, rows]);
  }
  return out;
}

/** "Already booted", in each toolchain's own word for it: simctl says `Booted`, adb says `device`. */
const running = (d: SimulatorDevice): boolean => (d.platform === "android" ? d.state === "device" : d.state === "Booted");

function DevicePicker({ chosen, onPick }: { chosen: string | null; onPick: (udid: string, platform: SimulatorPlatform) => void }) {
  const [devices, setDevices] = useState<SimulatorDevice[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void rpc().call("simulators.devices", {}).then((r) => {
      if (!live) return;
      setDevices(r.devices);
      setAvailable(r.available);
    }).catch(() => { if (live) setDevices([]); });
    return () => { live = false; };
  }, []);

  if (devices === null) return <p className="sim-hint">Looking for simulators…</p>;
  // design.md: where the precondition is unmet, say what is missing rather than showing a control
  // that cannot work. These are two different absences and they get two different sentences.
  if (!available) return (
    <div className="sim-rest">
      <h2 className="sim-title">No simulators here</h2>
      <p className="sim-hint">
        Realm could not run <code>xcrun simctl</code> or find an Android SDK. Install Xcode, or Android Studio, and this list fills itself in.
      </p>
    </div>
  );
  if (devices.length === 0) return (
    <div className="sim-rest">
      <h2 className="sim-title">No devices installed</h2>
      <p className="sim-hint">
        The tools are here but there is nothing to boot. Add an iOS runtime from Xcode ▸ Settings ▸ Components, or an Android virtual device from Android Studio ▸ Device Manager.
      </p>
    </div>
  );

  return (
    <div className="sim-rest">
      <h2 className="sim-title">Which simulator?</h2>
      <p className="sim-hint">Realm boots it if it is not running, streams its screen, and leaves it booted when the pane closes.</p>
      {/* Buttons in a named group, not a list of rows: each one DOES something, and a `listitem`
          role over a button takes its name-from-content away — a screen reader then reads the group
          and announces nothing about the device it is on. */}
      {/* Grouped by platform, and only when there is more than one: a Mac with no Android SDK must
          not grow a heading announcing the absence of a section. */}
      {groupsOf(devices).map(([platform, rows]) => (
        <div key={platform} className="sim-device-group">
          {groupsOf(devices).length > 1 && (
            /* The mark before the word, at the inline rung (12) because it leads text at 11px. `Icon`
               marks every glyph `aria-hidden` itself — the heading already says the word. */
            <div className="sim-group-label">
              <Icon name={platform === "android" ? "android" : "apple"} size={12} colored />
              {platform === "android" ? "Android" : "iOS"}
            </div>
          )}
          <div className="sim-devices" role="group" aria-label={`${platform === "android" ? "Android" : "iOS"} devices on this Mac`}>
            {rows.map((d) => (
              <button key={`${d.platform}:${d.udid}`} type="button" className="sim-device"
                data-on={d.udid === chosen || undefined} disabled={busy !== null}
                onClick={() => { setBusy(d.udid); onPick(d.udid, d.platform); }}>
                <span className="sim-device-name">{d.name}</span>
                <span className="sim-device-facts">{d.runtime}{running(d) ? " · already booted" : ""}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Starting({ state, name }: { state: SimulatorState; name: string | null }) {
  return (
    <div className="sim-rest">
      <h2 className="sim-title">{state.status === "booting" ? "Booting the simulator…" : "Starting the stream…"}</h2>
      <p className="sim-hint">
        {state.status === "booting"
          ? "A cold device takes a few seconds to come up. Realm leaves it running afterwards, so this only happens once."
          : `serve-sim is capturing ${name ?? "the device"}'s screen.`}
      </p>
    </div>
  );
}

function Failed({ state, onRetry, onPick }: { state: SimulatorState; onRetry: () => void; onPick: (udid: string, platform: SimulatorPlatform) => void }) {
  return (
    <div className="sim-rest">
      <h2 className="sim-title">The simulator did not start</h2>
      <p className="sim-reason">{REASONS[state.error ?? ""] ?? REASONS.failed}</p>
      {/* What the failing command actually said. Mono, and kept: a `serve-sim` that cannot reach npm
          says so here, and a sentence of ours would only paraphrase it worse. */}
      {state.detail && <p className="sim-detail">{state.detail}</p>}
      <button type="button" className="sim-primary" onClick={onRetry}>Try again</button>
      <DevicePicker chosen={state.udid} onPick={onPick} />
    </div>
  );
}

/**
 * The live device: the picture, and everything that can be done to it.
 *
 * `visible` takes the stream down when the pane is off screen. An MJPEG connection decodes frames
 * whether or not anyone is looking, and a background pane burning a core on JPEGs nobody sees is the
 * kind of cost that only shows up as a warm laptop.
 */
function Screen({ state, visible, simulatorId, platform }: {
  state: SimulatorState; visible: boolean; simulatorId: string; platform: SimulatorPlatform | null;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const elements = useApp((s) => s.simulatorElements[simulatorId] ?? false);
  const picture = useRef<HTMLImageElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  const [live, setLive] = useState(false);
  const frame = useFrameChoice(simulatorId);
  const input = useRef<SimulatorInput | null>(null);
  const dragging = useRef(false);
  const screen = state.screen!;
  const run = useApp((s) => s.run);
  const pathForFile = useApp((s) => s.pathForFile);
  /* A file dropped on the device goes ONTO the device: an app is installed, a picture or a video
     lands in its Photos library. Sorted by what the file is rather than asked about, because a drop
     is one gesture and a dialog after it would be a second one for a question the extension has
     already answered. */
  const drop = useFileDrop((files) => run(async () => {
    const sorted = sortForDevice(files.map((f) => ({ name: f.name, path: pathForFile(f) })));
    if (sorted.unusable.length > 0 && sorted.apps.length === 0 && sorted.media.length === 0) {
      throw new Error(`Realm cannot put ${sorted.unusable.join(", ")} on a simulator — apps (.app, .ipa), pictures and videos only.`);
    }
    for (const path of sorted.apps) {
      const r = await rpc().call("simulators.act", { simulatorId, act: { kind: "install", path } });
      if (!r.ok) throw new Error(r.detail || `could not install ${path}`);
    }
    if (sorted.media.length > 0) {
      const r = await rpc().call("simulators.act", { simulatorId, act: { kind: "add-media", paths: sorted.media } });
      if (!r.ok) throw new Error(r.detail || "could not add that to the device's photos");
    }
  }));

  useEffect(() => {
    const url = state.wsUrl;
    if (!url) return;
    const conn = new SimulatorInput(url, setLive);
    input.current = conn;
    return () => { conn.close(); input.current = null; };
  }, [state.wsUrl]);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry?.contentRect;
      if (r) setBox({ width: r.width, height: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // There is no DPR event — only a media query that stops matching when the window moves to a
  // display with a different scale factor. `MachinePane` reads it the same way.
  useEffect(() => {
    const mq = window.matchMedia?.(`(resolution: ${dpr}dppx)`);
    if (!mq) return;
    const fn = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [dpr]);

  /* Three ways the picture can be laid out, and they are one decision: the device Realm has a
     picture OF is drawn inside that picture; anything else gets the frame Realm draws itself; and
     `No frame` is the bare stream. Framed either way the picture gives up room, and it takes the
     device's OWN screen corner rather than the pane's — that is the radius that makes it read as a
     screen set into a device instead of a photograph pasted onto one. */
  const framed = frame.kind === "framed";
  const art = framed ? artFor(screen, platform) : null;
  const onArt = useMemo(() => (art ? fitDeviceArt(screen, art, box) : null), [art, screen, box]);
  const drawn = framed && !onArt;
  const laid = useMemo(
    () => (drawn ? fitFramed(screen, box, dpr) : { fit: fitFramebuffer(screen, box, dpr), frame: frameMetrics(screen, 0, 0) }),
    [drawn, screen, box, dpr],
  );
  const fit = laid.fit;
  const width = onArt ? onArt.pictureWidth : fit.cssWidth;
  const height = onArt ? onArt.pictureHeight : fit.cssHeight;
  const radius = onArt ? onArt.radius : drawn ? laid.frame.screenRadius : PICTURE_RADIUS;
  const clip = useMemo(() => squirclePath(width, height, radius), [width, height, radius]);

  /** Where the touch is on the DEVICE, 0..1 — read off the picture's own box, never the pane's. */
  const pointOf = (e: { clientX: number; clientY: number }, clamped: boolean): { x: number; y: number } | null => {
    const el = picture.current;
    return el ? normalizedPoint(el.getBoundingClientRect(), e, clamped) : null;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pointOf(e, false);
    if (!p) return; // the frame and the letterbox are not the device
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    // Focus follows the press, so typing goes to the device rather than to whatever had the caret.
    e.currentTarget.focus();
    input.current?.send(gestureFrame("begin", p.x, p.y));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    // Clamped, not dropped: a swipe that leaves the picture must keep reporting, or the touch is
    // left DOWN on the device with nothing to lift it.
    const p = pointOf(e, true);
    if (p) input.current?.send(gestureFrame("move", p.x, p.y));
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const p = pointOf(e, true);
    if (p) input.current?.send(gestureFrame("end", p.x, p.y));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Realm's own chords stay Realm's: ⌘K opens the palette even while a device has focus, which is
    // the same line `MachinePane` draws for everything short of an explicit keyboard grab.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const frames = keystrokeFrames(e.key);
    if (frames.length === 0) return;
    e.preventDefault();
    for (const f of frames) input.current?.send(f);
  };

  const pictureEl = visible && state.streamUrl
    ? <img ref={picture} className="sim-picture" src={state.streamUrl} alt="" draggable={false} />
    : <div className="sim-picture" aria-hidden />;
  const overlay = elements
    ? <AxOverlay simulatorId={simulatorId} width={width} height={height} radius={radius}
        onTap={(x, y) => input.current?.send(gestureFrame("begin", x, y)) && input.current?.send(gestureFrame("end", x, y))} />
    : null;

  return (
    <div className="sim-pane" data-dropping={drop.dropping || undefined} {...drop.handlers}>
      <div className="sim-screen" ref={holder}
        tabIndex={0} role="application" aria-label="Simulator screen"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        style={{
          ["--sim-w" as string]: `${width}px`,
          ["--sim-h" as string]: `${height}px`,
          /* `path(...)`, not the bare path data. The stylesheet spends this straight into `clip-path`,
             and a custom property holding `M49 0L303 0…` makes that declaration INVALID — which is
             not a broken-looking screen but an unclipped one, so the device renders with square
             corners inside a frame whose own corners are round. `MachinePane` wraps its clip the
             same way. */
          ["--sim-clip" as string]: clip ? `path("${clip}")` : "none",
        }}>
        {/* ONE wrapper for all three answers, and that is a mechanism rather than a tidy-up: the
            picture is an `<img>` on an MJPEG stream, and re-parenting one drops the connection and
            brings it back black. Swapping the frame used to swap the element around it, so changing
            your mind about the frame cost you the screen for a second. The frame is now a data
            attribute on a node that never moves. */}
        <div className="sim-chassis" data-frame={onArt ? "art" : drawn ? "drawn" : "none"}
          style={onArt
            ? { width: `${onArt.frameWidth}px`, height: `${onArt.frameHeight}px` }
            : drawn
              ? { ["--sim-bezel" as string]: `${laid.frame.bezel}px`, ["--sim-outer-r" as string]: `${laid.frame.outerRadius}px` }
              : undefined}>
          <div className="sim-glass"
            style={onArt ? { position: "absolute", left: `${onArt.pictureLeft}px`, top: `${onArt.pictureTop}px` } : undefined}>
            {pictureEl}{overlay}
          </div>
          {/* The device, over its own screen. `aria-hidden` and no pointer events: it is a picture OF
              the phone lying on the phone, and a press meant for the device has to reach it through
              the parts of the art that overlap the screen's corners. Turned with the device — a
              landscape stream in an upright frame is a picture of nothing. */}
          {onArt && art && (
            <img className="sim-art" src={art.src} alt="" aria-hidden="true" draggable={false}
              style={{
                width: `${onArt.artWidth}px`, height: `${onArt.artHeight}px`,
                transform: `translate(${onArt.offsetX}px, ${onArt.offsetY}px) rotate(${onArt.rotation}deg)`,
              }} />
          )}
        </div>
        {!live && <p className="sim-connecting" role="status">Connecting the keyboard and touch…</p>}
      </div>
      {drop.dropping && <div className="session-drop" aria-hidden="true" />}
      {/* The device's own buttons, under the device. The pane bar is for what the PANE does. */}
      <SimulatorHardware item={{ refId: simulatorId } as never} />
      <FrameBar choice={frame} shownAs={art?.name ?? null} />
    </div>
  );
}

/** Where a pane's frame choice is kept: one settings row per simulator, so two panes on two phones
 *  can wear different frames and both survive a relaunch. */
const frameKey = (simulatorId: string): string => `simulator.frame:${simulatorId}`;

export type FrameChoice = {
  /** Realm's own frame around the picture, or the bare picture. No colours and no mockup image: a
   *  frame Realm draws in four finishes is still a frame Realm drew, and a device shown in this app
   *  should look like it is in this app. */
  kind: "none" | "framed";
  set: (kind: "none" | "framed") => void;
};

/** The stored choice, read once and written through. */
function useFrameChoice(simulatorId: string): FrameChoice {
  const [kind, setKind] = useState<"none" | "framed">("framed");

  useEffect(() => {
    let live = true;
    void rpc().call("settings.get", { key: frameKey(simulatorId) }).then((r) => {
      if (!live) return;
      const v = r.value as { kind?: unknown } | null;
      /* Only `none` is read back. Everything else stored here is either the frame or a mode this
         pane no longer has — a metal finish, a mockup image someone pointed it at — and all of them
         land on the frame, which is the one thing every device can wear. */
      if (v && typeof v === "object" && v.kind === "none") setKind("none");
    }).catch(() => {});
    return () => { live = false; };
  }, [simulatorId]);

  const set = useCallback((next: "none" | "framed") => {
    setKind(next);
    void rpc().call("settings.set", { key: frameKey(simulatorId), value: { kind: next } }).catch(() => {});
  }, [simulatorId]);

  return { kind, set };
}

/**
 * The frame's own control, under the device.
 *
 * Under it rather than in the pane bar, and this is the one exception to "a pane's actions live in
 * its bar": this is not an action on the DEVICE, it is what the picture of it looks like. Beside the
 * buttons that press real hardware it would read as the same kind of thing, and the first time
 * someone reached for Home and changed the shape of a phone instead they would know it was not.
 */
function FrameBar({ choice, shownAs }: { choice: FrameChoice; shownAs: string | null }) {
  return (
    <div className="sim-frame-bar">
      <div className="sim-frames" role="radiogroup" aria-label="Device frame">
        {/* Which device the art is a picture of belongs on the TOOLTIP, not on the button. It is the
            same string on every phone in a family — a label that read "iPhone 15 Pro" over an
            iPhone 17 would be a claim about the device rather than about the frame. */}
        <button type="button" className="btn sim-frame-opt" role="radio" aria-checked={choice.kind === "framed"}
          title={shownAs ? `Shown in an ${shownAs}` : "Shown in a frame Realm draws"}
          onClick={() => choice.set("framed")}>Frame</button>
        <button type="button" className="btn sim-frame-opt" role="radio" aria-checked={choice.kind === "none"}
          onClick={() => choice.set("none")}>No frame</button>
      </div>
    </div>
  );
}

/**
 * The device's accessibility tree, drawn over its picture.
 *
 * This is the one thing the pane could never do. Its picture is a single DOM node — every icon and
 * row inside it is pixels as far as the page is concerned — so Realm's element picker over a device
 * resolves to "the simulator" and nothing finer, and an agent asked to click "General" had to guess
 * at a coordinate. The tree is the device saying what is on it, with a frame for each element, so a
 * box can be drawn around the real thing and a tap sent to its middle.
 *
 * Frames arrive in POINTS (the root Application node reports 440×956 on a 1320×2868 iPhone) and the
 * picture is in CSS pixels, so everything is scaled by the picture's width over the tree's. Mixing
 * the two is how an overlay ends up a third of the size of what it is outlining.
 *
 * Read on demand, not polled: the tree is a snapshot of a screen that changes when the device is
 * touched, and a poll would be a CLI round trip every second for a pane nobody is inspecting.
 */
function AxOverlay({ simulatorId, width, height, radius, onTap }: {
  simulatorId: string; width: number; height: number; radius: number;
  onTap: (x: number, y: number) => void;
}) {
  const [tree, setTree] = useState<SimulatorAxTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(() => {
    setBusy(true);
    void rpc().call("simulators.ax", { simulatorId })
      .then((r) => { setTree(r.tree); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [simulatorId]);
  useEffect(read, [read]);

  const scale = tree && tree.screen.width > 0 ? width / tree.screen.width : 0;
  return (
    <div className="sim-ax" style={{ width: `${width}px`, height: `${height}px`, clipPath: `inset(0 round ${radius}px)` }}>
      {tree && scale > 0 && tree.elements.map((el) => (
        <AxBox key={el.path} el={el} scale={scale}
          onTap={() => onTap((el.frame.x + el.frame.width / 2) / tree.screen.width, (el.frame.y + el.frame.height / 2) / tree.screen.height)} />
      ))}
      {/* The controls sit ON the overlay rather than in the bar: they belong to the thing that is
          open, and they leave with it. */}
      <div className="sim-ax-bar">
        <span className="sim-ax-count">
          {/* The home screen's root node reports an empty name — SpringBoard does not call itself
              anything — so the separator goes with it rather than trailing into nothing. */}
          {error ? error
            : tree ? [`${tree.elements.length} elements`, tree.app].filter(Boolean).join(" · ")
              : busy ? "Reading the screen…" : "—"}
        </span>
        <button type="button" className="btn" onClick={read} disabled={busy}>{busy ? "Reading…" : "Re-read"}</button>
      </div>
    </div>
  );
}

/** One element's box. A button, because it does something — and named by what the DEVICE calls it,
 *  which is the whole point: a screen reader here reads the device's own labels. */
function AxBox({ el, scale, onTap }: { el: SimulatorAxElement; scale: number; onTap: () => void }) {
  const name = el.label || el.value || el.id || el.role;
  return (
    <button type="button" className="sim-ax-box" data-role={el.role} disabled={!el.enabled}
      aria-label={`${name}${el.enabled ? "" : " (disabled)"}`} title={`${name} — ${el.role}${el.value ? ` · ${el.value}` : ""}`}
      style={{ left: `${el.frame.x * scale}px`, top: `${el.frame.y * scale}px`,
               width: `${el.frame.width * scale}px`, height: `${el.frame.height * scale}px` }}
      onClick={onTap}>
      <span className="sim-ax-label">{name}</span>
    </button>
  );
}
