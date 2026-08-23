import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    name: "adapters",
    environment: "node",
    // Every assertion here is gated on a real child process, and the local `waitFor` helpers in these files
    // poll for up to 10s. vitest's 5s default would cut those short, so a genuine hang would be reported as a
    // bare test timeout instead of the assertion that never came true.
    testTimeout: 20_000,
  },
});
