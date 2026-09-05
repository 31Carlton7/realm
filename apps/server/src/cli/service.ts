import {
  AGENT_INSTALL_ROUTES, AgentKindSchema, canRunUpdate, installCommand, isNewerVersion, parseBrewFormula,
  parseNpmLatest, updateChannel, updateCommand, updateRefusal,
  type AgentKind, type CliStatus, type InstallProvenance,
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
  }

  /** Every kind's install and update situation. Never throws: a caller asking "what is on this
   *  machine" must get an answer even with the network gone. */
  async status({ force = false }: { force?: boolean } = {}): Promise<CliStatus[]> {
    const [probes, checks] = await Promise.all([
      this.d.probe({ force }),
      this.checks.get({ force }).catch((): Record<string, CliCheck> => ({})),
    ]);
    return AgentKindSchema.options.map((kind) => this.join(kind, probes.find((p) => p.kind === kind), checks[kind]));
  }

  /** Re-check with the caches bypassed — what an install or update calls when it finishes, because
   *  the answer it just invalidated is the one the UI is about to render. */
  refresh(): Promise<CliStatus[]> {
    return this.status({ force: true });
  }

  private join(kind: AgentKind, probe: ProbeResult | undefined, check: CliCheck | undefined): CliStatus {
    const route = AGENT_INSTALL_ROUTES[kind];
    const provenance = check?.provenance ?? "unknown";
    const installed = probe?.available ?? false;
    const version = probe?.version ?? null;
    const latest = installed ? check?.latest ?? null : null;
    const base = {
      kind, installed, version, binPath: check?.binPath ?? null, provenance, latest,
    };
    if (!installed) {
      return { ...base, updateAvailable: false, action: installCommand(route) ? "install" : "none", command: installCommand(route), refusal: null };
    }
    if (!isNewerVersion(version, latest) || !latest) {
      return { ...base, updateAvailable: false, action: "none", command: null, refusal: null };
    }
    // An update exists. Whether Realm may apply it is a separate question with its own answer, and a
    // refusal is shown rather than swallowed — the user still learns a newer version is out there.
    if (!canRunUpdate(route, provenance)) {
      return { ...base, updateAvailable: true, action: "none", command: null, refusal: updateRefusal(route, provenance) };
    }
    return { ...base, updateAvailable: true, action: "update", command: updateCommand(route, latest), refusal: null };
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

  private async fetchLatest(channel: { url: string; kind: "npm" | "brew" }): Promise<string | null> {
    try {
      const f = this.d.fetchImpl ?? fetch;
      const res = await f(channel.url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), headers: { accept: "application/json" } });
      if (!res.ok) return null;
      const body: unknown = await res.json();
      return channel.kind === "npm" ? parseNpmLatest(body) : parseBrewFormula(body);
    } catch {
      // A registry that is down, slow, or has changed shape is a reason to say nothing, never a
      // reason to fail the caller — the rest of the Settings page must still render.
      return null;
    }
  }
}
