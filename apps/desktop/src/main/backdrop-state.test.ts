import { describe, expect, it } from "vitest";
import { parseBackdropLine } from "./backdrop-state";

describe("the BackdropState helper's lines", () => {
  it("reads Low Power Mode and the windows nobody can see, and nothing else", () => {
    expect(parseBackdropLine('{"lowPower":true}')).toEqual({ lowPower: true });
    expect(parseBackdropLine('{"covered":[12,345],"asleep":[],"locked":false}')).toEqual({ covered: [12, 345], asleep: [], locked: false });
    expect(parseBackdropLine('{"covered":[],"asleep":[],"locked":false}')).toEqual({ covered: [], asleep: [], locked: false });
    for (const bad of ['{"lowPower":"yes"}', '{"covered":["12"],"asleep":[],"locked":false}', '{"covered":[1.5],"asleep":[],"locked":false}', "{}", "not json", ""]) {
      expect(parseBackdropLine(bad)).toBeNull();
    }
  });

  it("reads a window on displays that are all asleep", () => {
    expect(parseBackdropLine('{"covered":[],"asleep":[12],"locked":false}')).toEqual({ covered: [], asleep: [12], locked: false });
    for (const bad of ['{"covered":[],"asleep":["12"],"locked":false}', '{"covered":[],"asleep":[1.5],"locked":false}', '{"covered":[],"locked":false}']) {
      expect(parseBackdropLine(bad)).toBeNull();
    }
  });

  it("reads a locked screen", () => {
    expect(parseBackdropLine('{"covered":[],"asleep":[],"locked":true}')).toEqual({ covered: [], asleep: [], locked: true });
    for (const bad of ['{"covered":[],"asleep":[],"locked":1}', '{"covered":[],"asleep":[],"locked":"true"}', '{"covered":[],"asleep":[]}']) {
      expect(parseBackdropLine(bad)).toBeNull();
    }
  });
});
