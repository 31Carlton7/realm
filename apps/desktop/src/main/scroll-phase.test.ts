import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getAppPath: () => "/nonexistent-app" } }));

const { startScrollPhaseStream } = await import("./scroll-phase");

describe("the scroll-phase stream", () => {
  afterEach(() => { delete process.env.REALM_SCROLLPHASE_BIN; });

  /* Mutant: no "error" listener on the child. A missing binary is then an uncaught exception, and in
     Electron main that is a modal crash dialog the whole app waits behind. */
  it.runIf(process.platform === "darwin")("survives a helper that cannot be spawned", async () => {
    process.env.REALM_SCROLLPHASE_BIN = "/nonexistent/scrollphase";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    const stream = startScrollPhaseStream(win as never);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[scrollphase] failed to spawn:", expect.stringContaining("ENOENT")));
    stream.stop();
    warn.mockRestore();
  });
});
