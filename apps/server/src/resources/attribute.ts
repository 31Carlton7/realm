import { basename } from "node:path";
import type { OtherApp, ResourceCategory, ResourcePart, ResourceReport, ResourceSize } from "@realm/contracts";
import type { ProcRow } from "./machine";

/**
 * Which of the machine's processes are Realm's, and what each is for. Pure: a process table, the
 * footprints read for it, and what each Realm service says it owns, in; the parts of a report, out.
 *
 * Every process Realm started lands in exactly ONE part, claimed most specific first — a terminal
 * before the engine that might have opened it, an engine's own subprocesses (the build or test suite
 * its shell tool ran) with that engine — so nothing is counted twice and the parts add up to the total.
 *
 * Engines are matched to sessions three ways, best first:
 *  1. Claude's command line names the conversation it resumes (`--resume=<id>`), which is the
 *     session's provider id — exact.
 *  2. Codex runs ONE app-server for every Codex session, so that process is one part for all of them.
 *  3. Anything left is matched by when it started: each session's engine is spawned moments after the
 *     session started it, in the order they were started. `ps` dates to the second, so this can pair
 *     two engines started in the same second the wrong way round; it never pairs one with a session
 *     that started after it.
 */

/** A live engine, as the session service knows it. */
export type EngineOwner = { sessionId: string; title: string; kind: string; providerSessionId: string | null; startedAt: number; detail: string | null };
export type TerminalOwner = { terminalId: string; title: string; pid: number; tty: string | null };
export type McpOwner = { serverId: string; name: string; pid: number; detail: string | null };
/** A simulator Realm booted, and when: a device shut down and booted again by somebody else is a
 *  different boot, told apart by its launchd's start time. */
export type SimulatorOwner = { udid: string; name: string; bootedAt: number; detail: string | null };
/** One of the app's own processes, from Electron main (`app.getAppMetrics()`), already labelled there. */
export type AppProcess = {
  pid: number;
  kind: "main" | "gpu" | "utility" | "window" | "browser" | "other";
  label: string;
  /** A browser id for a pane's view; null for everything else. */
  ownerId: string | null;
  detail: string | null;
  /** A browser pane's view: since when it has been off screen, or null while it is on screen. */
  hiddenSince?: number | null;
};

export type Owners = {
  serverPid: number;
  engines: EngineOwner[];
  terminals: TerminalOwner[];
  mcp: McpOwner[];
  laya: { pid: number; detail: string | null } | null;
  /** The simulators Realm booted; only these are Realm's to count. */
  simulators: SimulatorOwner[];
  /** Null when no app is attached (a headless server) — then there is nothing of the app's to count. */
  app: AppProcess[] | null;
};

/** The command-line names of the engines Realm runs (`cli/bins.ts`, the adapters). */
const ENGINE_BINS = new Set(["claude", "codex", "cursor-agent", "gemini", "opencode", "copilot", "goose", "qwen", "grok", "dsh-acp-demo", "openhands", "fx", "hermes"]);
/** Interpreters an engine may be run under, whose script then names it. */
const INTERPRETERS = new Set(["node", "bun", "deno", "python", "python3"]);
/** Which agent kind an engine binary is. */
const KIND_OF_BIN: Record<string, string> = {
  claude: "claude", codex: "codex", "cursor-agent": "acp:cursor", gemini: "acp:gemini", opencode: "acp:opencode", copilot: "acp:copilot",
  goose: "acp:goose", qwen: "acp:qwen", grok: "acp:grok", "dsh-acp-demo": "acp:deepseek", openhands: "acp:openhands", fx: "acp:fx", hermes: "acp:hermes",
};

/** The binary a command runs, past an interpreter: `node /x/bin/gemini --acp` is `gemini`. */
export function engineBin(command: string): string | null {
  const words = command.split(/\s+/).filter(Boolean);
  const first = basename(words[0] ?? "");
  if (ENGINE_BINS.has(first)) return first;
  if (INTERPRETERS.has(first.replace(/[\d.]+$/, "")) && words[1]) {
    const second = basename(words[1]);
    if (ENGINE_BINS.has(second)) return second;
    // The Claude SDK's JavaScript entry, where its native binary is not used.
    if (second === "cli.js" && /claude/i.test(words[1])) return "claude";
  }
  return null;
}

/** The conversation a Claude engine resumes, read off its command line. */
export function resumedConversation(command: string): string | null {
  return /--(?:resume|session-id)(?:=|\s+)([^\s"']+)/.exec(command)?.[1] ?? null;
}

/** A booted iOS simulator's own launchd, which carries its device's udid in its path. */
export function simulatorLaunchd(command: string): string | null {
  return /^launchd_sim\s.*\/Devices\/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})\//i.exec(command)?.[1] ?? null;
}

/** How far apart Realm's boot call and the device's launchd may start and still be the one boot. */
export const BOOT_SLACK_MS = 2 * 60_000;
/** Whether a device's launchd started with the boot Realm recorded, rather than with a later one. */
export function sameBoot(bootedAt: number, launchdStartedAt: number | null): boolean {
  return launchdStartedAt !== null && Math.abs(launchdStartedAt - bootedAt) <= BOOT_SLACK_MS;
}

/** The name an app is reported under: its outermost `.app` bundle, else the binary's own name. */
export function appName(command: string): string {
  const bundle = /\/([^/]+?)\.app\//.exec(command);
  if (bundle) return bundle[1]!;
  if (simulatorLaunchd(command)) return "Simulator";
  return basename(command.split(/\s+/)[0] ?? "") || "Unknown";
}

/** How many of the biggest other apps a report names. */
export const OTHER_APPS_LISTED = 8;

/** A report's parts and sizes; the machine half and the time are the service's. `claimed` is every
 *  process counted as Realm's — what the service reads footprints for, and never part of a report. */
export type Attribution = Pick<ResourceReport, "realm" | "categories" | "parts" | "others" | "measure"> & { claimed: number[] };

export function attribute(o: {
  table: readonly ProcRow[];
  owners: Owners;
  /** Footprints read for Realm's processes. */
  footprint: ReadonlyMap<number, number>;
  /** Footprints of every process, or null where they were not read — then others are resident only. */
  allFootprint: ReadonlyMap<number, number> | null;
  /** Whether footprint is this platform's measure at all; false sends every size to resident. */
  footprintMeasured: boolean;
}): Attribution {
  const { table, owners } = o;
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const children = new Map<number, number[]>();
  for (const p of table) {
    if (p.pid === p.ppid) continue;
    const list = children.get(p.ppid);
    if (list) list.push(p.pid); else children.set(p.ppid, [p.pid]);
  }
  const claimed = new Set<number>();
  /** `pid` and every descendant nobody has claimed yet, claimed now. */
  const claimTree = (pid: number): number[] => {
    const out: number[] = [];
    const queue = [pid];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (claimed.has(next) || !byPid.has(next)) continue;
      claimed.add(next);
      out.push(next);
      for (const child of children.get(next) ?? []) queue.push(child);
    }
    return out;
  };
  const claimOne = (pid: number): number[] => {
    if (claimed.has(pid) || !byPid.has(pid)) return [];
    claimed.add(pid);
    return [pid];
  };

  const parts: ResourcePart[] = [];
  const sizeOf = (pids: readonly number[]): ResourceSize => {
    let resident = 0, footprint = 0;
    for (const pid of pids) {
      const p = byPid.get(pid)!;
      resident += p.residentBytes;
      // A process that went between the table and the footprint read is counted at its resident size.
      footprint += o.footprint.get(pid) ?? p.residentBytes;
    }
    return { processes: pids.length, residentBytes: resident, footprintBytes: o.footprintMeasured ? footprint : null };
  };
  const add = (category: ResourceCategory, ownerId: string | null, label: string, detail: string | null, pids: readonly number[]): void => {
    if (pids.length === 0) return;
    parts.push({ id: `${category}:${ownerId ?? pids[0]}`, category, ownerId, label, detail, ...sizeOf(pids) });
  };

  // The server's own descendants are what every server-side owner lives under; the app's are Electron's.
  const serverTree = new Set<number>();
  { const queue = [owners.serverPid]; while (queue.length) { const pid = queue.shift()!; if (serverTree.has(pid) || !byPid.has(pid)) continue; serverTree.add(pid); queue.push(...(children.get(pid) ?? [])); } }

  // Terminals: the shell and everything under it, and whatever else sits on its terminal — a shell's
  // prompt helpers fork away from it (powerlevel10k's gitstatusd is reparented to launchd) and stay on its tty.
  for (const t of owners.terminals) {
    const pids = claimTree(t.pid);
    const tty = t.tty?.replace(/^\/dev\//, "") ?? null;
    if (tty) for (const p of table) if (p.tty === tty && !claimed.has(p.pid)) pids.push(...claimTree(p.pid));
    add("terminals", t.terminalId, t.title, null, pids);
  }
  for (const m of owners.mcp) add("mcp", m.serverId, m.name, m.detail, claimTree(m.pid));
  if (owners.laya) add("laya", "laya", "Laya", owners.laya.detail, claimTree(owners.laya.pid));

  // Engines: the server's direct children that run an engine binary.
  const engineProcs = (children.get(owners.serverPid) ?? [])
    .map((pid) => byPid.get(pid)!)
    .filter((p) => !claimed.has(p.pid) && engineBin(p.command) !== null);
  const unmatched = new Set(owners.engines.map((e) => e.sessionId));
  const enginesById = new Map(owners.engines.map((e) => [e.sessionId, e]));
  const engineDetail = (e: EngineOwner) => e.detail;
  const leftovers: ProcRow[] = [];
  for (const p of engineProcs) {
    const bin = engineBin(p.command)!;
    if (bin === "codex" && /\bapp-server\b/.test(p.command)) {
      const codex = owners.engines.filter((e) => e.kind === "codex");
      for (const e of codex) unmatched.delete(e.sessionId);
      add("engines", "codex", "Codex", codex.length === 1 ? codex[0]!.title : `${codex.length} sessions`, claimTree(p.pid));
      continue;
    }
    const resumed = bin === "claude" ? resumedConversation(p.command) : null;
    const session = resumed ? owners.engines.find((e) => unmatched.has(e.sessionId) && e.providerSessionId === resumed) : undefined;
    if (session) {
      unmatched.delete(session.sessionId);
      add("engines", session.sessionId, session.title, engineDetail(session), claimTree(p.pid));
    } else {
      leftovers.push(p);
    }
  }
  // By start: oldest process first, to the oldest session of its kind that started no later than it.
  const SECOND = 1_000;
  for (const p of leftovers.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
    const kind = KIND_OF_BIN[engineBin(p.command)!] ?? null;
    const candidates = [...unmatched].map((id) => enginesById.get(id)!)
      .filter((e) => (kind === null || e.kind === kind) && (p.startedAt === null || e.startedAt <= p.startedAt + SECOND))
      .sort((a, b) => a.startedAt - b.startedAt);
    const session = candidates[0];
    if (session) {
      unmatched.delete(session.sessionId);
      add("engines", session.sessionId, session.title, engineDetail(session), claimTree(p.pid));
    } else {
      add("engines", null, `${engineBin(p.command)} (no session)`, null, claimTree(p.pid));
    }
  }

  // Simulators Realm booted: the device's own launchd and everything it runs, and its stream.
  const realmSims = new Map(owners.simulators.map((s) => [s.udid.toUpperCase(), s]));
  for (const p of table) {
    const udid = simulatorLaunchd(p.command)?.toUpperCase();
    const sim = udid ? realmSims.get(udid) : undefined;
    if (!sim || !sameBoot(sim.bootedAt, p.startedAt)) continue;
    const pids = claimTree(p.pid);
    for (const q of table) if (!claimed.has(q.pid) && /serve-sim/.test(q.command) && q.command.toUpperCase().includes(udid!)) pids.push(...claimTree(q.pid));
    add("simulators", sim.udid, sim.name, sim.detail, pids);
  }

  // The app: each Electron process as main labels it, browser panes first, then its other children.
  if (owners.app) {
    const order: AppProcess["kind"][] = ["browser", "window", "gpu", "utility", "other", "main"];
    const grouped = new Map<string, { a: AppProcess; pids: number[] }>();
    for (const kind of order) for (const a of owners.app.filter((x) => x.kind === kind)) {
      const pids = claimOne(a.pid);
      if (pids.length === 0) continue;
      const key = a.ownerId ? `${a.kind}:${a.ownerId}` : `${a.kind}:${a.label}`;
      const g = grouped.get(key);
      if (g) g.pids.push(...pids); else grouped.set(key, { a, pids });
    }
    for (const { a, pids } of grouped.values()) add(a.kind === "browser" ? "browsers" : "app", a.ownerId ?? `${a.kind}:${a.label}`, a.label, a.detail, pids);
    // What main spawned that is not Electron's own — the computer-use helper, the phone's video — but
    // never the server, which in a development build is main's child and is counted as itself.
    const main = owners.app.find((a) => a.kind === "main");
    if (main) {
      const helpers = (children.get(main.pid) ?? []).filter((pid) => !serverTree.has(pid)).flatMap((pid) => claimTree(pid));
      add("app", "app:helpers", "Helpers", null, helpers);
    }
  }

  add("server", "server", "Realm's server", null, claimOne(owners.serverPid));
  // Everything else under the server: grouped by what it runs, so forty `git` calls read as one line.
  const rest = new Map<string, number[]>();
  for (const pid of serverTree) {
    if (claimed.has(pid)) continue;
    const name = appName(byPid.get(pid)!.command);
    const pids = claimTree(pid);
    const list = rest.get(name);
    if (list) list.push(...pids); else rest.set(name, pids);
  }
  for (const [name, pids] of rest) add("other", `other:${name}`, name, null, pids);

  const weight = (s: ResourceSize) => s.footprintBytes ?? s.residentBytes;
  parts.sort((a, b) => weight(b) - weight(a));
  const totals = new Map<ResourceCategory, ResourceSize>();
  for (const p of parts) {
    const t = totals.get(p.category) ?? { processes: 0, residentBytes: 0, footprintBytes: o.footprintMeasured ? 0 : null };
    totals.set(p.category, {
      processes: t.processes + p.processes, residentBytes: t.residentBytes + p.residentBytes,
      footprintBytes: t.footprintBytes === null || p.footprintBytes === null ? null : t.footprintBytes + p.footprintBytes,
    });
  }
  const categories = [...totals].map(([category, s]) => ({ category, ...s })).sort((a, b) => weight(b) - weight(a));
  const realm = categories.reduce<ResourceSize>((acc, c) => ({
    processes: acc.processes + c.processes, residentBytes: acc.residentBytes + c.residentBytes,
    footprintBytes: acc.footprintBytes === null || c.footprintBytes === null ? null : acc.footprintBytes + c.footprintBytes,
  }), { processes: 0, residentBytes: 0, footprintBytes: o.footprintMeasured ? 0 : null });

  // Everyone else, by app, by name and size only. A simulator's processes are its own apps' binaries
  // (SpringBoard, the app under test), so a device is grouped from its launchd down.
  const simulatorProcs = new Set<number>();
  for (const p of table) {
    if (claimed.has(p.pid) || !simulatorLaunchd(p.command)) continue;
    const queue = [p.pid];
    while (queue.length) { const pid = queue.shift()!; if (simulatorProcs.has(pid)) continue; simulatorProcs.add(pid); queue.push(...(children.get(pid) ?? [])); }
  }
  const apps = new Map<string, ResourceSize>();
  for (const p of table) {
    if (claimed.has(p.pid) || p.pid === 0) continue;
    const name = simulatorProcs.has(p.pid) ? "Simulator" : appName(p.command);
    const a = apps.get(name) ?? { processes: 0, residentBytes: 0, footprintBytes: o.allFootprint ? 0 : null };
    const fp = o.allFootprint?.get(p.pid);
    apps.set(name, {
      processes: a.processes + 1, residentBytes: a.residentBytes + p.residentBytes,
      footprintBytes: a.footprintBytes === null ? null : a.footprintBytes + (fp ?? p.residentBytes),
    });
  }
  const others: OtherApp[] = [...apps].map(([name, s]) => ({ name, ...s }))
    .sort((a, b) => weight(b) - weight(a)).slice(0, OTHER_APPS_LISTED);

  return { realm, categories, parts, others, measure: o.footprintMeasured ? "footprint" : "resident", claimed: [...claimed] };
}
