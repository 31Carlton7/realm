#!/usr/bin/env node
// Fixture CLI for probe.test.ts. Behavior is driven by argv/env so tests can exercise every branch
// of probeCodex without touching the real `codex` binary.
const args = process.argv.slice(2);

if (args[0] === "--version") {
  if (process.env.FAKE_CODEX_EMPTY_VERSION) {
    process.stdout.write("\n");
  } else {
    process.stdout.write("codex-cli 1.2.3\n");
  }
  process.exit(0);
}

if (args[0] === "login" && args[1] === "status") {
  const mode = process.env.FAKE_CODEX_LOGIN ?? "ok";
  if (mode === "ok") {
    process.stdout.write("Logged in using ChatGPT\n");
    process.exit(0);
  }
  if (mode === "logged-out") {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  if (mode === "other-error") {
    process.stderr.write("Error loading configuration: bogus\n");
    process.exit(1);
  }
}

process.stderr.write(`fake-codex: unhandled args ${JSON.stringify(args)}\n`);
process.exit(1);
