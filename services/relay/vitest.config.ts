import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { TEST_APNS } from "./test/shared/apns";

export default defineConfig({
  test: {
    projects: [
      {
        // The real Worker and Durable Object, inside workerd, driven through SELF.fetch.
        plugins: [
          cloudflareTest(({ inject }) => ({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: { APNS_ORIGIN: inject("apnsOrigin"), APNS_KEY_ID: TEST_APNS.keyId, APNS_KEY_P8: inject("apnsKeyP8") },
            },
          })),
        ],
        test: {
          name: "worker",
          include: ["test/worker/**/*.test.ts"],
          globalSetup: ["test/node/fake-apns-setup.ts"],
        },
      },
      {
        // startLocalRelay, the same rules on a Node `ws` server, as the Mac-side tests will use it.
        test: {
          name: "node",
          include: ["test/node/**/*.test.ts"],
          environment: "node",
          globalSetup: ["test/node/fake-apns-setup.ts"],
        },
      },
    ],
  },
});
