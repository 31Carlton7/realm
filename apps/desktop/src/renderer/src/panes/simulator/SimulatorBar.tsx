import type { Item, SimulatorAct, SimulatorApp, SimulatorButton, SimulatorEvent, SimulatorOrientation, SimulatorUiState } from "@realm/contracts";
import { SIMULATOR_CA_DEBUG, SIMULATOR_ORIENTATIONS, SIMULATOR_PERMISSIONS, SIMULATOR_UI_OPTIONS } from "@realm/contracts";
import { Icon, type IconName } from "@realm/ui";
import { useRef, useState } from "react";
import { Menu, type MenuItem } from "../../components/Menu";
import { useApp } from "../../state/store";
import { rpc } from "../../rpc/client";
import { buttonFrame, orientationFrame, SimulatorInput } from "./sim-input";
import { dotFor } from "../machine/MachineBar";

/**
 * The simulator pane's bar content: what the device is doing, and the presses that have nowhere else
 * to live.
 *
 * Home and the rest are here rather than drawn around the picture on purpose. A bezel with buttons
 * on it is a picture of a phone, and the thing under it is already a picture of a phone — the app's
 * own bar is where a pane's actions go (design.md: "pane bars stay compact and consistent across
 * pane kinds"), and it is the one place they do not cover the screen.
 */

export const SIMULATOR_WORDS: Record<string, string> = {
  off: "Not streaming", booting: "Booting", serving: "Starting", running: "Live", failed: "Failed",
};

/** The state word, and the device's own resolution once there is one. */
export function SimulatorMeta({ item }: { item: Item }) {
  const state = useApp((s) => s.simulatorState[item.refId]);
  const status = state?.status ?? "off";
  return (
    <span className="machine-bar-meta">
      <span className="status-dot" data-status={dotFor(status === "serving" ? "booting" : status)} aria-hidden="true" />
      <span>{SIMULATOR_WORDS[status] ?? "Not streaming"}</span>
      {state?.screen && <span className="machine-bar-size">{state.screen.width}×{state.screen.height}</span>}
    </span>
  );
}

/**
 * The hardware buttons, and the switch that turns the stream off.
 *
 * Every press opens a socket, sends one frame and closes it. That is what the `serve-sim` CLI does
 * for the same commands, and it is right for this shape of thing: a button press is a whole
 * interaction, and a bar that held a connection open for a button nobody has pressed yet would be
 * holding it open for every simulator pane in the window.
 */
export function SimulatorPanelActions({ item }: { item: Item }) {
  const state = useApp((s) => s.simulatorState[item.refId]);
  const run = useApp((s) => s.run);
  const applySimulatorState = useApp((s) => s.applySimulatorState);
  const elementsOn = useApp((s) => s.simulatorElements[item.refId] === true);
  const toggleElements = useApp((s) => s.toggleSimulatorElements);
  const wsUrl = state?.wsUrl ?? null;
  const live = state?.status === "running" && wsUrl !== null;

  if (!live) return null;
  return (<>
    {/* A screenshot is `simctl`'s, not the stream's: the stream is JPEG frames scaled for a pane, and
        this is the picture people paste into a pull request — full resolution, no JPEG in the way.

        It lands in the space's own `simulator/` folder and is REVEALED rather than opened in the
        documents pane. That pane caps what it reads at 2 MB and a phone screenshot is three or four,
        so opening one there fails with a number instead of showing a picture. In the folder it is
        somewhere both Finder and the Library can see it, which is what a screenshot is for. */}
    <button className="icon-btn" aria-label="Take a screenshot" title="Screenshot"
      onClick={() => run(async () => {
        const shot = await rpc().call("simulators.screenshot", { simulatorId: item.refId });
        await window.realm?.files?.reveal?.(shot.absolute);
      })}>
      <Icon name="image" size={14} />
    </button>
    {/* The accessibility tree over the picture. A toggle rather than a menu item: it is a mode you
        work in, and the thing that turns it off should be the thing that turned it on. */}
    <button className="icon-btn" aria-label="Show the device's elements" title="Elements"
      data-on={elementsOn || undefined} aria-pressed={elementsOn}
      onClick={() => toggleElements(item.refId)}>
      <Icon name="layout" size={14} />
    </button>
    <AppsMenu item={item} />
    <DeviceMenu item={item} />
    {/* Stops the STREAM, not the device — the simulator stays booted, because it is usually
        somebody's Xcode session and a pane is not a reason to take it away. */}
    <button className="icon-btn" aria-label="Stop streaming this simulator" title="Stop streaming"
      onClick={() => run(async () => {
        const r = await rpc().call("simulators.stop", { simulatorId: item.refId });
        applySimulatorState(r.state);
      })}>
      <Icon name="stop" size={14} />
    </button>
  </>);
}

/**
 * The device's own hardware, in a row UNDER the device.
 *
 * They used to sit in the pane bar with everything else, and the bar's own comment argued for it: a
 * bezel with buttons on it is a picture of a phone. But the pane draws a phone now, and a phone's
 * buttons belong with the phone — the bar is for what the PANE does (take a picture of it, inspect
 * it, stop streaming) and this row is for what the DEVICE does. Ten icons in one strip was also
 * simply too many to find anything in.
 *
 * `action` is still left out: it exists only on the Pro phones and the watch, and a permanent
 * control that does nothing on most devices is chrome that lies. It lives in the device menu.
 */
const HARDWARE = ["home", "volume-up", "volume-down", "power"] as const satisfies readonly SimulatorButton[];

export function SimulatorHardware({ item }: { item: Item }) {
  const state = useApp((s) => s.simulatorState[item.refId]);
  const wsUrl = state?.wsUrl ?? null;
  if (state?.status !== "running" || !wsUrl) return null;
  const rotate = () => {
    const current = (state.screen?.orientation ?? "portrait") as SimulatorOrientation;
    const i = SIMULATOR_ORIENTATIONS.indexOf(current);
    pressOnce(wsUrl, orientationFrame(SIMULATOR_ORIENTATIONS[(i < 0 ? 0 : i + 1) % SIMULATOR_ORIENTATIONS.length]!));
  };
  return (
    <div className="sim-hardware" role="group" aria-label="Device buttons">
      {HARDWARE.map((b) => (
        <button key={b} type="button" className="icon-btn" aria-label={BUTTON_LABELS[b]} title={BUTTON_LABELS[b]}
          onClick={() => pressOnce(wsUrl, buttonFrame(b))}>
          <Icon name={BUTTON_ICONS[b]} size={14} />
        </button>
      ))}
      {/* One button, cycling portrait → landscape → upside down → the other landscape, because that
          is the order a hand turns a phone in and there is nothing here worth a menu. */}
      <button type="button" className="icon-btn" aria-label="Rotate the device" title="Rotate" onClick={rotate}>
        <Icon name="reload" size={14} />
      </button>
    </div>
  );
}

const BUTTON_LABELS: Record<SimulatorButton, string> = {
  home: "Home button", power: "Side button (lock)", "volume-up": "Volume up", "volume-down": "Volume down", action: "Action button",
};
/** Icons from the set the app already ships. The side button is a LOCK, which is what pressing it
 *  does to a phone — Realm has no power glyph, and a plug would be a different claim. */
const BUTTON_ICONS: Record<SimulatorButton, IconName> = {
  home: "home", power: "lock", "volume-up": "volumeOn", "volume-down": "volumeOff", action: "star",
};

/** What each UI option is called in the menu, and what each of its values is called. serve-sim's own
 *  kebab-case is a CLI's vocabulary; these are the words the Simulator's Features menu uses. */
const UI_LABELS: Record<string, string> = {
  appearance: "Appearance", "text-size": "Text size", "color-filter": "Colour filter",
  "liquid-glass": "Liquid Glass", "reduce-motion": "Reduce Motion",
  "increase-contrast": "Increase Contrast", "reduce-transparency": "Reduce Transparency",
  "show-borders": "Show layout borders", voiceover: "VoiceOver",
};
const VALUE_LABELS: Record<string, string> = {
  light: "Light", dark: "Dark", clear: "Clear", tinted: "Tinted",
  none: "Off", grayscale: "Greyscale", "red-green": "Red / Green", "green-red": "Green / Red", "blue-yellow": "Blue / Yellow",
  "extra-small": "Extra small", small: "Small", medium: "Medium", large: "Large (default)",
  "extra-large": "Extra large", "extra-extra-large": "XX large", "extra-extra-extra-large": "XXX large",
  "accessibility-medium": "Accessibility medium", "accessibility-large": "Accessibility large",
  "accessibility-extra-large": "Accessibility XL", "accessibility-extra-extra-large": "Accessibility XXL",
  "accessibility-extra-extra-extra-large": "Accessibility XXXL",
};
const CA_LABELS: Record<string, string> = {
  blended: "Colour blended layers", copies: "Colour copied images", misaligned: "Colour misaligned images",
  offscreen: "Colour offscreen-rendered", "slow-animations": "Slow animations",
};
/** The switches, which read as checkboxes; everything else is a set of values to pick between. */
const TOGGLES = ["reduce-motion", "increase-contrast", "reduce-transparency", "show-borders", "voiceover"] as const;

/**
 * Everything `serve-sim` can do to a device that is not a tap, a key or a button.
 *
 * One menu rather than a row of controls, because none of these is a thing anyone does twice a
 * minute — they are the Simulator's own Features and Settings menus, which is where a developer
 * already looks for them. The values are read from the DEVICE each time it opens: these are
 * simulator-wide, Xcode can change them from under this pane, and a menu drawn from a copy taken
 * when the pane opened would be a menu that lies about the phone in front of you.
 */
function DeviceMenu({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  const [ui, setUi] = useState<SimulatorUiState | null>(null);
  const [events, setEvents] = useState<SimulatorEvent[] | null>(null);
  const run = useApp((s) => s.run);
  const wsUrl = useApp((s) => s.simulatorState[item.refId]?.wsUrl ?? null);
  const btn = useRef<HTMLButtonElement>(null);

  const load = () => run(async () => { setUi((await rpc().call("simulators.ui", { simulatorId: item.refId })).ui); });
  const set = (option: string, value: string) => run(async () => {
    const r = await rpc().call("simulators.setUi", { simulatorId: item.refId, option, value });
    setUi(r.ui);
    // The CLI prints its own accepted set when it refuses; that sentence says more than any of ours.
    if (!r.ok && r.detail) throw new Error(r.detail);
  });
  const poke = (p: { kind: "memory-warning" } | { kind: "ca-debug"; option: (typeof SIMULATOR_CA_DEBUG)[number]; on: boolean }) =>
    run(async () => {
      const r = await rpc().call("simulators.poke", { simulatorId: item.refId, poke: p });
      if (!r.ok && r.detail) throw new Error(r.detail);
    });

  const items = (): MenuItem[] => {
    const out: MenuItem[] = [];
    /* Appearance and Liquid Glass first: they change what every screenshot of this device looks
       like, which is what most people open this menu for. */
    for (const option of ["appearance", "liquid-glass", "color-filter"] as const) {
      out.push({ kind: "separator" });
      for (const value of SIMULATOR_UI_OPTIONS[option]) {
        out.push({
          label: `${UI_LABELS[option]}: ${VALUE_LABELS[value] ?? value}`,
          checked: ui?.[option] === value,
          keepOpen: true,
          onSelect: () => set(option, value),
        });
      }
    }
    /* Text size as two steps rather than twelve rows. The CLI takes `increment`/`decrement` for
       exactly this, and a menu with every content-size category in it is a menu nobody reads to the
       end of — the one it is currently on is named in the label. */
    out.push({ kind: "separator" });
    out.push({ label: `Text size: ${VALUE_LABELS[ui?.["text-size"] ?? ""] ?? ui?.["text-size"] ?? "—"}`, disabled: true, onSelect: () => {} });
    out.push({ label: "Text size — larger", keepOpen: true, onSelect: () => set("text-size", "increment") });
    out.push({ label: "Text size — smaller", keepOpen: true, onSelect: () => set("text-size", "decrement") });

    out.push({ kind: "separator" });
    for (const option of TOGGLES) {
      out.push({
        label: UI_LABELS[option] ?? option,
        checked: ui?.[option] === "on",
        keepOpen: true,
        onSelect: () => set(option, ui?.[option] === "on" ? "off" : "on"),
      });
    }

    /* The debug overlays are WRITE-ONLY: serve-sim can turn one on and off, and nothing reports
       which are on. So they are actions rather than checkboxes — a checkbox that cannot read its own
       state is a checkbox that lies the moment anything else touches it. */
    out.push({ kind: "separator" });
    for (const option of SIMULATOR_CA_DEBUG) {
      out.push({ label: `${CA_LABELS[option] ?? option} — on`, keepOpen: true, onSelect: () => poke({ kind: "ca-debug", option, on: true }) });
    }
    out.push({
      label: "Turn every debug overlay off",
      keepOpen: true,
      onSelect: () => { for (const option of SIMULATOR_CA_DEBUG) poke({ kind: "ca-debug", option, on: false }); },
    });

    out.push({ kind: "separator" });
    /* The Action button lives here rather than in the bar: it exists only on the Pro phones and the
       watch, and a permanent control that does nothing on most devices is chrome that lies. In a
       menu it is one line among the device's other oddities, which is what it is. */
    out.push({ label: "Action button", onSelect: () => pressOnce(wsUrl, buttonFrame("action")) });
    out.push({ label: "Simulate memory warning", onSelect: () => poke({ kind: "memory-warning" }) });

    /* The pasteboard, both ways, and a URL from it. No text field anywhere: what a person wants to
       type into a phone is nearly always already on their Mac's clipboard, and a menu item that
       moves it is one click where a field would be a form. */
    out.push({ kind: "separator" });
    out.push({
      label: "Paste this Mac's clipboard into the device",
      onSelect: () => run(async () => {
        const text = await navigator.clipboard.readText();
        if (!text) throw new Error("This Mac's clipboard is empty.");
        const r = await rpc().call("simulators.act", { simulatorId: item.refId, act: { kind: "paste", text } });
        if (!r.ok && r.detail) throw new Error(r.detail);
      }),
    });
    out.push({
      label: "Copy the device's clipboard",
      onSelect: () => run(async () => {
        const r = await rpc().call("simulators.act", { simulatorId: item.refId, act: { kind: "copy" } });
        if (!r.ok) throw new Error(r.detail || "the device would not say what is on its pasteboard");
        await navigator.clipboard.writeText(r.text ?? "");
      }),
    });
    out.push({
      label: "Open the clipboard's link on the device",
      onSelect: () => run(async () => {
        const url = (await navigator.clipboard.readText()).trim();
        // A scheme is the whole test: `simctl openurl` takes a deep link as readily as a web page,
        // and refusing anything without one is what keeps a copied paragraph from becoming a search.
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) throw new Error("This Mac's clipboard does not hold a link.");
        const r = await rpc().call("simulators.act", { simulatorId: item.refId, act: { kind: "open-url", url } });
        if (!r.ok && r.detail) throw new Error(r.detail);
      }),
    });

    /* What the device has been told to do lately — by this pane, by a CLI, by an agent. Loaded when
       the section is opened rather than with the menu: it is a CLI round trip, and most of the time
       nobody wants it. */
    out.push({ kind: "separator" });
    if (events === null) {
      out.push({ label: "Recent events", keepOpen: true, onSelect: () => run(async () => {
        setEvents((await rpc().call("simulators.events", { simulatorId: item.refId, limit: 12 })).events);
      }) });
    } else if (events.length === 0) {
      out.push({ label: "Nothing has happened yet", disabled: true, onSelect: () => {} });
    } else {
      for (const e of events) out.push({ label: `${e.source} · ${e.summary}`, disabled: true, onSelect: () => {} });
    }
    return out;
  };

  return (<>
    <button ref={btn} className="icon-btn" aria-label="Device settings" title="Device settings"
      aria-haspopup="menu" aria-expanded={open}
      onClick={() => { setOpen(true); setEvents(null); void load(); }}>
      <Icon name="settings" size={14} />
    </button>
    {open && <Menu items={items()} anchorRef={btn} align="right" onClose={() => setOpen(false)} label="Device settings" />}
  </>);
}

/**
 * One frame down the device's own socket, from a control that holds no connection of its own.
 *
 * Open, send, close — what the `serve-sim` CLI does for the same commands, and right for this shape
 * of thing: a button press is a whole interaction, and a bar that held a socket open for a button
 * nobody has pressed yet would hold one open for every simulator pane in the window.
 */
function pressOnce(wsUrl: string | null, frame: Uint8Array): void {
  if (!wsUrl) return;
  const conn = new SimulatorInput(wsUrl, (open) => {
    if (!open) return;
    conn.send(frame);
    // 50ms, the same grace the CLI leaves: closing the socket in the same tick as the send can drop
    // the frame before it is written.
    setTimeout(() => conn.close(), 50);
  });
}

/**
 * The apps on the device, and everything that is done TO one.
 *
 * A drill-down rather than a wall: a simulator carries forty apps and sixteen permissions, and the
 * cross of the two is six hundred menu rows. Picking an app rebuilds the menu in place as that app's
 * — which is what `keepOpen` is for, and what the two-step confirms elsewhere already do.
 *
 * Launch, permissions and the camera all live here together because all three take the same first
 * question — WHICH app — and asking it once is the difference between a menu and a form.
 */
function AppsMenu({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  const [apps, setApps] = useState<SimulatorApp[] | null>(null);
  const [app, setApp] = useState<SimulatorApp | null>(null);
  const [permission, setPermission] = useState<string | null>(null);
  const run = useApp((s) => s.run);
  const pickFiles = useApp((s) => s.pickFiles);
  const btn = useRef<HTMLButtonElement>(null);

  const load = () => run(async () => { setApps((await rpc().call("simulators.apps", { simulatorId: item.refId })).apps); });
  const act = (a: SimulatorAct) => run(async () => {
    const r = await rpc().call("simulators.act", { simulatorId: item.refId, act: a });
    if (!r.ok && r.detail) throw new Error(r.detail);
  });

  const items = (): MenuItem[] => {
    if (apps === null) return [{ label: "Reading the device…", disabled: true, onSelect: () => {} }];
    if (app === null) {
      return apps.length === 0
        ? [{ label: "No apps on this device", disabled: true, onSelect: () => {} }]
        : apps.map((a) => ({ label: a.name, title: a.bundleId, keepOpen: true, onSelect: () => setApp(a) }));
    }
    if (permission !== null) {
      /* Grant, revoke, reset — actions rather than a checkbox. `permissions list` answers with raw
         TCC service keys (`kTCCServiceLiverpool` is the microphone) that do not map onto the names
         the CLI takes, so a checkbox here would be reading one vocabulary and writing another. */
      return [
        { label: `← ${permission}`, keepOpen: true, onSelect: () => setPermission(null) },
        { kind: "separator" },
        ...(["grant", "revoke", "reset"] as const).map((action) => ({
          label: `${action[0]!.toUpperCase()}${action.slice(1)} ${permission} for ${app.name}`,
          onSelect: () => act({ kind: "permission", action, permission: permission as never, bundleId: app.bundleId }),
        })),
      ];
    }
    return [
      { label: `← ${app.name}`, keepOpen: true, onSelect: () => setApp(null) },
      { kind: "separator" },
      { label: "Launch", onSelect: () => act({ kind: "launch", bundleId: app.bundleId }) },
      { kind: "separator" },
      /* The camera feed is injected INTO the app that is launched, which is why every one of these
         launches it. A web page in Safari cannot see the feed however it is started: WebKit captures
         in its own process, and the injector is only in this one. */
      { label: "Launch with a camera feed", onSelect: () => act({ kind: "camera", bundleId: app.bundleId, source: { kind: "placeholder" } }) },
      { label: "Launch with this Mac's webcam", onSelect: () => act({ kind: "camera", bundleId: app.bundleId, source: { kind: "webcam", name: null } }) },
      {
        label: "Launch with a picture or video…",
        onSelect: () => run(async () => {
          const picked = await pickFiles();
          const path = picked[0]?.path;
          if (!path) return; // cancelled
          const r = await rpc().call("simulators.act", { simulatorId: item.refId, act: { kind: "camera", bundleId: app.bundleId, source: { kind: "file", path } } });
          if (!r.ok && r.detail) throw new Error(r.detail);
        }),
      },
      { label: "Stop the camera feed", onSelect: () => act({ kind: "camera-stop" }) },
      { kind: "separator" },
      ...SIMULATOR_PERMISSIONS.map((perm) => ({
        label: `Permission: ${perm}`, keepOpen: true, onSelect: () => setPermission(perm),
      })),
    ];
  };

  return (<>
    <button ref={btn} className="icon-btn" aria-label="Apps on this device" title="Apps"
      aria-haspopup="menu" aria-expanded={open}
      onClick={() => { setOpen(true); setApp(null); setPermission(null); void load(); }}>
      <Icon name="layoutGrid" size={14} />
    </button>
    {open && <Menu items={items()} anchorRef={btn} align="right" onClose={() => setOpen(false)} label="Apps on this device" />}
  </>);
}
