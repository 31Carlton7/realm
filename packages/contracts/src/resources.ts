import { z } from "zod";

/**
 * What Realm costs this Mac in memory, and what the Mac has left (`apps/server/src/resources/`).
 *
 * Two numbers per process, because one of them lies on a Mac that is short of memory. **Resident**
 * (`ps`'s RSS) counts the pages in RAM right now, so a process macOS has compressed or swapped out reads
 * small exactly when it is costing the most. **Footprint** (`phys_footprint`, what Activity Monitor's
 * Memory column and `footprint(1)` report) counts its dirty memory wherever it went — in RAM, in the
 * compressor or in swap. Footprint is the number every total here is made of; resident is kept beside
 * it, and stands in for it on a platform that cannot say.
 */

/**
 * The machine's own verdict on memory, upgraded by what it is doing right now.
 *
 * `normal`/`warn`/`critical` start as macOS's level (`kern.memorystatus_vm_pressure_level`, the one
 * Activity Monitor colours green, yellow and red). macOS can stay green while the Mac pages out to a
 * swap file that only ever grows — measured on this Mac at 20 GB of swap and load averages in the
 * hundreds — so swapping out steadily between two readings lifts `normal` to `warn`. `unknown` is a
 * platform with no answer.
 */
export const MEMORY_PRESSURES = ["normal", "warn", "critical", "unknown"] as const;
export const MemoryPressureSchema = z.enum(MEMORY_PRESSURES);
export type MemoryPressure = z.infer<typeof MemoryPressureSchema>;

export const MachineMemorySchema = z.object({
  totalBytes: z.number().nonnegative(),
  /** How much macOS says is available, 0–100 (`kern.memorystatus_level`); null where it cannot say. */
  availablePercent: z.number().min(0).max(100).nullable(),
  pressure: MemoryPressureSchema,
  /** The reason the level is what it is, as a sentence; null at `normal`. */
  pressureWhy: z.string().nullable(),
  swap: z.object({ usedBytes: z.number().nonnegative(), totalBytes: z.number().nonnegative() }).nullable(),
  /** Bytes the compressor holds (`vm_stat` "occupied by compressor"); null where there is none to read. */
  compressedBytes: z.number().nonnegative().nullable(),
  /** Bytes swapped out per second since the last reading; null until there are two readings. */
  swapOutPerSecond: z.number().nonnegative().nullable(),
  /** 1, 5 and 15 minute load averages, and the CPUs they are measured against. */
  load: z.tuple([z.number(), z.number(), z.number()]),
  cpus: z.number().int().positive(),
});
export type MachineMemory = z.infer<typeof MachineMemorySchema>;

/** What a Realm process is for. Every process Realm started lands in exactly one. */
export const RESOURCE_CATEGORIES = ["engines", "mcp", "terminals", "laya", "simulators", "browsers", "app", "server", "other"] as const;
export const ResourceCategorySchema = z.enum(RESOURCE_CATEGORIES);
export type ResourceCategory = z.infer<typeof ResourceCategorySchema>;

/** One thing Realm runs: a session's engine, an MCP server, a terminal, a browser pane, Laya. */
export const ResourcePartSchema = z.object({
  /** Stable across readings, for a list's keys: category and owner, or the process when there is none. */
  id: z.string(),
  category: ResourceCategorySchema,
  /** Who it belongs to — a session, an MCP server, a terminal, a browser, a simulator's udid — or null. */
  ownerId: z.string().nullable(),
  label: z.string(),
  /** A fact about its state, as a phrase: "Idle 42 min", "Working", "Booted by Realm". */
  detail: z.string().nullable(),
  processes: z.number().int().nonnegative(),
  residentBytes: z.number().nonnegative(),
  footprintBytes: z.number().nonnegative().nullable(),
});
export type ResourcePart = z.infer<typeof ResourcePartSchema>;

/** Bytes for a group of processes: the total and its two measures. */
export const ResourceSizeSchema = z.object({
  processes: z.number().int().nonnegative(),
  residentBytes: z.number().nonnegative(),
  footprintBytes: z.number().nonnegative().nullable(),
});
export type ResourceSize = z.infer<typeof ResourceSizeSchema>;

/** Another app on this Mac, by name and size and nothing else: Realm reports them and never acts on them. */
export const OtherAppSchema = ResourceSizeSchema.extend({ name: z.string() });
export type OtherApp = z.infer<typeof OtherAppSchema>;

/** What the Memory page's "free memory now" buttons can each let go of right now, without
 *  interrupting anything: how many, and how much they hold. */
export const FREE_ACTIONS = ["engines", "simulators", "browsers", "laya"] as const;
export const FreeActionSchema = z.enum(FREE_ACTIONS);
export type FreeAction = z.infer<typeof FreeActionSchema>;
export const FreeableSchema = z.object({ count: z.number().int().nonnegative(), bytes: z.number().nonnegative() });
export type Freeable = z.infer<typeof FreeableSchema>;

export const ResourceReportSchema = z.object({
  at: z.number(),
  machine: MachineMemorySchema,
  /** Everything Realm started, together. */
  realm: ResourceSizeSchema,
  categories: z.array(ResourceSizeSchema.extend({ category: ResourceCategorySchema })),
  /** Heaviest first. */
  parts: z.array(ResourcePartSchema),
  /** The biggest of everything else, heaviest first. */
  others: z.array(OtherAppSchema),
  /** Which measure the totals are: `footprint` on a Mac, `resident` where footprint cannot be read. */
  measure: z.enum(["footprint", "resident"]),
  /** What each "free memory now" button would let go of; absent where nothing has been asked. */
  freeable: z.object({ engines: FreeableSchema, simulators: FreeableSchema, browsers: FreeableSchema, laya: FreeableSchema }).optional(),
});
export type ResourceReport = z.infer<typeof ResourceReportSchema>;

/** The words a category is listed under. */
export const RESOURCE_CATEGORY_LABEL: Record<ResourceCategory, string> = {
  engines: "Engines",
  mcp: "MCP servers",
  terminals: "Terminals",
  laya: "Laya",
  simulators: "Simulators",
  browsers: "Browser panes",
  app: "Realm's windows",
  server: "Realm's server",
  other: "Other processes",
};

/**
 * Minutes a browser pane may sit off screen before its view is discarded — its renderer process given
 * up, its page and scroll kept, and the page loaded again when the pane is shown (0: never). A view an
 * agent drove within the window, or whose page plays media or holds unsent input, is never discarded.
 */
export const BROWSER_DISCARD_HIDDEN_KEY = "browser.discardHiddenMinutes";
export const BROWSER_DISCARD_HIDDEN_DEFAULT = 20;
/** How many of the most recently hidden browser panes are kept loaded whatever the window says. */
export const BROWSER_KEEP_HIDDEN_KEY = "browser.keepHidden";
export const BROWSER_KEEP_HIDDEN_DEFAULT = 3;

/**
 * When memory is short, everything idle goes sooner: each idle window — engines, MCP servers, Laya,
 * hidden browser panes, the simulators Realm booted — shrinks to at most `PRESSURE_IDLE_MINUTES` of
 * the level. Only the WINDOW shrinks: what counts as idle does not change, so an engine mid-turn,
 * waiting on you or holding background work is never stopped, however short of memory the Mac is.
 * Off, the windows are the settings' own.
 */
export const RESOURCES_ADAPTIVE_KEY = "resources.adaptive";
export const RESOURCES_ADAPTIVE_DEFAULT = true;
/** A stopped engine resumes its conversation on the next message in a few seconds; what the window
 *  trades is that wait, never the conversation. */
export const PRESSURE_IDLE_MINUTES = { warn: 10, critical: 5 } as const;

/** An idle window, as memory pressure leaves it. Only ever shorter, so 0 (never) stays never. */
export function adaptIdleMinutes(minutes: number, pressure: MemoryPressure, adaptive: boolean): number {
  if (!adaptive) return minutes;
  if (pressure === "critical") return Math.min(minutes, PRESSURE_IDLE_MINUTES.critical);
  if (pressure === "warn") return Math.min(minutes, PRESSURE_IDLE_MINUTES.warn);
  return minutes;
}

/**
 * Minutes a stdio MCP server Realm started may go without a call before its process is stopped (0:
 * never). Its tool list is kept, so sessions still see its tools, and the next call starts it again.
 */
export const MCP_IDLE_STOP_KEY = "mcp.idleStopMinutes";
export const MCP_IDLE_STOP_DEFAULT = 30;

/** Minutes an engine may sit idle before its process is stopped (`SessionService.reapIdle`); 0 never. */
export const ENGINE_IDLE_MINUTES_KEY = "sessions.engineIdleMinutes";
export const ENGINE_IDLE_MINUTES_DEFAULT = 30;

/** Every policy setting the Memory page writes, and the shape it is written in. */
export const RESOURCE_POLICY_KEYS = [
  "sessions.engineIdleMinutes", "mcp.idleStopMinutes", "laya.idleStopMinutes", "simulators.idleShutdownMinutes",
  "browser.discardHiddenMinutes", "browser.keepHidden", "resources.adaptive",
] as const;
export const ResourcePolicyKeySchema = z.enum(RESOURCE_POLICY_KEYS);
export type ResourcePolicyKey = z.infer<typeof ResourcePolicyKeySchema>;

/** The windows as set, and as memory pressure leaves them now. Minutes; 0 is never. */
export const ResourcePoliciesSchema = z.object({
  engineIdleMinutes: z.number().int().nonnegative(),
  mcpIdleMinutes: z.number().int().nonnegative(),
  layaIdleMinutes: z.number().int().nonnegative(),
  simulatorIdleMinutes: z.number().int().nonnegative(),
  browserHiddenMinutes: z.number().int().nonnegative(),
  browserKeepHidden: z.number().int().nonnegative(),
  adaptive: z.boolean(),
  effective: z.object({ engines: z.number(), mcp: z.number(), laya: z.number(), simulators: z.number(), browsers: z.number() }),
});
export type ResourcePolicies = z.infer<typeof ResourcePoliciesSchema>;
