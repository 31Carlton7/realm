import { describe, expect, it } from "vitest";
import { cleanHostname, machineName } from "./machine-name";

describe("cleanHostname", () => {
  it("strips the mDNS .local suffix, case-insensitively, and only at the end", () => {
    expect(cleanHostname("Carltons-MacBook-Pro.local")).toBe("Carltons-MacBook-Pro");
    expect(cleanHostname("Carltons-MacBook-Pro.LOCAL")).toBe("Carltons-MacBook-Pro");
    // ".local" mid-name is part of the name, not the suffix.
    expect(cleanHostname("my.local.box")).toBe("my.local.box");
  });
  it("never returns an empty label", () => {
    expect(cleanHostname(".local")).toBe(".local"); // cleaning to nothing keeps the raw value
    expect(cleanHostname("box")).toBe("box");
  });
});

describe("machineName", () => {
  it("resolves a non-empty name on any host (scutil or the hostname fallback)", async () => {
    const name = await machineName();
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
    expect(name.endsWith(".local")).toBe(false);
  });
});
