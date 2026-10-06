/**
 * Plan 28 — the protocol's crypto under the runtime that ships it.
 *
 * realm-server runs on Electron's Node (ELECTRON_RUN_AS_NODE), whose BoringSSL is not the suite's
 * OpenSSL: ChaCha20-Poly1305 exists in one and not the other, which is why PROTOCOL.md uses AES-GCM.
 * The suite can only ever prove the protocol on the Node it runs on, so this replays every published
 * vector and every cross fixture inside Electron itself.
 *
 * Run from apps/server:
 *   ELECTRON_RUN_AS_NODE=1 "$(node -p 'require("electron")')" --import tsx scripts/mobile-crypto-electron-live.ts
 * (the npm `electron` module's export is the binary's path). `pnpm exec tsx` runs the same file on Node,
 * as the control. Measured 2026-10-05: both pass on Electron 37.10.3 (Node 22.21.1) and Node 22.23.2.
 */
import { readFileSync } from "node:fs";
import { b64u, deviceId, ed25519Generate, ed25519Sign, ed25519Verify, generateDeviceKeys, HandshakeState, PROLOGUE, x25519 } from "@realm/remote";
import { finish, ok } from "./harness";
import { runVector, type Vector } from "../../../packages/remote/test/vectors";

const runtime = process.versions.electron ? `Electron ${process.versions.electron} (Node ${process.versions.node})` : `Node ${process.versions.node}`;
console.log(`runtime: ${runtime}`);

const load = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as { vectors: Vector[] };
for (const [label, file] of [["published", "../../../packages/remote/test/noise-vectors.json"], ["TypeScript fixtures", "../../../packages/remote/test/fixtures/ts-vectors.json"]] as const) {
  const { vectors } = load(file);
  const failures = vectors.map((v) => [v.protocol_name, runVector(v)] as const).filter(([, err]) => err !== null);
  ok(`${label} vectors replay byte for byte (${vectors.length})`, failures.length === 0, failures.length ? JSON.stringify(failures) : "");
}

const sign = ed25519Generate();
const msg = Buffer.from("realm-relay/1\nmac\nid\n\nnonce");
ok("Ed25519 signs and verifies", ed25519Verify(sign.pub, msg, ed25519Sign(sign.priv, msg)));
ok("device ids are 22 characters", deviceId(sign.pub).length === 22);

const mac = generateDeviceKeys();
const phone = generateDeviceKeys();
ok("X25519 agrees both ways", x25519(mac.dh.priv, phone.dh.pub).equals(x25519(phone.dh.priv, mac.dh.pub)));
const i = new HandshakeState({ pattern: "IK", initiator: true, prologue: PROLOGUE.ik("m", "p"), s: phone.dh, rs: mac.dh.pub });
const r = new HandshakeState({ pattern: "IK", initiator: false, prologue: PROLOGUE.ik("m", "p"), s: mac.dh });
r.readMessage(i.writeMessage(Buffer.from("{}")));
i.readMessage(r.writeMessage(Buffer.from("{}")));
const ct = i.transport!.send.encryptWithAd(Buffer.alloc(0), Buffer.from("hello"));
ok("a fresh IK handshake carries a transport message", r.transport!.receive.decryptWithAd(Buffer.alloc(0), ct).toString() === "hello", b64u(ct).slice(0, 12));
finish();
