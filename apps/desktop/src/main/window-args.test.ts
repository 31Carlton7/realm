// @vitest-environment node
import { describe, expect, it } from "vitest";
import { windowArguments } from "./window-args";

describe("windowArguments", () => {
  const info = { port: 8788, home: "/Users/me/Realm", token: "tok-SECRET", profileId: "p1", spaceId: "s1", land: "s2" };

  it("never puts the RPC token on the renderer's command line, which `ps` shows to every process", () => {
    const args = windowArguments(info);
    expect(args.some((a) => a.startsWith("--realm-token"))).toBe(false);
    expect(args.join(" ")).not.toContain("tok-SECRET");
  });

  it("still tells the renderer where the server is and which window it is", () => {
    expect(windowArguments(info)).toEqual(expect.arrayContaining([
      "--realm-port=8788", "--realm-home=/Users/me/Realm", "--realm-profile=p1", "--realm-space=s1", "--realm-land=s2",
    ]));
  });
});
