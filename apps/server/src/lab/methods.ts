import { Methods, type MethodName, type MethodResult } from "@realm/contracts";
import type { z } from "zod";
import type { RpcServer } from "../rpc/server";
import type { LabService } from "./service";

type Params<M extends MethodName> = z.infer<(typeof Methods)[M]["params"]>;

/** The `lab.*` methods (contracts/rpc.ts), registered beside the rest from app.ts. */
export function registerLabMethods(rpc: Pick<RpcServer, "register">, lab: LabService): void {
  const reg = <M extends MethodName>(name: M, fn: (p: Params<M>) => MethodResult<M> | Promise<MethodResult<M>>) =>
    rpc.register(name, Methods[name].params, async (p) => fn(p as Params<M>));
  reg("lab.status", () => lab.status());
  reg("lab.setEnabled", (p) => lab.setEnabled(p.enabled));
  reg("lab.setUpdateWindow", (p) => lab.setUpdateWindow(p.hour, p.capMinutes));
  reg("lab.readiness", () => lab.readiness());
  reg("lab.devices", () => lab.devices());
  reg("lab.deviceScan", () => lab.scan());
  reg("lab.deviceAdd", (p) => lab.addDevice(p));
  reg("lab.deviceUpdate", (p) => lab.updateDevice(p.id, {
    ...(p.name !== undefined ? { name: p.name } : {}),
    ...(p.spaceId !== undefined ? { spaceId: p.spaceId } : {}),
    ...(p.accounts !== undefined ? { accounts: p.accounts } : {}),
  }));
  reg("lab.deviceRemove", (p) => lab.removeDevice(p.id));
  reg("lab.updateReady", (p) => lab.updateReady(p.version, p.from));
  reg("lab.updateNow", () => lab.updateNow());
  reg("lab.appVersion", (p) => lab.appVersion(p.version));
}
