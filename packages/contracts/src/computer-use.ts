import { z } from "zod";

/**
 * The `realm-computer` tool surface's shared shapes: what a snapshot of a Mac app looks like on the
 * wire, what an action against one looks like, and how a key chord is spelled.
 *
 * The vocabulary (snapshot → element index → act, one screenshot alongside the tree, xdotool-style
 * key names) follows open-codex-computer-use (MIT); the schemas and the permission model are Realm's.
 */

/**
 * The gateway provider's name, and so the prefix its tools arrive under
 * (`realm-computer__computer_snapshot`). It lives here rather than beside the provider because
 * `McpService` needs it too — this is the one provider that is OFF until a space turns it on, and
 * that table cannot import the provider without a cycle.
 */
export const COMPUTER_PROVIDER_NAME = "realm-computer";

/** Tools that only read. Everything else goes through the permission gate — see the provider. */
export const COMPUTER_READ_ONLY_TOOLS = ["computer_list_apps", "computer_snapshot"] as const;

/**
 * Refusals the helper reports with a machine-readable tag, because the agent's correct next move
 * differs for each and "it failed" would leave it guessing.
 *
 * `stale_snapshot` is the common one and the whole reason indices are checked rather than trusted:
 * take another snapshot. `occluded` and `not_frontmost` mean the click was withheld because it would
 * have landed on the wrong app. `secure_field` and `forbidden_app` are hard blocks that no
 * permission mode lifts.
 */
export type ComputerRefusal =
  | "no_accessibility" | "stale_snapshot" | "no_element" | "occluded"
  | "not_frontmost" | "forbidden_app" | "secure_field";

export const COMPUTER_MODIFIERS = ["command", "control", "option", "shift", "function"] as const;
export type ComputerModifier = (typeof COMPUTER_MODIFIERS)[number];

const ModifierSchema = z.enum(COMPUTER_MODIFIERS);
const IndexSchema = z.number().int().nonnegative();

/**
 * One action against one app.
 *
 * `index` is an element from the CURRENT snapshot. Where it is optional, omitting it means "wherever
 * the app's focus already is" — which is what continuing to type into a field, or pressing a
 * shortcut at the app rather than at a widget, actually means. `click` additionally accepts raw
 * screen coordinates for the cases the accessibility tree does not describe (a canvas, a custom
 * control that exposes nothing); they are checked against the same occlusion rule as an element.
 */
export const ComputerActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("click"),
    index: IndexSchema.optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    button: z.enum(["left", "right", "middle"]).default("left"),
    clickCount: z.number().int().min(1).max(3).default(1),
    modifiers: z.array(ModifierSchema).default([]),
  }),
  z.object({ kind: z.literal("type"), index: IndexSchema.optional(), text: z.string().min(1) }),
  z.object({ kind: z.literal("key"), index: IndexSchema.optional(), key: z.string().min(1) }),
  z.object({
    kind: z.literal("scroll"),
    index: IndexSchema.optional(),
    dx: z.number().int().default(0),
    dy: z.number().int().default(0),
  }),
  z.object({ kind: z.literal("setValue"), index: IndexSchema, text: z.string() }),
  z.object({ kind: z.literal("drag"), index: IndexSchema, toIndex: IndexSchema, modifiers: z.array(ModifierSchema).default([]) }),
  z.object({ kind: z.literal("menu"), index: IndexSchema }),
]);
export type ComputerAction = z.infer<typeof ComputerActionSchema>;

/** One addressable node of an app's accessibility tree. Frames are in global screen coordinates. */
export type ComputerElement = {
  index: number;
  role: string;
  subrole: string;
  name: string;
  value: string;
  x: number; y: number; w: number; h: number;
  actions: string[];
  enabled: boolean;
  focused: boolean;
  depth: number;
};

export type ComputerApp = { pid: number; bundleId: string; name: string; frontmost: boolean; hidden: boolean };

/** Grant state travels with the app list so a caller never has to guess whether an empty or failing
 *  result means "nothing is running" or "nothing is permitted". */
export type ComputerAppsResult = { apps: ComputerApp[]; accessibility: boolean; screenRecording: boolean };

export type ComputerSnapshotResult = {
  snapshotId: string;
  pid: number;
  bundleId: string;
  appName: string;
  frontmost: boolean;
  /** The walk hit its element/depth budget: what is here is real, but incomplete. */
  truncated: boolean;
  elements: ComputerElement[];
  /** Base64 JPEG of the app's windows. Absent when Screen Recording is not granted — the tree, which
   *  is what acting depends on, is useful without it. */
  screenshot?: string;
  /** The rendered `[N] role "name" …` listing the agent reads. */
  text: string;
};

export type ComputerActResult =
  | { ok: true; detail: string }
  | { ok: false; error: string; refused?: ComputerRefusal };

export type ComputerGrants = { accessibility: boolean; screenRecording: boolean };

/**
 * Key chords, in the xdotool spelling the reference tool surface uses: modifiers joined to a key by
 * `+`, e.g. `super+c`, `ctrl+shift+t`, `Return`. Returns null for anything unparseable, so a caller
 * refuses with a useful message instead of posting a keystroke it guessed at.
 *
 * Aliases are accepted generously because models write all of them: macOS users and Apple's own docs
 * say `cmd`, xdotool says `super`, web APIs say `meta`, and all three mean the Command key. The
 * KEY half is passed through with its case preserved — `a` and `A` are the same physical key and
 * shift is a modifier, but the named keys (`Return`, `Escape`) are matched case-insensitively
 * downstream.
 */
export function parseKeySpec(spec: string): { key: string; modifiers: ComputerModifier[] } | null {
  const parts = spec.trim().split("+").map((p) => p.trim()).filter((p) => p.length > 0);
  // A lone "+" is the plus key, not an empty chord: splitting ate it, so put it back.
  if (parts.length === 0) return spec.includes("+") ? { key: "+", modifiers: [] } : null;

  const modifiers: ComputerModifier[] = [];
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (!modifier) return null;
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  const key = parts[parts.length - 1]!;
  // Multi-character keys must be names this side knows; a bare word like "hello" is a typing
  // request that arrived at the wrong tool, and posting its first letter would be worse than
  // refusing.
  if (key.length > 1 && !COMPUTER_KEY_NAMES.has(key.toLowerCase())) return null;
  return { key, modifiers };
}

const MODIFIER_ALIASES: Record<string, ComputerModifier> = {
  cmd: "command", command: "command", super: "command", meta: "command", win: "command",
  ctrl: "control", control: "control",
  alt: "option", opt: "option", option: "option",
  shift: "shift",
  fn: "function", function: "function",
};

/** Named keys the helper can press. Kept here rather than only in Swift so a bad name is refused
 *  before it crosses two process boundaries, and so the tool description can list them. */
export const COMPUTER_KEY_NAMES = new Set([
  "return", "enter", "tab", "space", "delete", "backspace", "escape", "esc", "forwarddelete",
  "left", "right", "down", "up", "home", "end", "pageup", "pagedown",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);
