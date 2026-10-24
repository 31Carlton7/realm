/**
 * `pnpm deploy:staging` and `pnpm deploy:production`, from services/relay: the relay to Cloudflare, in
 * order —
 *   1. the relay's own tests, in workerd and in Node;
 *   2. `wrangler deploy --dry-run` for the environment, which bundles the Worker and checks its config;
 *   3. the APNs secrets: already on the Worker (`wrangler secret list`), or handed over with this deploy
 *      by --apns-key, which a Worker's first deploy needs — it cannot be given secrets before it exists;
 *   4. `wrangler deploy --env <environment>`;
 *   5. scripts/smoke.ts against the address phones will use, once it answers.
 *
 * Flags: --dry-run           stop after step 2, and print what would run after it
 *        --apns-key <file>   the APNs key's .p8; its id is read from Apple's name for it, AuthKey_<id>.p8
 *        --apns-key-id <id>  the key's id, for a .p8 named otherwise
 *        --skip-tests        leave out step 1
 *        --skip-smoke        leave out step 5
 *
 * Wrangler runs with IPv4 first: on a network whose IPv6 goes nowhere, Node's requests otherwise time out.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export type Environment = "staging" | "production";

export type DeployArgs = {
  environment: Environment;
  dryRun: boolean;
  apnsKey: string | null;
  apnsKeyId: string | null;
  skipTests: boolean;
  skipSmoke: boolean;
};

/** The Cloudflare account's workers.dev subdomain: realm-relay-staging.realm-relay.workers.dev. */
export const WORKERS_DEV_SUBDOMAIN = "realm-relay";

/** What durable.ts reads from `wrangler secret put`, and wrangler.jsonc's `secrets.required`. */
export const REQUIRED_SECRETS = ["APNS_KEY_ID", "APNS_KEY_P8"] as const;

const USAGE = "deploy.ts <staging|production> [--dry-run] [--apns-key <AuthKey_ID.p8>] [--apns-key-id <id>] [--skip-tests] [--skip-smoke]";

// ---------- pure logic (tested in test/node/deploy.test.ts) ----------

export function parseDeployArgs(argv: string[]): DeployArgs {
  const [environment, ...rest] = argv;
  if (environment !== "staging" && environment !== "production") throw new Error(`name the environment first: ${USAGE}`);
  const out: DeployArgs = { environment, dryRun: false, apnsKey: null, apnsKeyId: null, skipTests: false, skipSmoke: false };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--dry-run") out.dryRun = true;
    else if (flag === "--skip-tests") out.skipTests = true;
    else if (flag === "--skip-smoke") out.skipSmoke = true;
    else if (flag === "--apns-key" || flag === "--apns-key-id") {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      if (flag === "--apns-key") out.apnsKey = value;
      else out.apnsKeyId = value;
    } else {
      throw new Error(`unknown flag ${flag}: ${USAGE}`);
    }
  }
  if (out.apnsKeyId && !out.apnsKey) throw new Error("--apns-key-id names the id of the key --apns-key hands over, so it needs --apns-key");
  return out;
}

/** wrangler.jsonc, comments and all, as JSON. */
export function readWranglerConfig(text: string): Record<string, unknown> {
  const { config, error } = ts.parseConfigFileTextToJson("wrangler.jsonc", text);
  if (error || typeof config !== "object" || config === null) throw new Error("wrangler.jsonc does not parse");
  return config as Record<string, unknown>;
}

/** The address phones dial for an environment: its custom domain once it has one, else workers.dev. */
export function relayAddress(config: Record<string, unknown>, environment: Environment): string {
  const env = (config.env as Record<string, Record<string, unknown>> | undefined)?.[environment];
  if (!env || typeof env.name !== "string") throw new Error(`wrangler.jsonc has no ${environment} environment with a name`);
  const routes = Array.isArray(env.routes) ? (env.routes as Array<{ pattern?: unknown; custom_domain?: unknown }>) : [];
  const domain = routes.find((r) => r.custom_domain === true && typeof r.pattern === "string");
  if (domain) return `wss://${domain.pattern as string}`;
  if (env.workers_dev !== true) throw new Error(`the ${environment} environment has neither a custom domain nor a workers.dev address`);
  return `wss://${env.name}.${WORKERS_DEV_SUBDOMAIN}.workers.dev`;
}

/** The key's id, from `--apns-key-id` or from the name Apple gives the download: AuthKey_<id>.p8. */
export function apnsKeyId(path: string, given: string | null): string {
  const id = given ?? /^AuthKey_([A-Z0-9]{10})\.p8$/.exec(basename(path))?.[1];
  if (!id) throw new Error(`${basename(path)} is not named AuthKey_<id>.p8, so pass the key's id with --apns-key-id`);
  if (!/^[A-Z0-9]{10}$/.test(id)) throw new Error(`${id} is not an APNs key id (ten letters and digits)`);
  return id;
}

/** The file `wrangler deploy --secrets-file` reads, as JSON: the newlines of the .p8 survive it. */
export function secretsFileText(keyId: string, p8: string): string {
  if (!/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(p8)) throw new Error("the --apns-key file is not a .p8 private key");
  return JSON.stringify({ APNS_KEY_ID: keyId, APNS_KEY_P8: p8.trim() });
}

/** Which required secrets `wrangler secret list --format json` does not list. */
export function missingSecrets(listJson: string): string[] {
  const listed = new Set((JSON.parse(listJson) as Array<{ name?: unknown }>).map((s) => s.name));
  return REQUIRED_SECRETS.filter((name) => !listed.has(name));
}

// ---------- the run ----------

const relayDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(relayDir, "node_modules/.bin/wrangler");
const childEnv = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, "--dns-result-order=ipv4first"].filter(Boolean).join(" ") };

const shown = (cmd: string, args: string[]): string => [cmd, ...args].map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" ");

function run(title: string, cmd: string, args: string[]): Promise<void> {
  console.log(`\n▸ ${title}\n  ${shown(cmd, args)}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: relayDir, env: childEnv, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${title} failed (exit ${code})`))));
  });
}

/** `wrangler secret list`: the missing secrets, or null when the Worker does not exist yet. */
function secretsOnWorker(environment: Environment): string[] | null {
  const args = ["secret", "list", "--env", environment, "--format", "json"];
  console.log(`\n▸ Check the APNs secrets on the Worker\n  ${shown("wrangler", args)}`);
  const listed = spawnSync(wrangler, args, { cwd: relayDir, env: childEnv, encoding: "utf8" });
  if (listed.status === 0) return missingSecrets(listed.stdout.slice(listed.stdout.indexOf("[")));
  if (/not found/i.test(`${listed.stdout}${listed.stderr}`)) return null;
  throw new Error(`wrangler secret list failed:\n${listed.stderr || listed.stdout}`);
}

async function answersHealth(address: string, timeoutMs: number): Promise<boolean> {
  const url = `${address.replace(/^ws/, "http")}/health`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (res.status === 200 && (await res.text()) === "ok") return true;
    } catch {
      // Not answering yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

async function main(): Promise<void> {
  const args = parseDeployArgs(process.argv.slice(2));
  const config = readWranglerConfig(readFileSync(join(relayDir, "wrangler.jsonc"), "utf8"));
  const address = relayAddress(config, args.environment);
  const name = (config.env as Record<string, { name: string }>)[args.environment]!.name;
  console.log(`The relay's ${args.environment} environment: Worker ${name}, which phones reach at ${address}`);

  // Read and checked before anything runs, so a wrong path or name fails the dry run too.
  let key: { id: string; secrets: string } | null = null;
  if (args.apnsKey) {
    const id = apnsKeyId(args.apnsKey, args.apnsKeyId);
    key = { id, secrets: secretsFileText(id, readFileSync(args.apnsKey, "utf8")) };
    console.log(`The APNs key ${id} goes up with this deploy, from ${args.apnsKey}.`);
  }

  if (!args.skipTests) await run("Test the relay", "pnpm", ["test"]);
  await run("Bundle and check the config", wrangler, ["deploy", "--env", args.environment, "--dry-run"]);

  if (args.dryRun) {
    console.log(`\n--dry-run: stopping here. The deploy would go on with:`);
    if (!key) console.log(`  wrangler ${["secret", "list", "--env", args.environment, "--format", "json"].join(" ")}`);
    console.log(`  wrangler ${shown("deploy", ["--env", args.environment, ...(key ? ["--secrets-file", "<APNS_KEY_ID and APNS_KEY_P8, in a 0600 file removed after>"] : [])])}`);
    if (!args.skipSmoke) console.log(`  node --experimental-strip-types scripts/smoke.ts ${address}`);
    return;
  }

  let scratch: string | null = null;
  try {
    const deploy = ["deploy", "--env", args.environment];
    if (key) {
      scratch = mkdtempSync(join(tmpdir(), "realm-relay-secrets-"));
      const file = join(scratch, "secrets.json");
      writeFileSync(file, key.secrets, { mode: 0o600 });
      chmodSync(file, 0o600);
      deploy.push("--secrets-file", file);
    } else {
      const missing = secretsOnWorker(args.environment);
      if (missing === null) {
        throw new Error(`Worker ${name} does not exist yet, so it cannot have its APNs secrets. Deploy it with them: --apns-key <AuthKey_ID.p8>`);
      }
      if (missing.length > 0) {
        throw new Error(`Worker ${name} has no ${missing.join(" or ")}. Pass --apns-key <AuthKey_ID.p8>, or set them with wrangler secret put <name> --env ${args.environment}`);
      }
    }
    await run(`Deploy to ${args.environment}`, wrangler, deploy);
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }

  if (args.skipSmoke) return console.log(`\n--skip-smoke: ${address} is deployed and not checked.`);
  console.log(`\n▸ Wait for ${address} to answer`);
  if (!(await answersHealth(address, 90_000))) throw new Error(`${address}/health did not answer within 90 s of the deploy`);
  await run("Smoke-test the deployed relay", process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/smoke.ts", address]);
  console.log(`\nThe ${args.environment} relay is deployed at ${address} and passed its smoke test.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: Error) => {
    console.error(`\ndeploy: ${e.message}`);
    process.exit(1);
  });
}
