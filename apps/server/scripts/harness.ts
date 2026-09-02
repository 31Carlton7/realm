/** The shared spine of the `live-*-check` scripts. They are run by hand against the REAL agent CLIs,
 *  so a failed check REPORTS and keeps going — one unavailable binary should not hide the verdict of
 *  every check after it. The process exit code is the verdict; `finish` is the only exit path. */
let failures = 0;

export const ok = (label: string, cond: boolean, detail = ""): void => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

export function finish(): never {
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
