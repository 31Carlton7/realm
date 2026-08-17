import type { AgentKind, SessionEvent } from "@realm/contracts";

export type McpStdioConfig = { name: string; command: string; args?: string[]; env?: Record<string, string> };

export type StartOptions = {
  cwd: string;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string;
  systemContext?: string;
  mcpServers: McpStdioConfig[];
  resume?: string | null;
  env?: Record<string, string>;
};

export type UserMessage = { text: string; attachments: { path: string; mime: string }[] };
export type PermissionDecision = "allow" | "allow_always" | "deny";

export interface AgentHandle {
  readonly events: AsyncIterable<SessionEvent>;
  send(message: UserMessage): void;
  respondPermission(requestId: string, decision: PermissionDecision): void;
  interrupt(): Promise<void>;
  setOptions(opts: { model?: string; permissionMode?: string }): Promise<void>;
  dispose(): Promise<void>;
}

export type ProbeResult = { kind: AgentKind; available: boolean; version: string | null; loggedIn: boolean | null; reason: string | null };

export interface AgentAdapter {
  readonly kind: AgentKind;
  probe(): Promise<ProbeResult>;
  start(opts: StartOptions): AgentHandle;
}

export type AdapterRegistry = Partial<Record<AgentKind, AgentAdapter>>;
