import { describe, expect, it } from "vitest";
import { ProfileDirectory, isBrowserPartition, type ProfileFacts } from "./profile-directory";

const personal: ProfileFacts = { id: "pPersonal", name: "Personal", browserPartition: "persist:browser" };
const work: ProfileFacts = { id: "pWork", name: "Work", browserPartition: "persist:browser-pWork" };

function directory(answers: unknown[]) {
  const removed: string[] = [];
  let asked = 0;
  const dir = new ProfileDirectory({
    fetch: async () => {
      asked++;
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    onRemoved: (p) => removed.push(p.id),
  });
  return { dir, removed, asked: () => asked };
}

describe("ProfileDirectory", () => {
  it("names the profile that kept the shared partition — not the first in the list", async () => {
    /* THE mutant: take profiles[0]. The server lists by sort order, which the user can change; the
       profile holding the old sign-ins is the one holding the old jar. */
    const { dir } = directory([[work, personal]]);
    expect(dir.defaultProfileId()).toBeNull();
    await dir.refresh();
    expect(dir.defaultProfileId()).toBe("pPersonal");
  });

  it("says whose a partition is — a pane's profile, read off its view's cookie jar", async () => {
    const { dir } = directory([[personal, work]]);
    await dir.refresh();
    expect(dir.byPartition("persist:browser")).toEqual(personal);
    expect(dir.byPartition("persist:browser-pWork")).toEqual(work);
    expect(dir.byPartition("persist:browser-pGone")).toBeNull();
  });

  it("notices a profile that disappeared between answers, and not on the first answer", async () => {
    const { dir, removed } = directory([[personal, work], [personal]]);
    await dir.refresh();
    expect(removed).toEqual([]);
    await dir.refresh();
    expect(removed).toEqual(["pWork"]);
    expect(dir.get("pWork")).toBeNull();
  });

  it("asks again for a profile it has not heard of, once, and shares one request between askers", async () => {
    const { dir, asked } = directory([[personal], [personal, work]]);
    await dir.refresh();
    const [a, b] = await Promise.all([dir.resolve("pWork"), dir.resolve("pWork")]);
    expect(a).toEqual(work);
    expect(b).toEqual(work);
    expect(asked()).toBe(2);
    expect(await dir.resolve("pPersonal")).toEqual(personal);
    expect(asked()).toBe(2);
  });

  it("keeps the last answer when the server cannot be reached — and reports nobody as removed", async () => {
    const { dir, removed } = directory([[personal, work], new Error("realm-server disconnected")]);
    await dir.refresh();
    await dir.refresh();
    expect(dir.known()).toEqual([personal, work]);
    expect(removed).toEqual([]);
  });

  it("a profile whose partition it cannot read is NOT reported removed — its cookies are not this code's to clear", async () => {
    /* THE mutant: diff against the filtered list. A server that one day names partitions differently
       would have every profile "deleted", and main would clear every jar. */
    const { dir, removed } = directory([[personal, work], [personal, { ...work, browserPartition: "temp:new-scheme" }], "not a list"]);
    await dir.refresh();
    await dir.refresh();
    expect(removed).toEqual([]);
    expect(dir.get("pWork")).toBeNull();
    // An answer that is not a list at all removes nobody either, and forgets nothing.
    await dir.refresh();
    expect(removed).toEqual([]);
    expect(dir.known().map((p) => p.id)).toEqual(["pPersonal"]);
  });

  it("drops a row whose partition is not one main would hand a pane", async () => {
    const { dir } = directory([[personal, { id: "pOdd", name: "Odd", browserPartition: "" }, { id: "pX", name: "X", browserPartition: "temp:browser" }]]);
    await dir.refresh();
    expect(dir.known().map((p) => p.id)).toEqual(["pPersonal"]);
  });
});

describe("isBrowserPartition", () => {
  it("is the shared jar or a profile's own, and nothing else", () => {
    expect(isBrowserPartition("persist:browser")).toBe(true);
    expect(isBrowserPartition("persist:browser-01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
    for (const bad of ["", "browser", "persist:browser-", "persist:browser-../x", "persist:other", null, 3]) expect(isBrowserPartition(bad), String(bad)).toBe(false);
  });
});
