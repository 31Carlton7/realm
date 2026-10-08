import { REDUCED_MOTION_DEFAULT, REDUCED_MOTION_KEY, REDUCED_MOTION_PREFS } from "./motion";
import { MID_TURN_MODE_KEY, MID_TURN_MODES } from "./presets";
import { TERMINALS_CURSOR_BLINK_DEFAULT, TERMINALS_CURSOR_BLINK_KEY } from "./terminals";

/** Light, dark, or follow macOS. The palette each face wears is a second setting, not this one. */
export const SETTING_THEME = "ui.theme";
/** Which key sends a message: Return, or ⌘Return (and Return makes a new line). */
export const SETTING_SUBMIT_KEY = "ui.submitKey";

type AgentSetting = { key: string; values: readonly (string | boolean)[]; fallback: string | boolean; about: string };

/**
 * The settings an agent may read and change with `realm-workspace`'s `settings_get` / `settings_set`
 * — an allowlist, and deliberately a short one.
 *
 * What is on it: things the user sees at once and can put back with one click, that change how Realm
 * looks or how its keys behave, and nothing else. What is not, and must never be: anything that
 * decides what an agent may do (permission modes and their defaults, sandboxing, MCP servers and the
 * provider switches, the computer-use and machine allowlists), anything holding or sending a secret
 * or a message off the Mac (sign-ins, notification relays, webhooks), anything that deletes (terminal
 * history), and anything that reaches outside Realm (the editor files open in, sleep prevention). An
 * agent that could change those could widen its own reach, or send the user's words somewhere, on one
 * approval of what looked like a preference.
 *
 * Every value is from a closed list, so a call cannot store something the app will not read back.
 */
export const AGENT_SETTINGS = {
  theme: { key: SETTING_THEME, values: ["system", "light", "dark"], fallback: "system", about: "light or dark, or follow macOS" },
  reduceMotion: { key: REDUCED_MOTION_KEY, values: REDUCED_MOTION_PREFS, fallback: REDUCED_MOTION_DEFAULT, about: "reduce animation: on, off, or follow macOS" },
  submitKey: { key: SETTING_SUBMIT_KEY, values: ["enter", "cmdEnter"], fallback: "enter", about: "which key sends a message — Return, or ⌘Return (Return then makes a new line)" },
  midTurnMode: { key: MID_TURN_MODE_KEY, values: MID_TURN_MODES, fallback: "queue", about: "a message sent while an agent is working waits for the turn to end (queue) or goes into it now (steer)" },
  terminalCursorBlink: { key: TERMINALS_CURSOR_BLINK_KEY, values: [true, false], fallback: TERMINALS_CURSOR_BLINK_DEFAULT, about: "whether the terminal's cursor blinks" },
} as const satisfies Record<string, AgentSetting>;
export type AgentSettingName = keyof typeof AGENT_SETTINGS;
export const AGENT_SETTING_NAMES = Object.keys(AGENT_SETTINGS) as AgentSettingName[];
