import { describe, expect, it } from "vitest";
import { artFor, artRotation, fitDeviceArt } from "./device-art";
import { DEVICE_ART } from "./device-art.generated";

/** Real framebuffers, so the choices are checked against devices rather than against numbers picked
 *  to satisfy the check. */
const IPHONE_17 = { width: 1206, height: 2622, orientation: "portrait" };
const IPHONE_SE = { width: 750, height: 1334, orientation: "portrait" };
const IPAD_11 = { width: 1668, height: 2388, orientation: "portrait" };
const PIXEL = { width: 1080, height: 2400, orientation: "portrait" };
const WATCH = { width: 396, height: 484, orientation: "portrait" };
const art = (screen: typeof IPHONE_17, platform: "ios" | "android" = "ios") => artFor(screen, platform);

describe("artFor", () => {
  it("gives the family's frame to every member of it", () => {
    expect(art(IPHONE_17)).toBe(DEVICE_ART.iosPhone);
    expect(art(IPAD_11)).toBe(DEVICE_ART.iosTablet);
    expect(art(PIXEL, "android")).toBe(DEVICE_ART.androidPhone);
  });

  it("a rotated device is the same device, and gets the same frame", () => {
    for (const screen of [IPHONE_17, IPAD_11]) {
      expect(art({ ...screen, width: screen.height, height: screen.width, orientation: "landscape_left" })).toBe(art(screen));
    }
  });

  it("refuses a frame that would be the wrong picture of the device", () => {
    /* THE MUTANT: pick the frame by platform and shape alone. An iPhone SE is 16:9 and every frame
       Realm ships is 19.5:9, so an SE would arrive letterboxed inside a Dynamic Island — a frame
       claiming the device is a model it is not. Those fall back to the frame Realm draws. */
    expect(art(IPHONE_SE)).toBeNull();
    expect(art(WATCH)).toBeNull();
  });

  it("ships no picture of an Android tablet, and says so rather than reaching for the iPad", () => {
    expect(art(IPAD_11, "android")).toBeNull();
  });

  it("draws its own frame until the row says which toolchain this is", () => {
    // The platform is carried, never inferred (the contract is explicit). An emulator wearing an
    // iPhone for the second before the row lands is worse than no art for that second.
    expect(artFor(IPHONE_17, null)).toBeNull();
  });
});

describe("artRotation", () => {
  it("turns the frame with the device, and only when the device has turned", () => {
    expect(artRotation(IPHONE_17)).toBe(0);
    expect(artRotation({ ...IPHONE_17, orientation: "portrait_upside_down" })).toBe(180);
    const landscape = { width: IPHONE_17.height, height: IPHONE_17.width };
    expect(artRotation({ ...landscape, orientation: "landscape_left" })).toBe(270);
    expect(artRotation({ ...landscape, orientation: "landscape_right" })).toBe(90);
  });

  it("reads the picture's own proportions rather than trusting the word", () => {
    /* The framebuffer arrives already rotated, and the word is whatever the device said last. A
       portrait picture labelled `landscape_left` must not turn the frame onto its side around an
       upright screen — the picture is the thing that cannot be wrong. */
    expect(artRotation({ ...IPHONE_17, orientation: "landscape_left" })).toBe(0);
  });
});

describe("fitDeviceArt", () => {
  const BOX = { width: 400, height: 900 };

  it("scales the whole device into the pane and puts the stream in the hole", () => {
    const laid = fitDeviceArt(IPHONE_17, DEVICE_ART.iosPhone, BOX)!;
    expect(laid.frameWidth).toBeLessThanOrEqual(BOX.width);
    expect(laid.frameHeight).toBeLessThanOrEqual(BOX.height);
    // Inside the frame on every side: a picture that reached an edge would be a hole in the phone.
    expect(laid.pictureLeft).toBeGreaterThan(0);
    expect(laid.pictureTop).toBeGreaterThan(0);
    expect(laid.pictureLeft + laid.pictureWidth).toBeLessThanOrEqual(laid.frameWidth + 0.001);
    expect(laid.pictureTop + laid.pictureHeight).toBeLessThanOrEqual(laid.frameHeight + 0.001);
  });

  it("FITS the stream into the hole rather than stretching it to fill", () => {
    // The proportions of what someone is building are the one thing a device preview must not lie
    // about, and `artFor` has already refused the frames where this would be visible.
    const laid = fitDeviceArt(IPHONE_17, DEVICE_ART.iosPhone, BOX)!;
    expect(laid.pictureWidth / laid.pictureHeight).toBeCloseTo(IPHONE_17.width / IPHONE_17.height, 3);
  });

  it("turns the frame and the hole together, so a landscape stream lands on a landscape screen", () => {
    /* THE MUTANT this exists for: rotate the art and leave the hole in portrait coordinates. The
       frame then looks perfect and the picture sits across the phone's middle at right angles to
       it — which is why the hole is mapped through the same rotation as the picture. */
    const landscape = { width: IPHONE_17.height, height: IPHONE_17.width, orientation: "landscape_right" };
    const laid = fitDeviceArt(landscape, DEVICE_ART.iosPhone, { width: 900, height: 400 })!;
    expect(laid.rotation).toBe(90);
    expect(laid.frameWidth).toBeGreaterThan(laid.frameHeight); // the device is on its side
    expect(laid.pictureWidth).toBeGreaterThan(laid.pictureHeight);
    expect(laid.pictureLeft).toBeGreaterThan(0);
    expect(laid.pictureTop).toBeGreaterThan(0);
    expect(laid.pictureLeft + laid.pictureWidth).toBeLessThanOrEqual(laid.frameWidth + 0.001);
    expect(laid.pictureTop + laid.pictureHeight).toBeLessThanOrEqual(laid.frameHeight + 0.001);
  });

  it("puts the turned art back over its own box", () => {
    /* Rotation is about the element's top-left, which leaves a quarter-turned picture entirely
       outside the box on one axis. The offsets are what bring it back, and getting them wrong is a
       frame drawn beside the device rather than around it. */
    const landscape = { width: IPHONE_17.height, height: IPHONE_17.width, orientation: "landscape_right" };
    const laid = fitDeviceArt(landscape, DEVICE_ART.iosPhone, { width: 900, height: 400 })!;
    expect(laid.offsetX).toBeCloseTo(laid.artHeight, 5);
    expect(laid.offsetY).toBe(0);
    // …and the turned art's own box is the frame's, with the edges swapped.
    expect(laid.artWidth).toBeCloseTo(laid.frameHeight, 5);
    expect(laid.artHeight).toBeCloseTo(laid.frameWidth, 5);
  });

  it("is null for a box with no room, rather than a frame of NaN", () => {
    expect(fitDeviceArt(IPHONE_17, DEVICE_ART.iosPhone, { width: 0, height: 0 })).toBeNull();
  });
});

describe("the shipped art", () => {
  it("has a hole inside it, on every frame", () => {
    // A screen rectangle that ran past the picture would put the stream half outside the phone.
    for (const [key, frame] of Object.entries(DEVICE_ART)) {
      expect(frame.screen.x, key).toBeGreaterThan(0);
      expect(frame.screen.y, key).toBeGreaterThan(0);
      expect(frame.screen.x + frame.screen.width, key).toBeLessThanOrEqual(frame.width);
      expect(frame.screen.y + frame.screen.height, key).toBeLessThanOrEqual(frame.height);
    }
  });

  it("is portrait, which is the orientation the rotation is composed from", () => {
    for (const [key, frame] of Object.entries(DEVICE_ART)) {
      expect(frame.height, key).toBeGreaterThan(frame.width);
    }
  });
});
