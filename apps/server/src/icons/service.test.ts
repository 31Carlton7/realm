import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "../db/database";
import { IconAssetsStore } from "../store/icon-assets";
import { ProfilesStore } from "../store/profiles";
import { SettingsStore } from "../store/settings";
import { ClaudeHomes } from "../agents/claude-homes";
import { IconGenerationService } from "./service";

const SVG = `<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="20"/></svg>`;

/** Two profiles, one of which names a Claude config folder, and a model call that draws nothing. */
function world() {
  const userHome = realpathSync(tempDir("realm-user-"));
  const work = join(userHome, ".claude-work");
  mkdirSync(work);
  const db = openDatabase(join(tempDir("realm-"), "realm.db"));
  const profiles = new ProfilesStore(db);
  const mine = profiles.create({ name: "Home", icon: "user", color: "#6b7280" });
  const theirs = profiles.create({ name: "Work", icon: "user", color: "#6b7280" });
  const homes = new ClaudeHomes({ settings: new SettingsStore(db), profiles, spaces: { get: () => null }, userHome, env: {} });
  homes.set(theirs.id, work);
  const draw = vi.fn(async (_prompt: string, _o?: { configDir?: string | null }) => SVG);
  const assets = new IconAssetsStore(db);
  return { work, mine, theirs, draw, assets, icons: new IconGenerationService(assets, { homes, draw }) };
}

describe("drawing a profile's icon", () => {
  it("runs under the Claude config folder the profile names, so that account is the one billed", async () => {
    const w = world();
    const asset = await w.icons.generate(w.theirs.id, "a lighthouse");
    expect(w.draw.mock.calls).toEqual([["a lighthouse", { configDir: w.work }]]);
    expect(asset).toMatchObject({ profileId: w.theirs.id, kind: "generated", dataText: SVG, prompt: "a lighthouse" });
  });

  it("asks exactly as before for a profile that names no folder", async () => {
    const w = world();
    await w.icons.generate(w.mine.id, "a lighthouse");
    expect(w.draw.mock.calls).toEqual([["a lighthouse"]]);
  });

  it("asks exactly as before when nothing says which folder a profile uses", async () => {
    const w = world();
    await new IconGenerationService(w.assets, { draw: w.draw }).generate(w.theirs.id, "a lighthouse");
    expect(w.draw.mock.calls).toEqual([["a lighthouse"]]);
  });

  it("refuses, draws nothing and keeps nothing, when the folder has gone", async () => {
    const w = world();
    rmSync(w.work, { recursive: true });
    await expect(w.icons.generate(w.theirs.id, "a lighthouse")).rejects.toMatchObject({ code: "CLAUDE_DIR_MISSING" });
    expect(w.draw).not.toHaveBeenCalled();
    expect(w.assets.list(w.theirs.id)).toEqual([]);
  });
});
