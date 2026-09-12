// The gesture state machine has no DOM or private icon-package dependencies.
export default {
  test: {
    environment: "node",
    include: ["apps/desktop/src/renderer/src/state/gesture.test.ts", "scripts/validate-sidebar.test.ts"],
  },
};
