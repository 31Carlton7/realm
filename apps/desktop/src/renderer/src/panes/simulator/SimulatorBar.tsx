import type { SimulatorAct, SimulatorApp, SimulatorButton, SimulatorEvent, SimulatorOrientation, SimulatorState, SimulatorUiState } from "@realm/contracts";
import { buttonFrame, orientationFrame, SIMULATOR_CA_DEBUG, SIMULATOR_ORIENTATIONS, SIMULATOR_PERMISSIONS, SIMULATOR_UI_OPTIONS } from "@realm/contracts";
import { Icon, type IconName } from "@realm/ui";
import { useRef, useState } from "react";
import { Menu, type MenuItem } from "../../components/Menu";
import { useApp } from "../../state/store";
import { rpc } from "../../rpc/client";
import { SimulatorInput } from "./sim-input";
import { toolbarFit } from "./toolbar-fit";

/**
 * The device's own controls: a toolbar above the device, and an overflow for everything else.
 *
 * They were the pane bar's, and in a side pane that bar is the tab strip too: "Live 1206×2622" and six
 * buttons took the width the tabs needed, and in a narrow pane they took all of it. The bar is for what
 * the PANE does. What the device does, and what its stream is doing, sits with the device — above it
 * and centred on it, where a simulator's own window puts Home, Screenshot and Rotate — and the Record
 * row is its counterpart under the device (`LayaRecord.tsx`), in the same pill.
 *
 * Four things a person does over and over are buttons: Home, Screenshot, the elements overlay and
 * Rotate. Everything else is one click further, in the overflow: the volume and side buttons, the apps
 * on the device, the Simulator's own settings, the frame, and stopping the stream. A narrow pane takes
 * the toolbar apart in a stated order (`toolbar-fit.ts`), and whatever leaves it is the first thing in
 * the overflow, by name.
 */

/** A press the toolbar can draw as a button, or hand to the overflow as a row. */
type Press = { id: string; label: string; aria: string; title: string; icon: IconName; pressed?: boolean; onSelect: () => void };

/** The frame the picture wears, chosen and kept by the pane (`useFrameChoice` in SimulatorPane.tsx). */
type Frame = { kind: "none" | "framed"; set: (kind: "none" | "framed") => void };

export function SimulatorToolbar({ simulatorId, connected, width, frame, shownAs }: {
  simulatorId: string;
  /** The input socket is open. Until it is, the picture streams and a touch goes nowhere. */
  connected: boolean;
  /** The room the pane gives the toolbar, in CSS px — what `toolbarFit` budgets. */
  width: number;
  frame: Frame;
  /** Which device the frame is a picture of, for its row's tooltip. */
  shownAs: string | null;
}) {
  const state = useApp((s) => s.simulatorState[simulatorId]);
  const run = useApp((s) => s.run);
  const elementsOn = useApp((s) => s.simulatorElements[simulatorId] === true);
  const toggleElements = useApp((s) => s.toggleSimulatorElements);
  const wsUrl = state?.wsUrl ?? null;
  if (state?.status !== "running" || !wsUrl) return null;
  const physical = state.physical === true;

  const rotate = () => {
    const current = (state.screen?.orientation ?? "portrait") as SimulatorOrientation;
    const i = SIMULATOR_ORIENTATIONS.indexOf(current);
    pressOnce(wsUrl, orientationFrame(SIMULATOR_ORIENTATIONS[(i < 0 ? 0 : i + 1) % SIMULATOR_ORIENTATIONS.length]!));
  };
  const presses: Press[] = [
    { id: "home", label: "Home", aria: BUTTON_LABELS.home, title: "Home", icon: "home", onSelect: () => pressOnce(wsUrl, buttonFrame("home")) },
    /* A screenshot is `simctl`'s, not the stream's: the stream is JPEG frames scaled for a pane, and
       this is the picture people paste into a pull request — full resolution, no JPEG in the way.

       It lands in the space's own `simulator/` folder and is REVEALED rather than opened in the
       documents pane. That pane caps what it reads at 2 MB and a phone screenshot is three or four,
       so opening one there fails with a number instead of showing a picture. In the folder it is
       somewhere both Finder and the Library can see it, which is what a screenshot is for. */
    { id: "screenshot", label: "Screenshot", aria: "Take a screenshot", title: "Screenshot", icon: "camera",
      onSelect: () => run(async () => {
        const shot = await rpc().call("simulators.screenshot", { simulatorId });
        await window.realm?.files?.reveal?.(shot.absolute);
      }) },
    /* The accessibility tree over the picture. A toggle rather than a menu row: it is a mode you work
       in, and the thing that turns it off should be the thing that turned it on. */
    { id: "elements", label: "Elements", aria: "Show the device's elements", title: "Elements", icon: "select",
      pressed: elementsOn, onSelect: () => toggleElements(simulatorId) },
    /* One button, cycling portrait → landscape → upside down → the other landscape, because that is the
       order a hand turns a phone in and there is nothing here worth a menu. Not on a real phone: its
       orientation is the hand holding it. */
    ...(physical ? [] : [{ id: "rotate", label: "Rotate", aria: "Rotate the device", title: "Rotate", icon: "rotate" as const, onSelect: rotate }]),
  ];
  const fit = toolbarFit(width, presses.length);
  const size = state.screen ? `${state.screen.width}×${state.screen.height}` : null;

  return (
    <div className="sim-toolbar" role="group" aria-label="Device controls" data-status={fit.status}>
      {/* The stream's state, still: a live device is a resting state, and the picture beside it is
          what moves. The dot pings only while the touch and keyboard are still connecting. */}
      <span className="sim-toolbar-status" role="status"
        title={connected ? ["Live", size].filter(Boolean).join(" · ") : "Connecting the keyboard and touch…"}>
        <span className="status-dot" data-status={connected ? "connected" : "machine-booting"} aria-hidden="true" />
        <span className="sim-toolbar-word">{connected ? "Live" : "Connecting"}</span>
        {size && <span className="machine-bar-size">{size}</span>}
      </span>
      <span className="sim-toolbar-rule" aria-hidden="true" />
      {presses.slice(0, fit.keep).map((p) => (
        <button key={p.id} type="button" className="icon-btn" aria-label={p.aria} title={p.title}
          aria-pressed={p.pressed} onClick={p.onSelect}>
          <Icon name={p.icon} size={14} />
        </button>
      ))}
      <MoreMenu simulatorId={simulatorId} state={state} overflow={presses.slice(fit.keep)} frame={frame} shownAs={shownAs} />
    </div>
  );
}

/**
 * The device's hardware, as rows of the overflow.
 *
 * Home is a button on the toolbar; these are pressed far less, and as rows they say what they are in
 * words — a glyph for "volume down" is a guess at best. `action` is left out: it exists only on the
 * Pro phones and the watch, so it lives with the device's other oddities in its settings.
 */
const HARDWARE = ["volume-up", "volume-down", "power"] as const satisfies readonly SimulatorButton[];
/** What Realm's test runner presses on a real phone. Not the side button — a phone Realm locked is one
 *  only its owner can unlock — and no rotation, which is the hand holding it. */
const PHONE_HARDWARE = ["volume-up", "volume-down"] as const satisfies readonly SimulatorButton[];

const BUTTON_LABELS: Record<SimulatorButton, string> = {
  home: "Home button", power: "Side button (lock)", "volume-up": "Volume up", "volume-down": "Volume down", action: "Action button",
};
/** Icons from the set the app already ships. The side button is a LOCK, which is what pressing it
 *  does to a phone — Realm has no power glyph, and a plug would be a different claim. */
const BUTTON_ICONS: Record<SimulatorButton, IconName> = {
  home: "home", power: "lock", "volume-up": "volumeOn", "volume-down": "volumeLow", action: "star",
};

/**
 * The overflow: what a narrow pane took off the toolbar, the hardware, the apps and the device's
 * settings, the frame, and the switch that stops the stream.
 *
 * Apps and Device settings are menus of their own, opened in place — the row rebuilds the menu as that
 * one, with a row back up at its head — because an OS menu cannot change under the pointer and Realm's
 * menus carry no submenus. Both are read when the overflow opens rather than when their row is picked:
 * an OS menu is built once, when it opens, and a list still on its way when the drill-down opened would
 * open as one row saying so. Read quietly, too — nobody who opened this for Volume up asked for either
 * list, so a device that will not answer says so inside the drill-down, not in a toast.
 */
function MoreMenu({ simulatorId, state, overflow, frame, shownAs }: {
  simulatorId: string; state: SimulatorState; overflow: Press[]; frame: Frame; shownAs: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"more" | "apps" | "device">("more");
  const run = useApp((s) => s.run);
  const applySimulatorState = useApp((s) => s.applySimulatorState);
  const btn = useRef<HTMLButtonElement>(null);
  const physical = state.physical === true;
  const up = () => setView("more");
  const apps = useAppRows(simulatorId, physical, up);
  const device = useDeviceRows(simulatorId, state.wsUrl, up);

  const rows = (): MenuItem[] => {
    if (view === "apps") return apps.rows();
    if (view === "device") return device.rows();
    return [
      ...(overflow.length > 0 ? [
        ...overflow.map((p): MenuItem => ({ label: p.label, icon: <Icon name={p.icon} size={14} />, checked: p.pressed, onSelect: p.onSelect })),
        { kind: "separator" as const },
      ] : []),
      ...(physical ? PHONE_HARDWARE : HARDWARE).map((b): MenuItem => ({
        label: BUTTON_LABELS[b], icon: <Icon name={BUTTON_ICONS[b]} size={14} />, onSelect: () => pressOnce(state.wsUrl, buttonFrame(b)),
      })),
      { kind: "separator" },
      { label: "Apps…", icon: <Icon name="grid" size={14} />, keepOpen: true, onSelect: () => setView("apps") },
      /* Everything in this menu is serve-sim's, and a real phone has no serve-sim: offered only where
         it exists (design.md), rather than as a menu of refusals. */
      ...(physical ? [] : [{ label: "Device settings…", icon: <Icon name="settings" size={14} />, keepOpen: true, onSelect: () => setView("device") }]),
      { kind: "separator" },
      /* What the PICTURE looks like rather than anything the device does. Which device the art is a
         picture of is on the tooltip, not the label: it is the same string on every phone in a family,
         and "iPhone 15 Pro" over an iPhone 17 would be a claim about the device. */
      { label: "Show device frame", checked: frame.kind === "framed",
        title: shownAs ? `Shown in an ${shownAs}` : "Shown in a frame Realm draws",
        onSelect: () => frame.set(frame.kind === "framed" ? "none" : "framed") },
      { kind: "separator" },
      /* Stops the STREAM, not the device — the simulator stays booted, because it is usually somebody's
         Xcode session and a pane is not a reason to take it away. */
      { label: physical ? "Stop streaming this phone" : "Stop streaming", icon: <Icon name="stop" size={14} />,
        title: physical ? "Realm's test runner comes off the phone" : "The simulator stays booted",
        onSelect: () => run(async () => {
          const r = await rpc().call("simulators.stop", { simulatorId });
          applySimulatorState(r.state);
        }) },
    ];
  };

  return (<>
    <button ref={btn} type="button" className="icon-btn" aria-label="More device controls" title="More"
      aria-haspopup="menu" aria-expanded={open}
      onClick={() => {
        if (open) { setOpen(false); return; }
        setView("more"); setOpen(true); apps.load(); if (!physical) device.load();
      }}>
      <Icon name="more" size={14} />
    </button>
    {open && <Menu items={rows()} anchorRef={btn} align="right" label="More device controls" onClose={() => { setOpen(false); setView("more"); }} />}
  </>);
}

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
 * already looks for them. The values are read from the DEVICE each time the overflow opens: these are
 * simulator-wide, Xcode can change them from under this pane, and a menu drawn from a copy taken when
 * the pane opened would be a menu that lies about the phone in front of you.
 */
function useDeviceRows(simulatorId: string, wsUrl: string | null, up: () => void) {
  const [ui, setUi] = useState<SimulatorUiState | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  const [events, setEvents] = useState<SimulatorEvent[] | null>(null);
  const run = useApp((s) => s.run);

  const load = () => {
    setEvents(null);
    setUi(null);
    setUnread(null);
    rpc().call("simulators.ui", { simulatorId }).then((r) => setUi(r.ui), (e: unknown) => setUnread(e instanceof Error ? e.message : String(e)));
  };
  const set = (option: string, value: string) => run(async () => {
    const r = await rpc().call("simulators.setUi", { simulatorId, option, value });
    setUi(r.ui);
    // The CLI prints its own accepted set when it refuses; that sentence says more than any of ours.
    if (!r.ok && r.detail) throw new Error(r.detail);
  });
  const poke = (p: { kind: "memory-warning" } | { kind: "ca-debug"; option: (typeof SIMULATOR_CA_DEBUG)[number]; on: boolean }) =>
    run(async () => {
      const r = await rpc().call("simulators.poke", { simulatorId, poke: p });
      if (!r.ok && r.detail) throw new Error(r.detail);
    });

  const rows = (): MenuItem[] => {
    const out: MenuItem[] = [{ label: "← Device settings", keepOpen: true, onSelect: up }];
    // Its settings are the DEVICE's, read as the overflow opened: a device that did not answer leaves
    // every row unticked, and this line says why rather than letting them read as all off.
    if (unread !== null) out.push({ label: `The device did not say how it is set: ${unread}`, disabled: true, onSelect: () => {} });
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
    /* The Action button lives here rather than with the other buttons: it exists only on the Pro
       phones and the watch, and a control that does nothing on most devices is chrome that lies. In
       this menu it is one line among the device's other oddities, which is what it is. */
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
        const r = await rpc().call("simulators.act", { simulatorId, act: { kind: "paste", text } });
        if (!r.ok && r.detail) throw new Error(r.detail);
      }),
    });
    out.push({
      label: "Copy the device's clipboard",
      onSelect: () => run(async () => {
        const r = await rpc().call("simulators.act", { simulatorId, act: { kind: "copy" } });
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
        const r = await rpc().call("simulators.act", { simulatorId, act: { kind: "open-url", url } });
        if (!r.ok && r.detail) throw new Error(r.detail);
      }),
    });

    /* What the device has been told to do lately — by this pane, by a CLI, by an agent. Loaded when
       the section is opened rather than with the menu: it is a CLI round trip, and most of the time
       nobody wants it. */
    out.push({ kind: "separator" });
    if (events === null) {
      out.push({ label: "Recent events", keepOpen: true, onSelect: () => run(async () => {
        setEvents((await rpc().call("simulators.events", { simulatorId, limit: 12 })).events);
      }) });
    } else if (events.length === 0) {
      out.push({ label: "Nothing has happened yet", disabled: true, onSelect: () => {} });
    } else {
      for (const e of events) out.push({ label: `${e.source} · ${e.summary}`, disabled: true, onSelect: () => {} });
    }
    return out;
  };

  return { load, rows };
}

/**
 * One frame down the device's own socket, from a control that holds no connection of its own.
 *
 * Open, send, close — what the `serve-sim` CLI does for the same commands, and right for this shape
 * of thing: a button press is a whole interaction, and a toolbar that held a socket open for a button
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
function useAppRows(simulatorId: string, physical: boolean, up: () => void) {
  const [apps, setApps] = useState<SimulatorApp[] | null>(null);
  const [app, setApp] = useState<SimulatorApp | null>(null);
  const [permission, setPermission] = useState<string | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  const run = useApp((s) => s.run);
  const pickFiles = useApp((s) => s.pickFiles);

  const load = () => {
    setApps(null); setApp(null); setPermission(null); setUnread(null);
    rpc().call("simulators.apps", { simulatorId }).then((r) => setApps(r.apps), (e: unknown) => setUnread(e instanceof Error ? e.message : String(e)));
  };
  const act = (a: SimulatorAct) => run(async () => {
    const r = await rpc().call("simulators.act", { simulatorId, act: a });
    if (!r.ok && r.detail) throw new Error(r.detail);
  });

  const rows = (): MenuItem[] => {
    if (app === null) {
      const head: MenuItem[] = [{ label: "← Apps", keepOpen: true, onSelect: up }, { kind: "separator" }];
      if (apps === null) return [...head, { label: unread === null ? "Reading the device…" : `The device did not list its apps: ${unread}`, disabled: true, onSelect: () => {} }];
      return apps.length === 0
        ? [...head, { label: "No apps on this device", disabled: true, onSelect: () => {} }]
        : [...head, ...apps.map((a) => ({ label: a.name, title: a.bundleId, keepOpen: true, onSelect: () => setApp(a) }))];
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
    const launch: MenuItem[] = [
      { label: `← ${app.name}`, keepOpen: true, onSelect: () => setApp(null) },
      { kind: "separator" },
      { label: "Launch", onSelect: () => act({ kind: "launch", bundleId: app.bundleId }) },
    ];
    // The camera feed and the permission table are a simulator's; a phone's app is launched and that
    // is all Realm does to it.
    if (physical) return launch;
    return [
      ...launch,
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
          const r = await rpc().call("simulators.act", { simulatorId, act: { kind: "camera", bundleId: app.bundleId, source: { kind: "file", path } } });
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

  return { load, rows };
}
