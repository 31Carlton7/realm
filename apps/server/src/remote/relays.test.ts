import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { PRODUCTION_REMOTE_RELAY, STAGING_REMOTE_RELAY } from "@realm/contracts";
import { readWranglerConfig, relayAddress } from "@realm/relay/scripts/deploy";
import { defaultRelay } from "./relays";

describe("the relay a Mac dials by default", () => {
  it("is production for a released build and staging for a development one", () => {
    expect(defaultRelay({})).toBe(PRODUCTION_REMOTE_RELAY);
    expect(defaultRelay({ ELECTRON_RENDERER_URL: "http://127.0.0.1:5173" })).toBe(STAGING_REMOTE_RELAY);
  });

  it("is REALM_RELAY over either, tidied as a pairing link writes it", () => {
    expect(defaultRelay({ REALM_RELAY: "ws://127.0.0.1:8787/" })).toBe("ws://127.0.0.1:8787");
    expect(defaultRelay({ REALM_RELAY: STAGING_REMOTE_RELAY })).toBe(STAGING_REMOTE_RELAY);
    expect(defaultRelay({ REALM_RELAY: PRODUCTION_REMOTE_RELAY, ELECTRON_RENDERER_URL: "http://127.0.0.1:5173" })).toBe(PRODUCTION_REMOTE_RELAY);
  });

  it("ignores a REALM_RELAY that is not a relay, rather than dialling nowhere", () => {
    expect(defaultRelay({ REALM_RELAY: "https://relay.example" })).toBe(PRODUCTION_REMOTE_RELAY);
    expect(defaultRelay({ REALM_RELAY: "127.0.0.1:8787", ELECTRON_RENDERER_URL: "http://127.0.0.1:5173" })).toBe(STAGING_REMOTE_RELAY);
    expect(defaultRelay({ REALM_RELAY: "" })).toBe(PRODUCTION_REMOTE_RELAY);
  });

  it("names the addresses services/relay deploys to, so a release never dials a relay that is not there", () => {
    const config = readWranglerConfig(readFileSync(createRequire(import.meta.url).resolve("@realm/relay/wrangler.jsonc"), "utf8"));
    expect(relayAddress(config, "production")).toBe(PRODUCTION_REMOTE_RELAY);
    expect(relayAddress(config, "staging")).toBe(STAGING_REMOTE_RELAY);
  });
});
