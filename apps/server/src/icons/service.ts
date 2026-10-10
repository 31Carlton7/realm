import { readFile, stat } from "node:fs/promises";
import { generateSvgIcon } from "@realm/adapters";
import { mimeForPath, type IconAsset } from "@realm/contracts";
import type { IconAssetsStore } from "../store/icon-assets";
import { RpcError } from "../store/rows";
import type { ClaudeHomes } from "../agents/claude-homes";

const MAX_GENERATED_SVG_BYTES = 20 * 1024;
const MAX_UPLOAD_BYTES = 512 * 1024;
const ALLOWED_UPLOAD_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);

/**
 * A structural sanity filter over an AI-generated SVG before it is ever persisted — NOT the XSS
 * boundary. That boundary is the renderer's DOMPurify sanitize-on-render (`SpaceIcon.tsx`), which
 * runs on every render regardless of what is stored here; this check just rejects obviously
 * malicious or oversized output at generation time instead of silently repairing it.
 */
export function validateGeneratedSvg(svg: string): void {
  if (svg.length > MAX_GENERATED_SVG_BYTES) throw new RpcError("ICON_TOO_LARGE", `generated icon is ${svg.length} bytes, over the ${MAX_GENERATED_SVG_BYTES}-byte cap`);
  if (!/^\s*<svg[\s>]/.test(svg) || !/<\/svg>\s*$/.test(svg)) throw new RpcError("ICON_INVALID", "generated output is not a single <svg> element");
  const banned = [/<script[\s>]/i, /\son\w+\s*=/i, /javascript:/i, /<foreignobject[\s>]/i, /(?:xlink:)?href\s*=\s*["']https?:/i, /<image[\s>]/i];
  for (const re of banned) if (re.test(svg)) throw new RpcError("ICON_INVALID", "generated output contains disallowed content");
}

export class IconGenerationService {
  /**
   * `homes` says which Claude config folder a profile's icons are drawn under, so the call is
   * billed to the account the profile uses; left out, every icon is the default folder's. `draw`
   * is the model call itself, named so a suite can stand in for it and never make one.
   */
  constructor(private assets: IconAssetsStore, private o: { homes?: Pick<ClaudeHomes, "ofProfile" | "assertPresent">; draw?: typeof generateSvgIcon } = {}) {}

  async generate(profileId: string, prompt: string): Promise<IconAsset> {
    const draw = this.o.draw ?? generateSvgIcon;
    const home = this.o.homes?.ofProfile(profileId) ?? null;
    this.o.homes?.assertPresent(home, { resumes: false });
    const svg = home === null ? await draw(prompt) : await draw(prompt, { configDir: home });
    validateGeneratedSvg(svg);
    return this.assets.create({ profileId, kind: "generated", mime: "image/svg+xml", dataText: svg, prompt });
  }

  async upload(profileId: string, path: string): Promise<IconAsset> {
    const st = await stat(path);
    if (!st.isFile()) throw new RpcError("ICON_INVALID", "not a file");
    if (st.size > MAX_UPLOAD_BYTES) throw new RpcError("ICON_TOO_LARGE", `${path} is over the ${MAX_UPLOAD_BYTES}-byte icon upload cap`);
    const mime = mimeForPath(path);
    if (!ALLOWED_UPLOAD_MIMES.has(mime)) throw new RpcError("ICON_INVALID", `${mime} is not an accepted icon image type`);
    const buf = await readFile(path);
    if (mime === "image/svg+xml") {
      const svg = buf.toString("utf8");
      validateGeneratedSvg(svg);
      return this.assets.create({ profileId, kind: "image", mime, dataText: svg });
    }
    return this.assets.create({ profileId, kind: "image", mime, dataText: `data:${mime};base64,${buf.toString("base64")}` });
  }
}
