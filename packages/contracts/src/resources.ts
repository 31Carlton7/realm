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
