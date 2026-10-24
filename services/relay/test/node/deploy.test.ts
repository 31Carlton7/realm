import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apnsKeyId, missingSecrets, parseDeployArgs, readWranglerConfig, relayAddress, secretsFileText } from "../../scripts/deploy";

const config = readWranglerConfig(readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8"));
const P8 = "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----\n";

describe("the relay's environments, as wrangler.jsonc has them", () => {
  it("puts staging and production at the addresses Realm dials, and the top level nowhere", () => {
    expect(relayAddress(config, "staging")).toBe("wss://realm-relay-staging.realm-relay.workers.dev");
    expect(relayAddress(config, "production")).toBe("wss://realm-relay.realm-relay.workers.dev");
    // A bare `wrangler deploy` uses the top level: it must not be either relay, nor reachable.
    expect(config.name).not.toMatch(/^realm-relay(-staging)?$/);
    expect(config.workers_dev).toBe(false);
  });

  it("gives each deployed environment the Durable Object, its migration, the APNs vars and the secrets it needs", () => {
    const envs = config.env as Record<string, Record<string, unknown>>;
    for (const name of ["staging", "production"]) {
      const env = envs[name]!;
      expect(env.durable_objects, name).toEqual(config.durable_objects);
      expect(env.migrations, name).toEqual(config.migrations);
      expect(env.vars, name).toEqual({ APNS_TEAM_ID: "FY9QB79VAP", APNS_TOPIC: "co.charmtechnologies.realm.ios" });
      expect(env.secrets, name).toEqual({ required: ["APNS_KEY_ID", "APNS_KEY_P8"] });
      expect(env.preview_urls, name).toBe(false);
    }
  });

  it("follows a custom domain once production has one", () => {
    const moved = structuredClone(config) as { env: Record<string, Record<string, unknown>> };
    moved.env.production!.routes = [{ pattern: "relay.realm.computer", custom_domain: true }];
    expect(relayAddress(moved, "production")).toBe("wss://relay.realm.computer");
    moved.env.production!.routes = [];
    moved.env.production!.workers_dev = false;
    expect(() => relayAddress(moved, "production")).toThrow(/neither a custom domain nor a workers.dev address/);
  });
});

describe("parseDeployArgs", () => {
  it("names the environment first, and defaults to everything: tests, deploy, smoke test", () => {
    expect(parseDeployArgs(["production"])).toEqual({ environment: "production", dryRun: false, apnsKey: null, apnsKeyId: null, skipTests: false, skipSmoke: false });
    expect(parseDeployArgs(["staging", "--dry-run", "--skip-tests", "--skip-smoke", "--apns-key", "/k/AuthKey_ABCDE12345.p8", "--apns-key-id", "ABCDE12345"])).toEqual({
      environment: "staging", dryRun: true, apnsKey: "/k/AuthKey_ABCDE12345.p8", apnsKeyId: "ABCDE12345", skipTests: true, skipSmoke: true,
    });
  });

  it("refuses no environment, an unknown one, a flag without its value, and an id with no key", () => {
    expect(() => parseDeployArgs([])).toThrow(/name the environment first/);
    expect(() => parseDeployArgs(["prod"])).toThrow(/name the environment first/);
    expect(() => parseDeployArgs(["production", "--apns-key"])).toThrow(/--apns-key needs a value/);
    expect(() => parseDeployArgs(["production", "--apns-key", "--dry-run"])).toThrow(/--apns-key needs a value/);
    expect(() => parseDeployArgs(["production", "--apns-key-id", "ABCDE12345"])).toThrow(/needs --apns-key/);
    expect(() => parseDeployArgs(["production", "--force"])).toThrow(/unknown flag --force/);
  });
});

describe("the APNs secrets", () => {
  it("reads the key's id from Apple's name for the download, or takes it given", () => {
    expect(apnsKeyId("/Users/me/Downloads/AuthKey_8T2V7PX968.p8", null)).toBe("8T2V7PX968");
    expect(apnsKeyId("/Users/me/apns.p8", "8T2V7PX968")).toBe("8T2V7PX968");
    expect(() => apnsKeyId("/Users/me/apns.p8", null)).toThrow(/pass the key's id with --apns-key-id/);
    expect(() => apnsKeyId("/Users/me/apns.p8", "short")).toThrow(/is not an APNs key id/);
  });

  it("writes the secrets file as JSON, the .p8's newlines intact, and refuses a file that is not a key", () => {
    expect(JSON.parse(secretsFileText("8T2V7PX968", P8))).toEqual({ APNS_KEY_ID: "8T2V7PX968", APNS_KEY_P8: P8.trim() });
    expect(() => secretsFileText("8T2V7PX968", "not a key")).toThrow(/not a \.p8 private key/);
  });

  it("names the required secrets a Worker lacks", () => {
    expect(missingSecrets('[{"name":"APNS_KEY_ID","type":"secret_text"},{"name":"APNS_KEY_P8","type":"secret_text"}]')).toEqual([]);
    expect(missingSecrets('[{"name":"APNS_KEY_ID","type":"secret_text"}]')).toEqual(["APNS_KEY_P8"]);
    expect(missingSecrets("[]")).toEqual(["APNS_KEY_ID", "APNS_KEY_P8"]);
  });
});
