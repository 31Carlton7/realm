export default {
  test: {
    environment: "node",
    include: [
      "packages/adapters/src/codex/setup.test.ts",
      "packages/adapters/src/codex/codex-adapter.test.ts",
      "apps/server/src/setup/*.test.ts",
      "apps/server/src/store/settings.test.ts",
      "apps/server/src/skills/discovery.test.ts",
      "apps/server/src/skills/service.test.ts",
    ],
  },
};
