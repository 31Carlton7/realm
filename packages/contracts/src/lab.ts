import { z } from "zod";
import { IdSchema } from "./ids";
import type { UnlockPolicy } from "./browser-agent";

/**
 * The lab: a Mac set aside to run a team's work unattended, with phones on its cables (teams plan
 * §12). Three things live here — whether this Mac is ready to be left alone, the devices attached
 * to it, and the update window that keeps an update from landing in the middle of a team's run.
 *
 * Realm-wide, not per team: the readiness of a Mac and the phones on its cables are facts about the
 * machine, and one Mac serves every team on it. Which team a device serves is a column on the device.
 */

/** Settings keys. `lab.enabled` is what turns the update window on; the checklist reads either way. */
export const LAB_ENABLED_KEY = "lab.enabled";
export const LAB_UPDATE_HOUR_KEY = "lab.updateHour";
export const LAB_UPDATE_CAP_KEY = "lab.updateCapMinutes";
/** The update window's state, as `UpdateWindow` last wrote it — held in settings so a server that
 *  restarts mid-drain keeps holding, and the one that boots after the update can say how it went. */
export const LAB_UPDATE_STATE_KEY = "lab.update";

export const LAB_DEFAULTS = {
  /** 04:00, the plan's: the hour nobody is reviewing anything. */
  updateHour: 4,
  /** How long running work is waited for before the update goes ahead anyway. A role's run is capped
   *  at 20 minutes by default, so half an hour sees an ordinary one through. */
  updateCapMinutes: 30,
  /** The Laya memory: a full disk swapped the Mac into a panic. */
  minFreeGb: 50,
  /** Accounts one phone holds, each consented (§12: "2–3 accounts per phone"). */
  accountsPerDevice: 3,
} as const;

/* ── readiness ── */

export const LAB_CHECK_IDS = [
  "sleep", "power-failure", "auto-login", "filevault", "display", "disk", "network", "power-backup", "screen-sharing",
  "touch-id", "login-item",
] as const;
export type LabCheckId = (typeof LAB_CHECK_IDS)[number];

/** `na`: the check has no meaning on this Mac (restart after a power failure, on a laptop). */
export const LabCheckStateSchema = z.enum(["ok", "attention", "unknown", "na"]);
export type LabCheckState = z.infer<typeof LabCheckStateSchema>;

/** The System Settings panes a check can send someone to — a closed list main maps to URLs. */
export const LAB_SETTINGS_PANES = ["energy", "users", "privacy", "sharing", "login-items", "displays", "network"] as const;
export const LabSettingsPaneSchema = z.enum(LAB_SETTINGS_PANES);
export type LabSettingsPane = z.infer<typeof LabSettingsPaneSchema>;

/** The fixes Realm makes itself, in one click: each is a switch, so it is undone the same way. */
export const LabActionSchema = z.enum(["login-item", "keep-awake"]);
export type LabAction = z.infer<typeof LabActionSchema>;

export const LabCheckSchema = z.object({
  id: z.enum(LAB_CHECK_IDS),
  /** What a ready Mac does, as a sentence's subject: "Never sleeps". */
  label: z.string(),
  state: LabCheckStateSchema,
  /** What Realm found, in words. */
  fact: z.string(),
  /** How to fix it, when it needs fixing. */
  fix: z.string().nullable(),
  /** A command that needs an administrator: shown, never run. */
  command: z.string().nullable(),
  settingsPane: LabSettingsPaneSchema.nullable(),
  action: LabActionSchema.nullable(),
});
export type LabCheck = z.infer<typeof LabCheckSchema>;

export const LabReadinessSchema = z.object({ checks: z.array(LabCheckSchema), checkedAt: z.number() });
export type LabReadiness = z.infer<typeof LabReadinessSchema>;

/**
 * Whether this profile's sign-ins can be unlocked on this Mac, by its unlock policy (#134). Decided
 * in the renderer from what main reports, because the policy and the sensor are main's to know.
 */
export function touchIdCheck(d: { policy: UnlockPolicy | null; canPromptTouchID: boolean; canPromptDeviceOwner: boolean; profileName: string }): LabCheck {
  const base = { id: "touch-id" as const, label: "Sign-ins can be unlocked", command: null, settingsPane: null, action: null };
  const p = d.policy;
  if (!p) return { ...base, state: "unknown", fact: "Realm could not read this profile's unlock setting.", fix: null };
  if (p.kind === "unattended") {
    return { ...base, state: "ok", fact: `${d.profileName}'s sign-ins unlock without asking, on this Mac only.`, fix: null };
  }
  if (d.canPromptTouchID) {
    const how = p.kind === "touch-id" ? "Touch ID" : p.kind === "device-password" ? "Touch ID or the login password" : "one check per session";
    return { ...base, state: "ok", fact: `${d.profileName}'s sign-ins unlock with ${how}, and this Mac has a Touch ID sensor.`, fix: null };
  }
  if (p.kind !== "touch-id" && d.canPromptDeviceOwner) {
    return { ...base, state: "ok", fact: `No Touch ID sensor here, so ${d.profileName}'s sign-ins unlock with the login password.`, fix: null };
  }
  return {
    ...base, state: "attention",
    fact: `${d.profileName}'s sign-ins unlock only with Touch ID, and this Mac has no sensor.`,
    fix: "Attach a Magic Keyboard with Touch ID, or choose another way to unlock in Sign-ins.",
  };
}

/** Whether Realm opens when this Mac's user logs in — what brings the lab back after a restart. */
export function loginItemCheck(d: { openAtLogin: boolean | null; canSet: boolean }): LabCheck {
  const base = { id: "login-item" as const, label: "Realm opens at login", command: null, settingsPane: "login-items" as const };
  if (d.openAtLogin === null) return { ...base, state: "unknown", fact: "Realm could not read its login item.", fix: null, action: null };
  if (d.openAtLogin) return { ...base, state: "ok", fact: "Realm opens when you log in.", fix: null, action: d.canSet ? "login-item" : null };
  return {
    ...base, state: "attention", fact: "Realm does not open at login, so after a restart nothing runs until someone opens it.",
    fix: d.canSet ? "Turn it on here." : "A development build can't add itself; the installed Realm can.",
    action: d.canSet ? "login-item" : null,
  };
}

/* ── devices ── */

export const LabDeviceKindSchema = z.enum(["iphone", "simulator", "android"]);
export type LabDeviceKind = z.infer<typeof LabDeviceKindSchema>;

/** An account a device holds: the service and the handle, never a password (those live in the vault). */
export const LabAccountSchema = z.object({
  service: z.string().trim().min(1).max(40),
  handle: z.string().trim().min(1).max(120),
});
export type LabAccount = z.infer<typeof LabAccountSchema>;

export const LabDeviceSchema = z.object({
  id: IdSchema,
  kind: LabDeviceKindSchema,
  /** The device's own identifier — what a scan matches it by. Null for one added by hand before it
   *  was ever plugged in. */
  udid: z.string().nullable(),
  name: z.string(),
  /** The team it serves: a space, or null for a device not given to one yet. */
  spaceId: IdSchema.nullable(),
  spaceName: z.string().nullable(),
  accounts: z.array(LabAccountSchema),
  lastSeenAt: z.number().nullable(),
  /** In the last scan — a fact about this moment, never a column. */
  connected: z.boolean(),
  createdAt: z.number(),
});
export type LabDevice = z.infer<typeof LabDeviceSchema>;

/** A device a scan found that is not in the registry yet. */
export const LabSeenDeviceSchema = z.object({ udid: z.string(), kind: LabDeviceKindSchema, name: z.string(), runtime: z.string() });
export type LabSeenDevice = z.infer<typeof LabSeenDeviceSchema>;

export const LabDevicesSchema = z.object({ devices: z.array(LabDeviceSchema), unregistered: z.array(LabSeenDeviceSchema), scannedAt: z.number().nullable() });
export type LabDevices = z.infer<typeof LabDevicesSchema>;

/* ── the update window ── */

/**
 * Where the update window stands.
 *
 *   - `idle`       — no update is waiting.
 *   - `waiting`    — an update is downloaded; the window opens at `opensAt`.
 *   - `draining`   — no new team run starts; running ones are waited for until `capAt`.
 *   - `installing` — Realm has been told to install; `leftRunning` runs were still going and start
 *                    again after it.
 *   - `resumed`    — the last window's outcome, kept so the line can say how it went.
 */
export const LabUpdateStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("idle") }),
  z.object({ kind: z.literal("waiting"), version: z.string(), from: z.string(), readyAt: z.number(), opensAt: z.number() }),
  z.object({ kind: z.literal("draining"), version: z.string(), from: z.string(), startedAt: z.number(), capAt: z.number(), running: z.number().int() }),
  z.object({ kind: z.literal("installing"), version: z.string(), from: z.string(), at: z.number(), leftRunning: z.number().int() }),
  z.object({ kind: z.literal("resumed"), version: z.string(), from: z.string(), at: z.number(), applied: z.boolean(), heldMs: z.number() }),
]);
export type LabUpdateState = z.infer<typeof LabUpdateStateSchema>;

export const LabStatusSchema = z.object({
  enabled: z.boolean(),
  updateHour: z.number().int().min(0).max(23),
  updateCapMinutes: z.number().int().min(5).max(240),
  update: LabUpdateStateSchema,
  /** This Mac's Bonjour name — what a laptop types into a Machine pane to reach it. */
  hostName: z.string().nullable(),
});
export type LabStatus = z.infer<typeof LabStatusSchema>;

const clock = (ms: number): string => {
  const d = new Date(ms);
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const minutes = (ms: number): string => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m === 1 ? "1 minute" : `${m} minutes`;
};
const runsWord = (n: number): string => (n === 1 ? "1 run" : `${n} runs`);

/** The update window's status line, in the app's 12-hour clock. Null at rest: nothing to say. */
export function labUpdateLine(s: LabUpdateState, now: number): string | null {
  switch (s.kind) {
    case "idle": return null;
    case "waiting":
      return s.opensAt <= now ? `Realm v${s.version} is ready; the update window is opening.`
        : `Realm v${s.version} is ready. It installs at ${clock(s.opensAt)}, once team runs have finished.`;
    case "draining":
      return s.running === 0 ? `Updating to v${s.version}: no team run is starting, and nothing is running.`
        : `Updating to v${s.version}: no new team run starts. Waiting for ${runsWord(s.running)} to finish, until ${clock(s.capAt)}.`;
    case "installing":
      return s.leftRunning === 0 ? `Installing v${s.version}. Realm restarts and team runs start again.`
        : `Installing v${s.version}. ${runsWord(s.leftRunning)} still running ${s.leftRunning === 1 ? "starts" : "start"} again after the restart.`;
    case "resumed":
      return s.applied ? `Updated to v${s.version} at ${clock(s.at)}. Team runs were held for ${minutes(s.heldMs)} and have started again.`
        : `The update to v${s.version} did not install, so Realm stayed on v${s.from}. Team runs have started again.`;
  }
}
