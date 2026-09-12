import { z } from "zod";
import { IdSchema, Timestamps } from "./entities";

/**
 * Apple Simulators, shown and driven inside a pane.
 *
 * A sibling of `machine.ts` and deliberately smaller than it. A machine can be anywhere and Realm
 * has four different things to do to reach one; a simulator is always on this Mac, always reached
 * the same way, and the only question is WHICH one.
 *
 * The pixels come from `serve-sim`, which captures the simulator's framebuffer and serves it as
 * multipart JPEG over loopback. That is the whole reason this pane is DOM rather than a
 * `WebContentsView` pointed at serve-sim's own web UI: an `<img>` on an MJPEG stream is an ordinary
 * element, so menus, sheets and the command palette open over the device, and a screenshot of the
 * window contains it. A native view would have cost all three (design.md, and `state/no-overlay.ts`
 * exists because of it).
 */

/**
 * Which toolchain a device belongs to.
 *
 * Carried on the DEVICE and on the stored row, never inferred. The two platforms disagree about
 * enough — what a device is called, what its frames are measured in, which of the acts below even
 * exist — that code guessing from the shape of a udid would be wrong the first time Google changes
 * a serial format.
 */
export const SimulatorPlatformSchema = z.enum(["ios", "android"]);
export type SimulatorPlatform = z.infer<typeof SimulatorPlatformSchema>;

/**
 * One of this Mac's installed simulators or emulators. Not stored — a device list is a fact about
 * the machine right now, and a copy in the database would be stale by the next Xcode.
 *
 * `udid` is the STABLE identity and is what a row remembers: Apple's UDID, or the AVD's name. It is
 * deliberately not the adb serial, which is a port number handed out at boot — remembering
 * `emulator-5554` would point a saved pane at whichever emulator happened to start first next time.
 */
export const SimulatorDeviceSchema = z.object({
  udid: z.string().min(1),
  platform: SimulatorPlatformSchema,
  name: z.string(),
  /** "iOS 27.0" from the runtime identifier, or "Android 16" from the AVD's target — what tells two
   *  identically-named devices apart. */
  runtime: z.string(),
  /** simctl's own word (`Booted`, `Shutdown`, `Creating`) or adb's (`device`, `offline`,
   *  `unauthorized`), or `Shutdown` for an AVD that is not running. Passed through rather than
   *  mapped, because it is about the DEVICE, not about Realm's stream. */
  state: z.string(),
  /** The adb serial, on Android and only while something is running. Null otherwise — see `udid`. */
  serial: z.string().nullable().default(null),
});
export type SimulatorDevice = z.infer<typeof SimulatorDeviceSchema>;

/**
 * What the pane is doing right now. In memory, never a column, for `MachineState`'s reason: a
 * status is a fact about a process, and no process survives a restart.
 *
 *   - `off`      — a row with no device chosen yet, or one nobody has started.
 *   - `booting`  — `simctl boot`, and the wait for the device to come up.
 *   - `serving`  — booted; `serve-sim` is starting and has not published a URL yet.
 *   - `running`  — there is a stream URL. The pane shows pixels.
 *   - `failed`   — with a reason the pane can put in a sentence.
 */
export const SimulatorStatusSchema = z.enum(["off", "booting", "serving", "running", "failed"]);
export type SimulatorStatus = z.infer<typeof SimulatorStatusSchema>;

/** The screen's own geometry, from serve-sim's `/config`. Pixels, not points — the stream is the
 *  framebuffer, and the pane scales it to fit. */
export const SimulatorScreenSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  orientation: z.string(),
});
export type SimulatorScreen = z.infer<typeof SimulatorScreenSchema>;

export const SimulatorStateSchema = z.object({
  simulatorId: IdSchema,
  status: SimulatorStatusSchema,
  /** The device this row is pointed at, or null while nothing has been chosen. */
  udid: z.string().nullable(),
  /** How adb is addressing it right now (Android only). Null on iOS and before boot: this is the
   *  half of a device's identity that does not survive a restart, which is why it lives in the
   *  in-memory state and not beside `udid` in the row. */
  serial: z.string().nullable().default(null),
  /** Where the pixels are. Loopback, and already inside the renderer's `img-src`. */
  streamUrl: z.string().nullable(),
  /** Where input goes. Loopback, and already inside the renderer's `connect-src`. */
  wsUrl: z.string().nullable(),
  screen: SimulatorScreenSchema.nullable(),
  /** A word, not a sentence: the pane owns the wording. */
  error: z.string().nullable(),
  /** Whatever the failing command actually said, for the pane's detail line. */
  detail: z.string().nullable(),
});
export type SimulatorState = z.infer<typeof SimulatorStateSchema>;

/** The durable half: which device this pane is for, so reopening it comes back to the same phone. */
export const SimulatorSchema = z.object({
  id: IdSchema,
  spaceId: IdSchema,
  name: z.string(),
  udid: z.string().nullable(),
  /** Which toolchain to reach it with. Defaulted to `ios` so every row written before Android
   *  existed reads back as what it actually is, without a backfill. */
  platform: SimulatorPlatformSchema.default("ios"),
  ...Timestamps,
});
export type Simulator = z.infer<typeof SimulatorSchema>;

/**
 * The hardware buttons serve-sim can press, and the HID page/usage each one is.
 *
 * Transcribed from serve-sim's own table rather than guessed: `home` is special (it carries no HID
 * pair at all and the helper maps it), and the rest are real usages on the consumer page. Kept in
 * the contract because the renderer sends them and a test on either side has to agree about them.
 */
export const SIMULATOR_BUTTONS = {
  home: null,
  power: { page: 12, usage: 48 },
  "volume-up": { page: 12, usage: 233 },
  "volume-down": { page: 12, usage: 234 },
  action: { page: 11, usage: 45 },
} as const satisfies Record<string, { page: number; usage: number } | null>;
export type SimulatorButton = keyof typeof SIMULATOR_BUTTONS;

/** serve-sim's ws frames are one opcode byte then UTF-8 JSON. The opcodes are ITS numbers — read out
 *  of the CLI that speaks them — so nothing here may be renumbered to taste. */
export const SIM_WS_OPCODE = { gesture: 3, button: 4, key: 6, orientation: 7 } as const;

/** The orientations `serve-sim rotate` accepts, in the order the pane cycles them. */
export const SIMULATOR_ORIENTATIONS = ["portrait", "landscape_left", "portrait_upside_down", "landscape_right"] as const;
export type SimulatorOrientation = (typeof SIMULATOR_ORIENTATIONS)[number];

/**
 * The simulator-wide UI options `serve-sim ui` can read and set, with the values each one accepts.
 *
 * Transcribed from the CLI, not guessed: every list here was read back out of `serve-sim` itself by
 * handing it a value it rejects, which prints its own accepted set. A value this table invents is a
 * setting that silently does nothing, and `text-size`'s twelve content-size categories are exactly
 * the kind of list a plausible guess gets wrong.
 *
 * `text-size` also accepts `increment` and `decrement`; they are left out of the VALUES because they
 * are steps rather than states, and a menu of states is what this drives.
 */
export const SIMULATOR_UI_OPTIONS = {
  appearance: ["light", "dark"],
  "text-size": [
    "extra-small", "small", "medium", "large", "extra-large", "extra-extra-large", "extra-extra-extra-large",
    "accessibility-medium", "accessibility-large", "accessibility-extra-large",
    "accessibility-extra-extra-large", "accessibility-extra-extra-extra-large",
  ],
  "color-filter": ["none", "grayscale", "red-green", "green-red", "blue-yellow"],
  "liquid-glass": ["clear", "tinted"],
  "reduce-motion": ["on", "off"],
  "increase-contrast": ["on", "off"],
  "reduce-transparency": ["on", "off"],
  "show-borders": ["on", "off"],
  voiceover: ["on", "off"],
} as const satisfies Record<string, readonly string[]>;
export type SimulatorUiOption = keyof typeof SIMULATOR_UI_OPTIONS;
export const SIMULATOR_UI_OPTION_NAMES = Object.keys(SIMULATOR_UI_OPTIONS) as SimulatorUiOption[];

/** What `serve-sim ui status --json` answers with: every option above, mapped to its current value.
 *  Read as strings rather than as the union, because the device is the authority on what it is set
 *  to and a value Realm has never heard of must arrive rather than be dropped. */
export const SimulatorUiStateSchema = z.record(z.string(), z.string());
export type SimulatorUiState = z.infer<typeof SimulatorUiStateSchema>;

/** The CoreAnimation debug overlays, which are the ones an app developer actually reaches for:
 *  `blended` colours composited layers, `misaligned` flags off-pixel images, `offscreen` marks
 *  offscreen-rendered passes. `slow-animations` is the Simulator's own ⌘T. */
export const SIMULATOR_CA_DEBUG = ["blended", "copies", "misaligned", "offscreen", "slow-animations"] as const;
export type SimulatorCaDebug = (typeof SIMULATOR_CA_DEBUG)[number];

/**
 * One element of the device's accessibility tree, flattened out of the nested one serve-sim serves.
 *
 * Frames are in POINTS, which is what the tree itself reports — the root Application node on a
 * 1320×2868 iPhone says 440×956. Nothing here is in framebuffer pixels, and the pane converts when
 * it draws: mixing the two is how an overlay ends up a third of the size of the thing it outlines.
 */
export const SimulatorAxElementSchema = z.object({
  /** Index path from the root, `0.2.1`. The handle for "this element", stable while the screen is. */
  path: z.string(),
  label: z.string(),
  value: z.string(),
  /** The tree's own `type`: Button, TextField, StaticText, … Passed through, never mapped. */
  role: z.string(),
  /** `AXUniqueId` when the app sets one — the only truly stable handle there is. */
  id: z.string().nullable(),
  enabled: z.boolean(),
  frame: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  depth: z.number().int().nonnegative(),
});
export type SimulatorAxElement = z.infer<typeof SimulatorAxElementSchema>;

export const SimulatorAxTreeSchema = z.object({
  /** What the frames below are measured in. iOS reports POINTS and Android reports PIXELS, and the
   *  difference is the device's scale factor — two or three. A pane that assumes one draws every
   *  overlay at a third of the size of the thing it is outlining, which is why this is stated rather
   *  than inferred from the numbers. */
  units: z.enum(["points", "pixels"]).default("points"),
  /** The application node's frame — points, and the denominator for every frame below it. */
  screen: z.object({ width: z.number(), height: z.number() }),
  /** What the root node calls itself: the foreground app. */
  app: z.string(),
  elements: z.array(SimulatorAxElementSchema),
});
export type SimulatorAxTree = z.infer<typeof SimulatorAxTreeSchema>;

/** An app installed on the device, as `simctl listapps` reports it. */
export const SimulatorAppSchema = z.object({ bundleId: z.string(), name: z.string() });
export type SimulatorApp = z.infer<typeof SimulatorAppSchema>;

/** The permissions `serve-sim permissions` can grant, revoke and reset. Transcribed from the CLI's
 *  own usage line — it prints the list when called with no subcommand. */
export const SIMULATOR_PERMISSIONS = [
  "notifications", "location", "camera", "microphone", "photos", "photos-add", "contacts",
  "calendar", "reminders", "motion", "media-library", "siri", "speech", "faceid", "user-tracking", "homekit",
] as const;
export type SimulatorPermission = (typeof SIMULATOR_PERMISSIONS)[number];
export const SIMULATOR_PERMISSION_ACTIONS = ["grant", "revoke", "reset"] as const;
export type SimulatorPermissionAction = (typeof SIMULATOR_PERMISSION_ACTIONS)[number];

/**
 * Where an injected camera feed comes from.
 *
 * `placeholder` is serve-sim's own animated card, `file` a still or a looping video, `webcam` this
 * Mac's own camera. The feed is injected by swizzling AVFoundation INSIDE the app that is launched,
 * which is why every one of these carries a bundle id — and why a web page in Safari cannot see it:
 * WebKit captures in its own process, so the dylib is not in the process that would need it.
 */
export const SimulatorCameraSourceSchema = z.union([
  z.object({ kind: z.literal("placeholder") }),
  z.object({ kind: z.literal("file"), path: z.string().min(1) }),
  z.object({ kind: z.literal("webcam"), name: z.string().nullable() }),
]);
export type SimulatorCameraSource = z.infer<typeof SimulatorCameraSourceSchema>;

/** One line of `serve-sim event-log` — what the device has been told to do lately, by anyone. */
export const SimulatorEventSchema = z.object({
  source: z.string(),
  kind: z.string(),
  summary: z.string(),
  at: z.string().nullable(),
});
export type SimulatorEvent = z.infer<typeof SimulatorEventSchema>;

/**
 * Everything a device can be told to do that is one command and one answer.
 *
 * One union rather than nine methods: on the pane's side each is a menu item, and on the server's a
 * `simctl` or `serve-sim` invocation. Both sides name this type, so a new act cannot be added to one
 * without the other refusing to compile.
 */
export const SimulatorActSchema = z.union([
  z.object({ kind: z.literal("open-url"), url: z.string().min(1).max(4096) }),
  z.object({ kind: z.literal("install"), path: z.string().min(1) }),
  z.object({ kind: z.literal("launch"), bundleId: z.string().min(1).max(256) }),
  z.object({ kind: z.literal("add-media"), paths: z.array(z.string().min(1)).min(1).max(64) }),
  z.object({ kind: z.literal("paste"), text: z.string().max(100_000) }),
  z.object({ kind: z.literal("copy") }),
  z.object({
    kind: z.literal("permission"),
    action: z.enum(SIMULATOR_PERMISSION_ACTIONS),
    permission: z.enum(SIMULATOR_PERMISSIONS),
    bundleId: z.string().min(1).max(256),
  }),
  z.object({ kind: z.literal("camera"), bundleId: z.string().min(1).max(256).nullable(), source: SimulatorCameraSourceSchema }),
  z.object({ kind: z.literal("camera-stop") }),
]);
export type SimulatorAct = z.infer<typeof SimulatorActSchema>;
