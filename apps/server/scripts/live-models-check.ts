/**
 * Live check of the model-catalog pipeline against the REAL agent CLIs.
 *
 *   pnpm --filter @realm/server exec tsx scripts/live-models-check.ts
 *
 * Proves, against the real binaries, the three claims the unit fixtures can only mimic:
 *
 *   1. Codex answers app-server `model/list` and the probe surfaces that catalog (or, on a build
 *      without the method, degrades to `models: null` — either verdict is printed).
 *   2. Cursor's ACP `session/new` reports `availableModels` and the probe surfaces it — including
 *      `default[]`, the id "Auto" actually travels as (the literal `auto` is rejected on this wire).
 *   3. A session started with a PICKED non-default model transmits it: `session/set_model` is
 *      accepted at boot, the init event reports the pinned id, and a one-word identity prompt comes
 *      back from the pinned vendor's model, not the default Composer.
 *
 * Exits non-zero if any check fails. Requires `codex` and `cursor-agent` installed and logged in.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@realm/contracts";
import { AcpAdapter, CodexAdapter } from "@realm/adapters";

const TURN_TIMEOUT_MS = 120_000; // cursor-agent can sit ~60s before its first chunk (see live-agent-check)

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
};

async function main() {
  console.log("== codex model/list ==");
  const codex = new CodexAdapter();
  const codexProbe = await codex.probe();
  ok("codex probes available", codexProbe.available, codexProbe.reason ?? "");
  if (codexProbe.models === null || codexProbe.models === undefined) {
    ok("codex model/list degraded to null (build without the method?)", !codex.modelListEnumerable,
      "models: null with modelListEnumerable still true means enumeration failed for another reason");
  } else {
    ok("codex catalog is non-empty", codexProbe.models.length > 0);
    for (const m of codexProbe.models) console.log(`    ${m.id}  (${m.label})`);
  }

  console.log("== cursor availableModels ==");
  const cursor = new AcpAdapter({
    kind: "acp:cursor", bin: process.env.REALM_CURSOR_BIN ?? "cursor-agent", args: ["acp"],
    label: "Cursor", loginHint: "Run `cursor-agent login`.", modelCatalog: true,
  });
  const cursorProbe = await cursor.probe();
  ok("cursor probes available", cursorProbe.available, cursorProbe.reason ?? "");
  const models = cursorProbe.models ?? [];
  ok("cursor catalog is non-empty", models.length > 0);
  ok("Auto travels as its real id, default[]", models.some((m) => m.id === "default[]" && m.label === "Auto"));
  ok("no literal \"auto\" id is ever offered", !models.some((m) => m.id === "auto"));
  console.log(`    ${models.length} models; first five: ${models.slice(0, 5).map((m) => m.id).join(", ")}`);

  // A model that is not Cursor's default AND whose vendor a one-word identity answer can separate
  // from Composer. Cheapest family first: premium ids can bounce off plan limits ("Upgrade your plan"),
  // which proves routing but fails the turn.
  const families: [prefix: string, vendor: RegExp][] = [
    ["gemini-", /google|gemini/i], ["gpt-", /openai|gpt/i], ["claude-", /anthropic|claude/i],
  ];
  const family = families.find(([prefix]) => models.some((m) => m.id.startsWith(prefix)));
  const picked = family ? models.find((m) => m.id.startsWith(family[0])) : undefined;
  const vendor = family?.[1] ?? /anthropic|openai|google/i;
  console.log(`== cursor session with picked model ${picked?.id ?? "(none found)"} ==`);
  ok("catalog offers a non-Composer vendor id to pin", picked !== undefined);
  /** One session, one prompt, drained to idle. */
  const runTurn = async (model: string | null) => {
    const cwd = mkdtempSync(join(tmpdir(), "realm-live-models-"));
    const logs: string[] = [];
    const handle = cursor.start({ cwd, mcpServers: [], model, onLog: (l) => logs.push(l) });
    const evs: SessionEvent[] = [];
    const drained = (async () => { for await (const e of handle.events) evs.push(e); })();
    try {
      await handle.send({ text: "In one word, which company created the model answering this? Answer with only that word.", attachments: [] });
      const deadline = Date.now() + TURN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const last = evs.filter((e) => e.type === "status").at(-1)?.payload.status;
        if ((last === "idle" && evs.some((e) => e.type === "assistant_text")) || last === "error" || last === "ended") break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const init = evs.find((e) => e.type === "init");
      return {
        initModel: init?.type === "init" ? init.payload.model : null,
        setModelRefused: logs.some((l) => l.includes("session/set_model") && l.includes("failed")),
        errors: evs.filter((e) => e.type === "error").map((e) => e.payload.message),
        text: evs.filter((e) => e.type === "assistant_text").map((e) => e.payload.text).join(""),
      };
    } finally {
      await handle.dispose();
      await drained.catch(() => {});
      rmSync(cwd, { recursive: true, force: true });
    }
  };

  if (picked) {
    // Control first: the SAME prompt on the adapter default (Composer). If the pinned leg then either
    // names the pinned vendor or bounces off the per-model plan gate that the control sailed past,
    // the pin demonstrably changed the routing.
    const control = await runTurn(null);
    ok("control (unpinned) turn answers", control.errors.length === 0 && control.text.trim() !== "", control.text.trim().slice(0, 80));
    const pinned = await runTurn(picked.id);
    ok("init reports the pinned model", pinned.initModel === picked.id, String(pinned.initModel));
    ok("boot-time session/set_model was not refused", !pinned.setModelRefused);
    ok("pinned turn produced no errors", pinned.errors.length === 0, pinned.errors.join(" | "));
    if (/upgrade your plan/i.test(control.text)) {
      // The ACCOUNT is out of quota: even Composer is refused, so no answer can name a vendor and the
      // plan gate proves nothing about routing. The wire-level acceptance above (set_model took a
      // catalog id; the probe path shows it rejects non-catalog ids with Invalid params) is the proof
      // this leg still carries. SKIP, honestly, rather than a fake PASS or a misleading FAIL.
      console.log("  SKIP  vendor-identity check — the account is plan-gated for every model (control also refused)");
    } else {
      const gated = /upgrade your plan/i.test(pinned.text);
      ok("the pinned model (not Composer) handled the request",
        vendor.test(pinned.text) || gated,
        gated ? `plan-gated at the pinned model while the control answered — answer: ${pinned.text.trim().slice(0, 80)}`
              : `answer: ${pinned.text.trim().slice(0, 120)}`);
    }
  }

  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
