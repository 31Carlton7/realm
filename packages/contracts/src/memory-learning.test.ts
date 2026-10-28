import { describe, expect, it } from "vitest";
import { memoryLearningKey, memoryLearningOn } from "./memory-learning";

describe("the profile's Learn from sessions switch", () => {
  it("is one setting per profile", () => {
    expect(memoryLearningKey("p1")).toBe("memory.learning:p1");
  });

  it("is on unless it was switched off — a missing or garbled row leaves it on", () => {
    expect(memoryLearningOn(null)).toBe(true);
    expect(memoryLearningOn(undefined)).toBe(true);
    expect(memoryLearningOn(true)).toBe(true);
    expect(memoryLearningOn("false")).toBe(true);
    expect(memoryLearningOn(false)).toBe(false);
  });
});
