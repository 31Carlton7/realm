import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StdioJsonRpc } from "./jsonrpc/stdio";
import { endProbes, execProbe } from "./probe-children";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (done: () => boolean, ms: number) => {
  const by = Date.now() + ms;
  while (!done() && Date.now() < by) await new Promise((r) => setTimeout(r, 20));
};

// A shell that ignores its closed stdin and has started a child of its own, as an npm shim starts the
// binary it wraps, writing both pids to `marker`.
const script = (marker: string) => `sleep 60 & echo "$$ $!" > ${marker}; wait`;

describe.skipIf(process.platform === "win32")("endProbes", () => {
  let dir = "";
  let pids: number[] = [];
  afterEach(() => {
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    pids = [];
    rmSync(dir, { recursive: true, force: true });
  });
  const started = async (marker: string) => {
    await until(() => existsSync(marker) && readFileSync(marker, "utf8").includes("\n"), 5_000);
    pids = readFileSync(marker, "utf8").trim().split(" ").map(Number);
    expect(pids.map(alive)).toEqual([true, true]);
  };

  it("kills a probe's JSON-RPC child and what it started, with nobody disposing it", async () => {
    // MUTANT: drop the group kill from what `probe` registers and the child's child lives on: a quit
    // exits before the probe's own dispose would have ended the group.
    dir = mkdtempSync(join(tmpdir(), "realm-probe-"));
    const marker = join(dir, "pids");
    const exits: boolean[] = [];
    new StdioJsonRpc({
      command: "/bin/sh", args: ["-c", script(marker)], cwd: dir, ownGroup: true, probe: true,
      onNotification: () => {}, onServerRequest: () => {}, onExit: ({ disposed }) => exits.push(disposed),
    });
    await started(marker);
    endProbes();
    await until(() => !pids.some(alive), 1_000);
    expect(pids.map(alive)).toEqual([false, false]);
    expect(exits).toEqual([true]);
  });

  it("kills a probe's execFile child and what it started", async () => {
    // MUTANT: run it in the caller's group and kill only the shell, and the child's child lives on.
    dir = mkdtempSync(join(tmpdir(), "realm-probe-"));
    const marker = join(dir, "pids");
    const run = execProbe("/bin/sh", ["-c", script(marker)], { timeout: 30_000 });
    await started(marker);
    endProbes();
    await expect(run).rejects.toMatchObject({ signal: "SIGKILL" });
    await until(() => !pids.some(alive), 1_000);
    expect(pids.map(alive)).toEqual([false, false]);
  });

  it("leaves a JSON-RPC child that is not a probe alone", async () => {
    dir = mkdtempSync(join(tmpdir(), "realm-probe-"));
    const marker = join(dir, "pids");
    const rpc = new StdioJsonRpc({
      command: "/bin/sh", args: ["-c", script(marker)], cwd: dir, ownGroup: true,
      onNotification: () => {}, onServerRequest: () => {}, onExit: () => {},
    });
    await started(marker);
    endProbes();
    await new Promise((r) => setTimeout(r, 200));
    expect(pids.map(alive)).toEqual([true, true]);
    await rpc.dispose();
  });
});
