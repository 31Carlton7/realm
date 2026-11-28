import { describe, expect, it } from "vitest";
import { parseBackdropLine, parseFramesLine } from "./backdrop-state";

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

describe("the BackdropState helper's frames", () => {
  it("reads each window's place on screen and the opaque windows above it", () => {
    const frames = parseFramesLine('{"frames":[{"window":12,"onScreen":true,"bounds":[100,100,1200,800],"above":[[200,150,1200,800]]},{"window":34,"onScreen":false,"bounds":[0,0,10,10],"above":[]}]}');
    expect(frames).toEqual(new Map([
      [12, { onScreen: true, bounds: { x: 100, y: 100, width: 1200, height: 800 }, above: [{ x: 200, y: 150, width: 1200, height: 800 }] }],
      [34, { onScreen: false, bounds: { x: 0, y: 0, width: 10, height: 10 }, above: [] }],
    ]));
    expect(parseFramesLine('{"frames":[]}')).toEqual(new Map());
  });

  it("reads a window macOS does not list (ordered out) as off screen", () => {
    expect(parseFramesLine('{"frames":[{"window":12,"onScreen":false}]}')).toEqual(new Map([[12, { onScreen: false, bounds: null, above: [] }]]));
  });

  it("reads nothing from a line that is not frames", () => {
    for (const bad of ['{"covered":[],"asleep":[],"locked":false}', '{"frames":[{"window":"12","onScreen":true,"bounds":[0,0,1,1],"above":[]}]}',
      '{"frames":[{"window":12,"onScreen":"yes","bounds":[0,0,1,1],"above":[]}]}', '{"frames":[{"window":12,"onScreen":true,"bounds":[0,0,1],"above":[]}]}',
      '{"frames":[{"window":12,"onScreen":true,"bounds":[0,0,1,1],"above":[[0,0,"1",1]]}]}', "not json", ""]) {
      expect(parseFramesLine(bad)).toBeNull();
    }
  });
});
