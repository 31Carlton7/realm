import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";

/** Whether this machine has an `openssl` to make a certificate with; the TLS tests skip without one. */
export const hasOpenssl = (() => {
  try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; }
})();

/** A self-signed certificate for 127.0.0.1 and localhost, made fresh for a test run: no key is ever
 *  checked in. `ca` is the certificate itself, which is how a client trusts a self-signed one. */
export function selfSignedCert(cn = "realm-test"): { cert: string; key: string; ca: string } {
  const dir = tempDir("realm-cert-");
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", key, "-out", cert, "-days", "2", "-subj", `/CN=${cn}`, "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
  return { cert, key, ca: readFileSync(cert, "utf8") };
}
