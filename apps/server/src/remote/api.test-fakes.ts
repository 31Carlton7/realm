import type { Item, Machine, MachineState, MethodName, MethodParams, MethodResult, Profile, QueuedPrompt, Session, Simulator, SimulatorState, Space } from "@realm/contracts";
import type { ChannelContext } from "./api";
import type { RpcPort } from "./rpc-port";

/** Rows and a fake of the desktop's RPC, for the mobile API's tests. */

export const profile = (id: string, name = `Profile ${id}`, icon = "user"): Profile =>
  ({ id, name, icon, color: "#6b7280", sortOrder: 0, browserPartition: `persist:browser-${id}`, createdAt: 0, updatedAt: 0 });
export const space = (id: string, profileId = "p1"): Space =>
  ({ id, profileId, name: `Space ${id}`, icon: "folder", color: "#7c6cff", sortOrder: 0, folderPath: "/tmp", groups: null, layout: null, activeItemId: null, createdAt: 0, updatedAt: 0 });
export const item = (refId: string, spaceId: string, title: string, extra: Partial<Item> = {}): Item =>
  ({ id: `i-${refId}`, spaceId, kind: "session", title, sortOrder: 0, pinned: false, archived: false, refId, createdAt: 0, updatedAt: 0, ...extra });
export const session = (id: string, spaceId: string, extra: Partial<Session> = {}): Session =>
  ({ id, spaceId, projectId: null, agentKind: "fake", model: null, effort: null, fastMode: false, permissionMode: "default", environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", cwd: "/tmp", status: "idle",
    providerSessionId: null, title: `${id} (session)`, lastEventSeq: 0, seenSeq: 0, terminalItemId: null, dispatchedBy: null, activityAt: 0, createdAt: 0, updatedAt: 0, ...extra });

export const simulator = (id: string, spaceId: string, name: string, extra: Partial<Simulator> = {}): Simulator =>
  ({ id, spaceId, name, udid: `UDID-${id}`, platform: "ios", physical: false, createdAt: 0, updatedAt: 0, ...extra });
export const simulatorState = (simulatorId: string, status: SimulatorState["status"]): SimulatorState =>
  ({ simulatorId, status, udid: `UDID-${simulatorId}`, serial: null, streamUrl: null, wsUrl: null, screen: null, error: null, detail: null, physical: false });
export const machine = (id: string, spaceId: string, name: string, source: Machine["source"]): Machine =>
  ({ id, spaceId, name, source, endpoint: null, hasPassword: false, createdAt: 0, updatedAt: 0 });
export const machineState = (machineId: string, status: MachineState["status"]): MachineState =>
  ({ machineId, status, wsUrl: null, width: null, height: null, error: null, detail: null });

/** A PNG's signature and header: all of one that its size is read from. */
export function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return b;
}

/** A JPEG's start, frame header and end: all of one that its size is read from. */
export const jpegHeader = (width: number, height: number): Buffer => Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff,
  0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
]);

export type Lists = { profiles?: Profile[]; spaces?: Space[]; sessions: Session[]; items: Item[]; settings?: Record<string, unknown>; queued?: Record<string, QueuedPrompt[]> };

/** The desktop's RPC as `home.get` reads it: `items.listAll` leaves archived rows out, as the store does. */
export function fakeRpc(h: Lists, more: Partial<Record<MethodName, (p: never) => unknown>> = {}): RpcPort & { calls: string[] } {
  const calls: string[] = [];
  const answer = (method: MethodName, params: unknown): unknown => {
    const extra = more[method];
    if (extra) return extra(params as never);
    switch (method) {
      case "profiles.list": return h.profiles ?? [profile("p1"), profile("p2")];
      case "spaces.list": return h.spaces ?? [space("s1"), space("s2", "p2")];
      case "sessions.listAll": return h.sessions;
      case "items.listAll": return h.items.filter((i) => !i.archived);
      case "settings.get": return { value: h.settings?.[(params as { key: string }).key] ?? null };
      case "sessions.get": {
        const found = h.sessions.find((s) => s.id === (params as { id: string }).id);
        if (!found) throw new Error(`no session ${(params as { id: string }).id}`);
        return found;
      }
      case "sessions.events": return [];
      case "sessions.queued": return { queued: h.queued?.[(params as { id: string }).id] ?? [] };
      default: throw new Error(`the fake has no ${method}`);
    }
  };
  return {
    calls,
    call: async <M extends MethodName>(method: M, params: MethodParams<M>) => { calls.push(method); return answer(method, params) as MethodResult<M>; },
    onEvent: () => () => {},
    close: () => {},
  };
}

export const channel = (rpc: RpcPort): ChannelContext => ({ phoneId: "phone", rpc, sessions: new Map() });
