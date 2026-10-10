import { Methods } from "@realm/contracts";
import type { RpcServer } from "../../rpc/server";
import { NotFoundError } from "../../store/rows";
import type { RecordTypeService } from "./service";

/**
 * The Records pages' methods for a team's kinds of record. Registered here so record types stay in
 * their own module; the schemas are the contract's like every other method's. There is no agent tool
 * beside these: a role reads its team's types (`record_types`) and never writes one.
 */
export function registerRecordTypeMethods(rpc: Pick<RpcServer, "register">, types: RecordTypeService, spaceExists: (id: string) => boolean): void {
  const space = (id: string): string => { if (!spaceExists(id)) throw new NotFoundError("space", id); return id; };
  rpc.register("team.recordTypes.list", Methods["team.recordTypes.list"].params, async (p) => types.views(space(p.spaceId), p.archived));
  rpc.register("team.recordTypes.create", Methods["team.recordTypes.create"].params, async (p) => types.create({ ...p, spaceId: space(p.spaceId) }));
  rpc.register("team.recordTypes.update", Methods["team.recordTypes.update"].params, async (p) => types.update(p));
  rpc.register("team.recordTypes.archive", Methods["team.recordTypes.archive"].params, async (p) => types.archive(p.id, p.archived));
}
