// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { windowArguments } from "./window-args";

describe("windowArguments", () => {
  const info = { port: 8788, home: "/Users/me/Realm", token: "tok-SECRET", profileId: "p1", spaceId: "s1", land: "s2" };

  it("never puts the RPC token on the renderer's command line, which `ps` shows to every process", () => {
    const args = windowArguments(info);
    expect(args.some((a) => a.startsWith("--realm-token"))).toBe(false);
    expect(args.join(" ")).not.toContain("tok-SECRET");
  });

  it("is what every window is started with: no main or preload source writes --realm-token itself", () => {
    const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const path = join(dir, e.name);
      if (e.isDirectory()) return sources(path);
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
    });
    const writers = [...sources(__dirname), ...sources(join(__dirname, "../preload"))]
      .filter((path) => readFileSync(path, "utf8").includes("--realm-token"));
    expect(writers).toEqual([]);
  });

  it("still tells the renderer where the server is and which window it is", () => {
    expect(windowArguments(info)).toEqual(expect.arrayContaining([
      "--realm-port=8788", "--realm-home=/Users/me/Realm", "--realm-profile=p1", "--realm-space=s1", "--realm-land=s2",
    ]));
  });
});
