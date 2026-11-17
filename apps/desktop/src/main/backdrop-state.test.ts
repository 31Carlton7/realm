import { describe, expect, it } from "vitest";
import { parseBackdropLine } from "./backdrop-state";

describe("the BackdropState helper's lines", () => {
  it("reads Low Power Mode and the covered windows, and nothing else", () => {
    expect(parseBackdropLine('{"lowPower":true}')).toEqual({ lowPower: true });
    expect(parseBackdropLine('{"covered":[12,345]}')).toEqual({ covered: [12, 345] });
    expect(parseBackdropLine('{"covered":[]}')).toEqual({ covered: [] });
    for (const bad of ['{"lowPower":"yes"}', '{"covered":["12"]}', '{"covered":[1.5]}', "{}", "not json", ""]) expect(parseBackdropLine(bad)).toBeNull();
  });
});
