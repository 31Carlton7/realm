/**
 * Live check for passkeys (run with:
 *   apps/desktop/node_modules/.bin/electron apps/desktop/scripts/passkeys-live.cjs)
 *
 * Proves, against the real Electron binary and the REAL browser-pane.ts / passkeys.ts (compiled from
 * src/main at startup), the things a unit test with a fake CDP cannot:
 *
 *   1. A pane reports `isUserVerifyingPlatformAuthenticatorAvailable() === true` on the FIRST paint
 *      of the first page — the literal thing GitHub reads as "partial passkey support" when false.
 *      Checked on github.com itself, because that is where the bug was reported.
 *   2. A real `navigator.credentials.create()` completes and the private key lands in Realm's vault.
 *   3. A pane created FRESH (empty authenticator) can still assert with that passkey — which is only
 *      possible if Realm restored the key from the vault, and is what a relaunch looks like.
 *   4. With the fingerprint refused, the same request fails `NotAllowedError` and the authenticator
 *      is left holding nothing. This is the agent-driving-a-pane case.
 *   5. The authenticator holds NO key material between requests.
 *
 * The user's fingerprint is the one thing stood in for (a scripted run cannot answer Touch ID); the
 * vault, the authenticator, the shim, the CDP ordering and the page are all real.
 *
 * Touches no ports but one on 127.0.0.1, uses a scratch userData dir, and closes itself.
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const repoRoot = path.resolve(__dirname, "../../..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-passkeys-live-"));

function esbuild() {
  const pnpm = path.join(repoRoot, "node_modules/.pnpm");
  for (const d of fs.readdirSync(pnpm)) {
    if (!d.startsWith("esbuild@")) continue;
    try { return require(path.join(pnpm, d, "node_modules/esbuild")); } catch { /* next */ }
  }
  throw new Error("esbuild not found in node_modules/.pnpm");
}
const build = (rel, name) => {
  const outfile = path.join(scratch, name);
  esbuild().buildSync({
    entryPoints: [path.join(repoRoot, rel)],
    bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile,
  });
  return require(outfile);
};
const { createBrowserPane } = build("apps/desktop/src/main/browser-pane.ts", "browser-pane.cjs");
const { PasskeyBroker } = build("apps/desktop/src/main/passkeys.ts", "passkeys.cjs");

const { app, BrowserWindow } = require("electron");
app.setPath("userData", path.join(scratch, "userData")); // never a real profile

const PORT = 7393;
const PAGE = `<!doctype html><meta charset=utf8><title>passkey live</title><body>live check</body>`;
const server = http.createServer((_q, s) => { s.writeHead(200, { "content-type": "text/html" }); s.end(PAGE); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { electron: process.versions.electron, checks: {} };

/** Realm's vault, stood in for: what matters here is that the key leaves the pane and comes back. */
const vault = [];
let presenceGranted = true;
const presenceAsks = [];

const CREATE = `navigator.credentials.create({ publicKey: {
  challenge: crypto.getRandomValues(new Uint8Array(32)),
  rp: { name: "Realm live check", id: "localhost" },
  user: { id: new Uint8Array([7,7,7,7]), name: "ada@example.com", displayName: "Ada Lovelace" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", userVerification: "required" },
  timeout: 15000 }})`;
const GET = `navigator.credentials.get({ publicKey: {
  challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: "localhost",
  userVerification: "required", timeout: 15000 }})`;

app.whenReady().then(async () => {
  try {
    await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
    const win = new BrowserWindow({
      width: 800, height: 560, x: 60, y: 60, show: true,
      title: "Realm passkeys live check (auto-closes)",
      ...(process.platform === "darwin" ? { vibrancy: "sidebar", backgroundColor: "#00000000" } : {}),
    });
    await win.loadURL("data:text/html," + encodeURIComponent(
      `<body style="margin:0;background:#17181a;color:#eee;font:13px sans-serif;padding:10px">Realm passkeys live check</body>`));

    const broker = new PasskeyBroker({
      pageUrl: (id) => pane.pageState(id)?.url ?? null,
      hasPasskeyFor: (rpId) => vault.some((k) => k.rpId === rpId),
      withPasskeysFor: async (rpId, kind, use) => {
        presenceAsks.push(`${kind}:${rpId}`);
        if (kind === "get" && !vault.some((k) => k.rpId === rpId)) return { ok: false, refused: "no_passkey" };
        // Stands in for Touch ID, and ONLY for Touch ID.
        if (!presenceGranted) return { ok: false, refused: "no_presence" };
        await use(vault.filter((k) => k.rpId === rpId));
        return { ok: true };
      },
      recordPasskey: (input) => { vault.push(input); },
      notePasskeyUse: (credentialId, signCount) => {
        const row = vault.find((k) => k.credentialId === credentialId);
        if (row) row.signCount = Math.max(row.signCount, signCount);
      },
      canPromptPresence: () => true,
      notify: (n) => { out.checks.notices = [...(out.checks.notices ?? []), n]; },
      audit: () => {},
      now: () => Date.now(),
    });
    const pane = createBrowserPane(win, (id, cdp) => broker.install(id, cdp));

    /** Open a pane on a URL and hand back a page evaluator over its own CDP. */
    async function openPane(id, url) {
      pane.host.create(id, url, null);
      pane.host.setBounds(id, { x: 20, y: 40, width: 760, height: 500 }, 1, true);
      for (let i = 0; i < 100 && pane.pageState(id)?.url !== url; i++) await sleep(100);
      await sleep(1200); // let the document's own scripts run
      const cdp = pane.attachCdp(id);
      const evaluate = async (expression) => {
        const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) return { error: String(r.exceptionDetails.exception?.description ?? "threw") };
        return r.result.value;
      };
      return { cdp, evaluate };
    }

    /* 1. The reported bug, on the site it was reported against. */
    const gh = await openPane("gh", "https://github.com/login");
    out.checks.github = await gh.evaluate(`(async () => ({
      uvpaa: await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),
      capability: (await PublicKeyCredential.getClientCapabilities()).userVerifyingPlatformAuthenticator,
      shimInstalled: typeof navigator.credentials.get === "function"
        && !/\\[native code\\]/.test(navigator.credentials.get.toString()),
      url: location.origin,
    }))()`);
    pane.host.destroy("gh");

    /* 2. A real registration. */
    const p1 = await openPane("p1", `http://localhost:${PORT}/`);
    out.checks.uvpaaLocal = await p1.evaluate(`PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()`);
    const made = await p1.evaluate(`(async () => { try {
      const c = await ${CREATE};
      return { ok: true, id: c.id, transports: c.response.getTransports() };
    } catch (e) { return { ok: false, err: e.name + ": " + e.message }; } })()`);
    await sleep(400);
    out.checks.create = made;
    out.checks.vaultAfterCreate = vault.map((k) => ({
      rpId: k.rpId, userName: k.userName, signCount: k.signCount,
      privateKeyBytes: Buffer.from(k.privateKey, "base64").length,
    }));

    /* 5. The pane holds NO key material between requests.
       Asked the only way that cannot be fooled: empty the vault and try to sign in the SAME pane
       that just registered. If the authenticator had kept the key, this would succeed. */
    const stashed = vault.splice(0, vault.length);
    const withEmptyVault = await p1.evaluate(`(async () => { try { await ${GET}; return { ok: true }; }
      catch (e) { return { ok: false, err: e.name }; } })()`);
    vault.push(...stashed);
    out.checks.paneHoldsNoKeyBetweenRequests = withEmptyVault;
    pane.host.destroy("p1");

    /* 3. A FRESH pane — empty authenticator — asserting from the vault. */
    const p2 = await openPane("p2", `http://localhost:${PORT}/`);
    const got = await p2.evaluate(`(async () => { try {
      const c = await ${GET};
      return { ok: true, id: c.id, signatureBytes: c.response.signature.byteLength, userHandle: !!c.response.userHandle };
    } catch (e) { return { ok: false, err: e.name }; } })()`);
    await sleep(400);
    out.checks.assertFromVault = got;
    out.checks.sameCredential = got.ok === true && made.ok === true && got.id === made.id;
    out.checks.signCountWrittenBack = vault[0]?.signCount ?? null;

    /* 4. The fingerprint refused — the agent-driving-a-pane case. */
    presenceGranted = false;
    const refused = await p2.evaluate(`(async () => { try { await ${GET}; return { ok: true }; }
      catch (e) { return { ok: false, err: e.name }; } })()`);
    out.checks.refusedWithoutPresence = refused;
    pane.host.destroy("p2");

    out.checks.presenceAsks = presenceAsks;
    out.ok = out.checks.github?.uvpaa === true
      && withEmptyVault.ok === false
      && made.ok === true
      && got.ok === true
      && out.checks.sameCredential === true
      && refused.ok === false && refused.err === "NotAllowedError";
    console.log("LIVE " + JSON.stringify(out, null, 2));
  } catch (e) {
    console.log("LIVE " + JSON.stringify({ ...out, error: String(e && e.stack || e) }, null, 2));
  } finally {
    setTimeout(() => app.exit(0), 300);
  }
});
