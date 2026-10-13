// @vitest-environment node
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComputerUseHelper, probeGrantsOnce } from "./computer-use-helper";

/**
 * A scripted stand-in for `axhelper`, speaking its newline-delimited JSON. Like the real one it reads
 * trust ONCE, at launch, and keeps it for its lifetime — the cache that made Realm report a stale
 * answer after the user switched it on. Trust comes from a file the test writes, which stands in for
 * the switch in System Settings (the real grant cannot be flipped from here).
 */
const FAKE_HELPER = `
const fs = require("node:fs");
const dir = process.argv[2];
const read = (name) => { try { return fs.readFileSync(dir + "/" + name, "utf8").trim() === "1"; } catch { return false; } };
const trust = { accessibility: read("accessibility"), screenRecording: read("screenRecording") };
fs.appendFileSync(dir + "/spawns", "x");
process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    const { id, method } = JSON.parse(line);
    if (method === "ping") process.stdout.write(JSON.stringify({ id, result: trust }) + "\\n");
    else if (method === "snapshot" && !trust.accessibility)
      process.stdout.write(JSON.stringify({ id, error: { message: "Realm is not a trusted accessibility client", code: "no_accessibility" } }) + "\\n");
    else process.stdout.write(JSON.stringify({ id, result: { ok: true } }) + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`;

let dir: string;
let bin: string;
const setTrust = (name: "accessibility" | "screenRecording", on: boolean) => writeFileSync(join(dir, name), on ? "1" : "0");
const spawns = (): number => { try { return readFileSync(join(dir, "spawns"), "utf8").length; } catch { return 0; } };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "realm-axhelper-"));
  writeFileSync(join(dir, "helper.cjs"), FAKE_HELPER);
  bin = join(dir, "axhelper");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "helper.cjs")}" "${dir}"\n`);
  chmodSync(bin, 0o755);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("the helper bridge against a scripted helper", () => {
  it("a running helper keeps the trust it saw at launch — the cache this work routes around", async () => {
    const helper = new ComputerUseHelper({ helperPath: () => bin });
    try {
      setTrust("accessibility", false);
      expect(await helper.request("ping")).toMatchObject({ accessibility: false });
      setTrust("accessibility", true);
      expect(await helper.request("ping")).toMatchObject({ accessibility: false });
    } finally { helper.stop(); }
  });

  it("probeGrantsOnce reads from a fresh helper each time, so it sees the switch flip", async () => {
    setTrust("accessibility", false);
    expect(await probeGrantsOnce(() => bin)).toEqual({ accessibility: false, screenRecording: false });
    setTrust("accessibility", true);
    setTrust("screenRecording", true);
    expect(await probeGrantsOnce(() => bin)).toEqual({ accessibility: true, screenRecording: true });
    expect(spawns()).toBe(2);
  });

  it("retries a refusal from a helper started before the grant, once, in a fresh helper", async () => {
    const helper = new ComputerUseHelper({ helperPath: () => bin });
    try {
      setTrust("accessibility", false);
      await helper.request("ping");
      setTrust("accessibility", true);
      // The running helper still believes it is untrusted; the call lands in a new one that knows better.
      expect(await helper.request("snapshot", { app: "com.apple.TextEdit" })).toEqual({ ok: true });
      expect(spawns()).toBe(2);
    } finally { helper.stop(); }
  });

  it("does not retry a fresh helper's refusal — that one is the real answer", async () => {
    const helper = new ComputerUseHelper({ helperPath: () => bin });
    try {
      setTrust("accessibility", false);
      await expect(helper.request("snapshot", {})).rejects.toMatchObject({ cause: "no_accessibility" });
      expect(spawns()).toBe(1);
      // And a stale running helper whose fresh replacement also refuses gives up after one retry.
      await expect(helper.request("snapshot", {})).rejects.toMatchObject({ cause: "no_accessibility" });
      expect(spawns()).toBe(2);
    } finally { helper.stop(); }
  });
});
