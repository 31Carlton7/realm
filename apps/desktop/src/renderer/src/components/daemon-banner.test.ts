import { describe, expect, it } from "vitest";
import { bannerFor } from "./daemon-banner";

describe("bannerFor", () => {
  it("says nothing when there is nothing wrong", () => {
    expect(bannerFor({ connectionDown: false, daemon: null })).toBeNull();
    expect(bannerFor({ connectionDown: false, daemon: { kind: "connected" } })).toBeNull();
  });

  it("keeps the old line for an ordinary drop, Retry and all", () => {
    expect(bannerFor({ connectionDown: true, daemon: null })).toEqual({
      text: "Connection lost — reconnecting…", action: "retry", tone: "waiting",
    });
  });

  it("stops promising a reconnection that is not coming", () => {
    // MUTANT: leave this on the generic line and a server that has crashed five times in two minutes
    // still says "reconnecting…", which is a lie told once every two seconds.
    const b = bannerFor({ connectionDown: true, daemon: { kind: "failed", logPath: "/tmp/realm/logs/server.log" } })!;
    expect(b.text).toContain("keeps failing to start");
    expect(b.text).toContain("/tmp/realm/logs/server.log");
    expect(b.action).toBeNull();
  });

  it("names a restart in progress, because that is a different wait", () => {
    expect(bannerFor({ connectionDown: true, daemon: { kind: "restarting", attempt: 2 } })!.text)
      .toBe("The agent server stopped — restarting it…");
  });

  it("says a stale server is stale even while perfectly connected", () => {
    // The one state that is not about the socket at all: everything works, against the wrong build.
    const b = bannerFor({ connectionDown: false, daemon: { kind: "stale", why: "bundle" } })!;
    expect(b.text).toContain("previous version");
    expect(b.action).toBe("quit-and-stop");
  });

  it("prefers what main knows over what the socket can guess", () => {
    // A failed server and a dropped socket are the same thing from the renderer's side; only main can
    // tell them apart, so its answer wins.
    expect(bannerFor({ connectionDown: true, daemon: { kind: "failed" } })!.action).toBeNull();
  });
});
