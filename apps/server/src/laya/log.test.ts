import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { DecisionLog } from "./log";

/**
 * The decision log on disk. What must die: a row lost or reordered, a log that grows without bound,
 * a count that forgets the rotated files, a Delete that leaves one behind, and a file other users of
 * the Mac can read — it holds what was on screen.
 */

const rows = (p: string) => readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { n: number });

describe("the decision log", () => {
  it("appends one JSON line per row, in order", () => {
    const path = join(tempDir("realm-laya-log-"), "laya", "decisions.jsonl");
    const log = new DecisionLog({ path });
    for (let n = 1; n <= 3; n++) log.append({ n });
    expect(rows(path).map((r) => r.n)).toEqual([1, 2, 3]);
    expect(log.count()).toBe(3);
  });

  it("is readable by its owner alone, in a directory only its owner can list", () => {
    const dir = join(tempDir("realm-laya-log-"), "laya");
    const log = new DecisionLog({ path: join(dir, "decisions.jsonl") });
    log.append({ n: 1 });
    expect(statSync(join(dir, "decisions.jsonl")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("rotates at its size cap and keeps a bounded number of old files", () => {
    const dir = tempDir("realm-laya-log-");
    const path = join(dir, "decisions.jsonl");
    // A row is 8 bytes ({"n":N} plus the newline), so a 20-byte cap holds two.
    const log = new DecisionLog({ path, maxBytes: 20, keep: 2 });
    for (let n = 1; n <= 9; n++) log.append({ n });
    expect(readdirSync(dir).sort()).toEqual(["decisions.1.jsonl", "decisions.2.jsonl", "decisions.jsonl"]);
    // Newest in the current file, the one before in .1, then .2; the two oldest pairs are gone.
    expect(rows(path).map((r) => r.n)).toEqual([9]);
    expect(rows(join(dir, "decisions.1.jsonl")).map((r) => r.n)).toEqual([7, 8]);
    expect(rows(join(dir, "decisions.2.jsonl")).map((r) => r.n)).toEqual([5, 6]);
    expect(log.count()).toBe(5);
  });

  it("counts every file on disk when it is opened again", () => {
    const dir = tempDir("realm-laya-log-");
    const path = join(dir, "decisions.jsonl");
    const first = new DecisionLog({ path, maxBytes: 20, keep: 3 });
    for (let n = 1; n <= 5; n++) first.append({ n });
    const reopened = new DecisionLog({ path, maxBytes: 20, keep: 3 });
    expect(reopened.count()).toBe(5);
    // …and keeps appending where the file left off, rotating on the same size it already has.
    reopened.append({ n: 6 });
    reopened.append({ n: 7 });
    expect(reopened.count()).toBe(7);
    expect(rows(path).map((r) => r.n)).toEqual([7]);
  });

  it("Delete removes the current file and every rotated one, including any a larger keep left", () => {
    const dir = tempDir("realm-laya-log-");
    const path = join(dir, "decisions.jsonl");
    const log = new DecisionLog({ path, maxBytes: 20, keep: 2 });
    for (let n = 1; n <= 6; n++) log.append({ n });
    writeFileSync(join(dir, "decisions.9.jsonl"), '{"n":0}\n');
    writeFileSync(join(dir, "unrelated.jsonl"), "{}\n");
    log.delete();
    expect(readdirSync(dir)).toEqual(["unrelated.jsonl"]);
    expect(log.count()).toBe(0);
    log.append({ n: 7 });
    expect(log.count()).toBe(1);
    expect(existsSync(path)).toBe(true);
  });
});
