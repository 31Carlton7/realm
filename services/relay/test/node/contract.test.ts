import { afterAll, beforeAll, describe, inject } from "vitest";
import { createApnsSender } from "../../src/apns";
import { startLocalRelay, type LocalRelay } from "../../src/node";
import { TEST_APNS } from "../shared/apns";
import { relayContract } from "../shared/contract";
import { connectWs } from "./connect";

let relay: LocalRelay;

beforeAll(async () => {
  relay = await startLocalRelay({ apns: createApnsSender({ ...TEST_APNS, keyP8: inject("apnsKeyP8"), origin: inject("apnsOrigin") }) });
});

afterAll(() => relay.close());

describe("startLocalRelay", () => {
  relayContract(() => ({ connect: (path) => connectWs(relay.url + path), apnsOrigin: inject("apnsOrigin") }));
});
