import type { Db } from "../db/database";
import { newId, type IconAsset, type IconAssetKind } from "@realm/contracts";
import { NotFoundError, now } from "./rows";

type Row = { id: string; profile_id: string; kind: string; mime: string; data_text: string; prompt: string | null; created_at: number };
const toAsset = (r: Row): IconAsset => ({
  id: r.id, profileId: r.profile_id, kind: r.kind as IconAssetKind, mime: r.mime, dataText: r.data_text,
  prompt: r.prompt, createdAt: r.created_at,
});

/** The reusable per-profile library behind the space icon picker's "Generated"/"Uploaded" sections
 *  (`Space.icon = "asset:" + id`, `parseSpaceIcon`) — one row per AI-generated or uploaded icon,
 *  never per-space, so the same generation or upload is available to every space in the profile. */
export class IconAssetsStore {
  constructor(private db: Db) {}
  list(profileId: string): IconAsset[] {
    return (this.db.prepare("SELECT * FROM icon_assets WHERE profile_id = ? ORDER BY created_at DESC").all(profileId) as Row[]).map(toAsset);
  }
  get(id: string): IconAsset | null {
    const r = this.db.prepare("SELECT * FROM icon_assets WHERE id = ?").get(id) as Row | undefined;
    return r ? toAsset(r) : null;
  }
  create(input: { profileId: string; kind: IconAssetKind; mime: string; dataText: string; prompt?: string | null }): IconAsset {
    if (!this.db.prepare("SELECT 1 FROM profiles WHERE id = ?").get(input.profileId)) throw new NotFoundError("profile", input.profileId);
    const id = newId();
    this.db.prepare("INSERT INTO icon_assets (id, profile_id, kind, mime, data_text, prompt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.profileId, input.kind, input.mime, input.dataText, input.prompt ?? null, now());
    return this.get(id)!;
  }
  delete(id: string): void {
    if (!this.get(id)) throw new NotFoundError("iconAsset", id);
    this.db.prepare("DELETE FROM icon_assets WHERE id = ?").run(id);
  }
}
