import {
  BROWSER_DISCARD_HIDDEN_DEFAULT, BROWSER_KEEP_HIDDEN_DEFAULT, ENGINE_IDLE_MINUTES_DEFAULT, LAYA_IDLE_STOP_DEFAULT, MCP_IDLE_STOP_DEFAULT,
  RESOURCES_ADAPTIVE_DEFAULT, SIMULATOR_IDLE_SHUTDOWN_DEFAULT,
  type FreeAction, type Freeable, type ResourcePolicies, type ResourcePolicyKey, type ResourceReport,
} from "@realm/contracts";
import { RpcError } from "../store/rows";
import { minutesSetting } from "./policies";

/**
 * The Memory page's side of the resource manager: the report with what each "free memory now" button
 * would let go of, the policies' windows as set and as pressure leaves them, and the buttons
 * themselves. Every button keeps the policies' rules — nothing mid-work goes — and skips only the wait.
 */
export class ResourceControls {
  constructor(private readonly d: {
    settings: { get(key: string): unknown; set(key: string, value: unknown): void };
    snapshot: (o: { fresh?: boolean }) => Promise<ResourceReport>;
    adapt: (minutes: number) => number;
    engines: { idleEngines(): string[]; stopIdleNow(): Promise<string[]> };
    simulators: { idleCandidates(): string[]; sweepIdle(o: { minutes?: number }): Promise<string[]> };
    laya: { stoppable(): boolean; stopIdle(): Promise<boolean>; idleChanged(): void };
    /** main's sweep; null when no app is attached. */
    browsers: () => { call(op: "browserSweep", params: { hiddenMs: number | null; keepHidden: number }): Promise<unknown> } | null;
    /** A browser window or the adaptive switch changed: the policies look again now, so main's budget
     *  for unmounted panes keeps to the new settings before the clock's next tick. */
    browserPolicyChanged?: () => void;
  }) {}

  async snapshot(o: { fresh?: boolean } = {}): Promise<ResourceReport> {
    const report = await this.d.snapshot(o);
    return { ...report, freeable: this.freeable(report) };
  }

  /** What each button would let go of, priced from the report's own parts. */
  private freeable(report: ResourceReport): NonNullable<ResourceReport["freeable"]> {
    const size = (p: ResourceReport["parts"][number]) => p.footprintBytes ?? p.residentBytes;
    const sum = (parts: ResourceReport["parts"]): Freeable => ({ count: parts.length, bytes: parts.reduce((n, p) => n + size(p), 0) });
    const idle = new Set(this.d.engines.idleEngines());
    const sims = new Set(this.d.simulators.idleCandidates());
    return {
      engines: { count: idle.size, bytes: sum(report.parts.filter((p) => p.category === "engines" && p.ownerId !== null && idle.has(p.ownerId))).bytes },
      simulators: sum(report.parts.filter((p) => p.category === "simulators" && p.ownerId !== null && sims.has(p.ownerId))),
      browsers: sum(report.parts.filter((p) => p.category === "browsers" && (p.detail ?? "").startsWith("Hidden"))),
      laya: this.d.laya.stoppable() ? sum(report.parts.filter((p) => p.category === "laya")) : { count: 0, bytes: 0 },
    };
  }

  policies(): ResourcePolicies {
    const s = this.d.settings;
    const engineIdleMinutes = minutesSetting(s.get("sessions.engineIdleMinutes"), ENGINE_IDLE_MINUTES_DEFAULT);
    const mcpIdleMinutes = minutesSetting(s.get("mcp.idleStopMinutes"), MCP_IDLE_STOP_DEFAULT);
    const layaIdleMinutes = minutesSetting(s.get("laya.idleStopMinutes"), LAYA_IDLE_STOP_DEFAULT);
    const simulatorIdleMinutes = minutesSetting(s.get("simulators.idleShutdownMinutes"), SIMULATOR_IDLE_SHUTDOWN_DEFAULT);
    const browserHiddenMinutes = minutesSetting(s.get("browser.discardHiddenMinutes"), BROWSER_DISCARD_HIDDEN_DEFAULT);
    const browserKeepHidden = minutesSetting(s.get("browser.keepHidden"), BROWSER_KEEP_HIDDEN_DEFAULT);
    const adaptiveRaw = s.get("resources.adaptive");
    const adaptive = typeof adaptiveRaw === "boolean" ? adaptiveRaw : RESOURCES_ADAPTIVE_DEFAULT;
    const a = this.d.adapt;
    return {
      engineIdleMinutes, mcpIdleMinutes, layaIdleMinutes, simulatorIdleMinutes, browserHiddenMinutes, browserKeepHidden, adaptive,
      effective: { engines: a(engineIdleMinutes), mcp: a(mcpIdleMinutes), laya: a(layaIdleMinutes), simulators: a(simulatorIdleMinutes), browsers: a(browserHiddenMinutes) },
    };
  }

  setPolicy(key: ResourcePolicyKey, value: number | boolean): ResourcePolicies {
    if (key === "resources.adaptive") {
      if (typeof value !== "boolean") throw new RpcError("INVALID_ARGUMENT", "the adaptive switch is on or off");
    } else if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new RpcError("INVALID_ARGUMENT", `${key} takes a whole number of minutes, 0 for never`);
    }
    this.d.settings.set(key, value);
    // Laya's window is a timer of its own, armed from the last step: measured again now.
    if (key === "laya.idleStopMinutes" || key === "resources.adaptive") this.d.laya.idleChanged();
    if (key === "browser.discardHiddenMinutes" || key === "browser.keepHidden" || key === "resources.adaptive") this.d.browserPolicyChanged?.();
    return this.policies();
  }

  async free(action: FreeAction): Promise<{ freed: number }> {
    switch (action) {
      case "engines": return { freed: (await this.d.engines.stopIdleNow()).length };
      case "simulators": return { freed: (await this.d.simulators.sweepIdle({ minutes: 0 })).length };
      case "laya": return { freed: (await this.d.laya.stopIdle()) ? 1 : 0 };
      case "browsers": {
        const app = this.d.browsers();
        if (!app) return { freed: 0 };
        const r = (await app.call("browserSweep", { hiddenMs: 0, keepHidden: 0 })) as { discarded?: unknown[] } | null;
        return { freed: Array.isArray(r?.discarded) ? r.discarded.length : 0 };
      }
    }
  }
}
