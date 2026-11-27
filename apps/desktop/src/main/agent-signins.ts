/**
 * Settings ▸ Sign-ins ▸ Let agents finish sign-ins (contracts' `agent-signins.ts`), kept by main in a
 * file of its own under REALM_HOME, for the reason Security codes is: an agent can reach realm-server
 * (its RPC, `settings_set`) and cannot reach main's file, so no agent can let itself fill without a
 * card. Off until the person turns it on, and off when the file is missing, unreadable or says
 * anything but `true`.
 *
 * The same file keeps the last agent fills, for Settings to list: site, kind, time and session. Never
 * a value, and nothing here logs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { AGENT_FILLS_KEPT, type AgentFill, type AgentFillKind, type AgentSigninsStatus } from "@realm/contracts";

const KINDS: readonly AgentFillKind[] = ["password", "generated", "code"];

export class AgentSignins {
  private cached: AgentSigninsStatus | null = null;
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}

  status(): AgentSigninsStatus {
    if (this.cached) return this.cached;
    let read: { enabled?: unknown; fills?: unknown } = {};
    try { read = JSON.parse(readFileSync(this.file, "utf8")) as typeof read; } catch { /* off, nothing filled */ }
    const fills = Array.isArray(read.fills) ? read.fills.filter(isFill).slice(0, AGENT_FILLS_KEPT) : [];
    this.cached = { enabled: read.enabled === true, fills };
    return this.cached;
  }

  enabled(): boolean { return this.status().enabled; }

  setEnabled(on: boolean): AgentSigninsStatus {
    return this.save({ ...this.status(), enabled: on });
  }

  /** One agent fill, newest first; the oldest past `AGENT_FILLS_KEPT` goes. */
  record(fill: { site: string; kind: AgentFillKind; sessionId: string | null }): void {
    const s = this.status();
    this.save({ ...s, fills: [{ ...fill, at: this.now() }, ...s.fills].slice(0, AGENT_FILLS_KEPT) });
  }

  private save(next: AgentSigninsStatus): AgentSigninsStatus {
    writeFileSync(this.file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    this.cached = next;
    return next;
  }
}

function isFill(v: unknown): v is AgentFill {
  const f = v as Partial<AgentFill> | null;
  return !!f && typeof f.site === "string" && KINDS.includes(f.kind as AgentFillKind) && typeof f.at === "number"
    && (f.sessionId === null || typeof f.sessionId === "string");
}
