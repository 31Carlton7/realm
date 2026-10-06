import {
  AGENT_INSTALL_ROUTES, AgentKindSchema, agentLabel, canRunUpdate, installCommand, isNewerVersion, parseBrewFormula,
  parseNpmLatest, parsePypiLatest, updateChannel, updateCommand, updatePlan, updateRefusal,
  type AgentKind, type CliStatus, type InstallProvenance, type InstallRoute,
} from "@realm/contracts";
import type { ProbeResult } from "@realm/adapters";
import { ProbeCache } from "../sessions/probe-cache";
import { agentBin } from "./bins";
import { resolveInstall } from "./provenance";

/**
 * How long a version check is reused. Six hours, not the probe's thirty seconds: a CLI's published
 * version changes on a release cadence, and the cost of asking is a network round trip per installed
 * agent. Every "check now" gesture forces past it, and so does finishing an install — after Realm
 * changes the machine, a cached answer describes a machine that no longer exists.
 */
const CLI_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

/** A published version lookup is a courtesy, never load-bearing: the same budget the model catalog
 *  gives its fetch, and for the same reason — a slow registry may not become a slow Settings page. */
const CHECK_TIMEOUT_MS = 8000;

/** What one sweep learned about one kind. `latest` is null when the CLI is not installed (nothing to
 *  update), when its route has no version channel, or when the lookup failed — three different
 *  situations that all mean the same thing to a caller: do not claim an update exists. */
type CliCheck = { binPath: string | null; provenance: InstallProvenance; latest: string | null };

/** The tool an argv install route runs — the binary `commandSpec` spawns for it, which for all three
 *  is the method's own name. A vendor script needs only curl and bash, which every Mac has. */
type InstallTool = "npm" | "brew" | "uv";
const toolFor = (route: InstallRoute | null): InstallTool | null =>
  route?.method === "npm" || route?.method === "brew" || route?.method === "uv" ? route.method : null;

/** Why there is no Install button, for someone who has never opened a terminal. The npm sentence
 *  names Node.js because that is the thing to go and get — nobody downloads "npm". */
function toolMissing(kind: AgentKind, tool: InstallTool): string {
  const name = agentLabel(kind);
  if (tool === "npm") return `${name} installs with npm, which comes with Node.js — and Node.js isn't on this Mac yet.`;
  if (tool === "brew") return `${name} installs with Homebrew, and Homebrew isn't on this Mac yet.`;
  return `${name} installs with uv, Astral's installer for Python tools — and uv isn't on this Mac yet.`;
}

const CARRIED_CLAUDE = "This is the copy of Claude Code that comes with Realm, and it updates when Realm does.";

/**
 * "Is there a newer version of each agent CLI, and may Realm install it?"
 *
 * The two halves are cached separately because they go stale at different rates and cost different
 * things. Whether a CLI is *there* is the existing 30-second `agents.probe`, which spawns a child per
 * agent; whether a newer one is *published* is this service's six-hour sweep, which is fs plus a
 * public GET per installed agent. `status()` joins them, `force` forces both.
 *
 * The sweep only asks the registry about CLIs that are actually on the machine. A version the user
 * cannot be shown a diff against is not worth a request — for a missing CLI the offer is "install
 * it", which needs no version at all.
 *
 * Nothing here ever runs a package manager. Deciding whether an update exists and applying one are
 * kept apart on purpose: this half is safe to run unattended on launch precisely because it cannot
 * change the machine.
 */
export class CliService {
  private checks: ProbeCache<Record<string, CliCheck>>;
  /**
   * Which of the programs `join` decides on are on PATH right now: the three install tools, and
   * `claude` itself (see the Claude branch in `join`).
   *
   * Cached for the probe's thirty seconds, not the sweep's six hours, because this answer changes on
   * the timescale of a person installing something — and the refusal below asks them to do exactly
   * that. A Node.js installed after the first look must read as installed by the time they come back
   * and click again; Settings' "Check for updates" forces it sooner. It is fs only, never a spawn.
   */
  private tools: ProbeCache<ReadonlySet<string>>;

  constructor(private readonly d: {
    /** `SessionService.probe` — the same cache every other probe caller rides. */
    probe: (opts: { force?: boolean }) => Promise<ProbeResult[]>;
    /** Injected so tests never reach a registry — and so a live check can. */
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    ttlMs?: number;
    now?: () => number;
  }) {
    this.checks = new ProbeCache(() => this.sweep(), { ttlMs: d.ttlMs ?? CLI_CHECK_TTL_MS, now: d.now });
    this.tools = new ProbeCache(() => this.lookForTools(), { now: d.now });
  }

  /** Every kind's install and update situation. Never throws: a caller asking "what is on this
   *  machine" must get an answer even with the network gone. */
  async status({ force = false }: { force?: boolean } = {}): Promise<CliStatus[]> {
    const [probes, checks, tools] = await Promise.all([
      this.d.probe({ force }),
      this.checks.get({ force }).catch((): Record<string, CliCheck> => ({})),
      // Null is "could not look", which is no evidence anything is missing: no refusal follows from it.
      this.tools.get({ force }).catch(() => null),
    ]);
    return AgentKindSchema.options.map((kind) => this.join(kind, probes.find((p) => p.kind === kind), checks[kind], tools));
  }

  /** Re-check with the caches bypassed — what an install or update calls when it finishes, because
   *  the answer it just invalidated is the one the UI is about to render. */
  refresh(): Promise<CliStatus[]> {
    return this.status({ force: true });
  }

  private join(kind: AgentKind, probe: ProbeResult | undefined, check: CliCheck | undefined, tools: ReadonlySet<string> | null): CliStatus {
    const route = AGENT_INSTALL_ROUTES[kind];
    const provenance = check?.provenance ?? "unknown";
    const installed = probe?.available ?? false;
    const version = probe?.version ?? null;
    const latest = installed ? check?.latest ?? null : null;
    const base = {
      kind, installed, version, binPath: check?.binPath ?? null, provenance, latest,
    };
    if (!installed) {
      const command = installCommand(route);
      const tool = toolFor(route);
      /* An offer the machine cannot run is not an offer. With no npm, `cli.run` spawns one anyway and
         the person reads `spawn npm ENOENT` — after pressing a button Realm drew. Say what is missing
         instead, in the words of the thing to go and get. */
      if (command && tool && tools && !tools.has(tool)) {
        return { ...base, updateAvailable: false, action: "none", command: null, refusal: toolMissing(kind, tool) };
      }
      return { ...base, updateAvailable: false, action: command ? "install" : "none", command, refusal: null };
    }
    /* Claude is available with no `claude` on PATH in exactly one way: the probe fell back to the copy
       the Agent SDK carries inside Realm (`probeClaude`). That copy is Realm's to update — it moves
       when the SDK floor does — and the self-updater below would spawn a `claude` that is not there.
       An override is looked up as itself, so a REALM_CLAUDE_BIN stub still reads as a CLI on PATH. */
    if (kind === "claude" && tools && !tools.has(agentBin("claude", this.d.env ?? process.env))) {
      return { ...base, binPath: null, latest: null, updateAvailable: false, action: "none", command: null, refusal: CARRIED_CLAUDE };
    }
    const plan = updatePlan(route, provenance, kind);
    if (!isNewerVersion(version, latest) || !latest) {
      /* No newer version KNOWN — which is not the same as up to date. Five of the CLIs ship their
         own updater, and it resolves latest at the moment it runs, from the vendor's channel rather
         than from the npm registry Realm happens to watch. cursor-agent has no registry Realm can
         watch at all, so this branch was its permanent state. Offer the command; `updateAvailable`
         stays false so the row does not claim an update is waiting. */
      const own = plan?.method === "self" ? updateCommand(plan, "") : null;
      return { ...base, updateAvailable: false, action: own ? "update" : "none", command: own, refusal: null };
    }
    // An update exists. Whether Realm may apply it is a separate question with its own answer, and a
    // refusal is shown rather than swallowed — the user still learns a newer version is out there.
    if (!canRunUpdate(route, provenance, kind)) {
      return { ...base, updateAvailable: true, action: "none", command: null, refusal: updateRefusal(route, provenance, kind) };
    }
    /* Updated the way it was INSTALLED. A Homebrew install takes `brew upgrade`, an npm one takes
       npm — matching the route instead of the provenance is what made a plain `brew install codex`
       a permanent dead end. */
    return { ...base, updateAvailable: true, action: "update", command: updateCommand(plan, latest), refusal: null };
  }

  /** One pass over every kind with a version channel: find its binary, then ask its registry. Both
   *  legs are per-kind independent, so one dead registry costs one null rather than the whole sweep. */
  private async sweep(): Promise<Record<string, CliCheck>> {
    const env = this.d.env ?? process.env;
    const entries = await Promise.all(AgentKindSchema.options.map(async (kind): Promise<[string, CliCheck]> => {
      const bin = agentBin(kind, env);
      const route = AGENT_INSTALL_ROUTES[kind];
      const found = bin ? await resolveInstall(bin, env) : null;
      const channel = updateChannel(route);
      // No binary means nothing to update; no channel means no way to ask. Either way, no request.
      const latest = found && channel ? await this.fetchLatest(channel) : null;
      return [kind, { binPath: found?.path ?? null, provenance: found?.provenance ?? "unknown", latest }];
    }));
    return Object.fromEntries(entries);
  }

  /** PATH lookups for `tools`, the way `resolveInstall` finds every binary here — fs, no shell. */
  private async lookForTools(): Promise<ReadonlySet<string>> {
    const env = this.d.env ?? process.env;
    const names = ["npm", "brew", "uv", agentBin("claude", env)];
    const found = await Promise.all(names.map(async (name) => ((await resolveInstall(name, env)) ? name : null)));
    return new Set(found.filter((name): name is string => name !== null));
  }

  private async fetchLatest(channel: NonNullable<ReturnType<typeof updateChannel>>): Promise<string | null> {
    try {
      const f = this.d.fetchImpl ?? fetch;
      const res = await f(channel.url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), headers: { accept: "application/json" } });
      if (!res.ok) return null;
      const body: unknown = await res.json();
      if (channel.kind === "npm") return parseNpmLatest(body);
      if (channel.kind === "pypi") return parsePypiLatest(body);
      return parseBrewFormula(body);
    } catch {
      // A registry that is down, slow, or has changed shape is a reason to say nothing, never a
      // reason to fail the caller — the rest of the Settings page must still render.
      return null;
    }
  }
}
