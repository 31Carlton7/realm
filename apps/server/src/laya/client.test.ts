import { afterEach, describe, expect, it } from "vitest";
import { LayaClient } from "./client";
import { fakeLayaServer, type FakeLaya } from "./test-fakes";

/**
 * The client against a fake laya-serve over real HTTP. What must die: a request without the key, a
 * request that lets the server route to a checkpoint that is not loaded, a timeout that is not one,
 * and a server refusal that loses the server's reason.
 */

let server: FakeLaya | null = null;
afterEach(async () => { await server?.close(); server = null; });

describe("the laya-serve client", () => {
  it("asks /v1/systemone with the key, pinned to the English checkpoint, and returns the answers", async () => {
    server = await fakeLayaServer({ apiKey: "k1" });
    const seen: number[] = [];
    const client = new LayaClient({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "k1", onLatency: (ms) => seen.push(ms) });
    const { answers, ms } = await client.ask("Goal: send it.", {
      target: { type: "choice", instructions: "Which?", criteria: { Send: "button", Cancel: "button" } },
      sensitive: { type: "noul", instructions: "Sensitive?" },
    }, 1_000);
    expect(answers.target).toMatchObject({ type: "choice", choice: "Cancel" });
    expect(answers.sensitive).toMatchObject({ type: "noul", noul: 0.25 });
    expect(server.asked[0]!.auth).toBe("Bearer k1");
    // Named, not routed: a French window title must not send the question to a checkpoint that is
    // neither loaded nor, offline, on disk.
    expect(server.asked[0]!.body.model).toBe("english");
    expect(seen).toEqual([ms]);
  });

  it("keeps a warm-up out of the latency", async () => {
    server = await fakeLayaServer();
    const seen: number[] = [];
    const client = new LayaClient({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "k", onLatency: (ms) => seen.push(ms) });
    await client.ask("warm", { q: { type: "noul", instructions: "?" } }, 1_000, false);
    expect(seen).toEqual([]);
  });

  it("gives up after its timeout, and says so", async () => {
    server = await fakeLayaServer();
    server.hang(true);
    const client = new LayaClient({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "k" });
    const t0 = Date.now();
    await expect(client.ask("x", { q: { type: "noul", instructions: "?" } }, 60)).rejects.toThrow("laya-serve did not answer within 60 ms");
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("takes a budget with a fraction in it, as a clock measured in performance.now() leaves one", async () => {
    // THE BUG: `AbortSignal.timeout(1499.99…)` throws before the question is sent, and Assist — whose
    // budget is what is left of 1 500 ms by performance.now() — heard "no answer" every single time.
    server = await fakeLayaServer();
    const client = new LayaClient({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "k" });
    const { answers } = await client.ask("x", { q: { type: "noul", instructions: "?" } }, 1_499.9985);
    expect(answers.q).toMatchObject({ type: "noul" });
  });

  it("carries the server's own reason when it refuses", async () => {
    server = await fakeLayaServer({ apiKey: "right" });
    const client = new LayaClient({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "wrong" });
    await expect(client.ask("x", { q: { type: "noul", instructions: "?" } }, 1_000)).rejects.toThrow("laya-serve answered 401: invalid or missing bearer token");
  });

  it("reads /health", async () => {
    server = await fakeLayaServer();
    const client = new LayaClient({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "k" });
    expect(await client.health(1_000)).toMatchObject({ loaded: ["english"], device: "mps", checkpoint_devices: { english: "mps" } });
  });
});
