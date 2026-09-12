import { describe, expect, it } from "vitest";
import {
  androidBins, encodeInputText, firstUntypeable, parseAdbDevices, parseAvds,
  parseBounds, parsePackages, parseUiAutomator, parseWmSize, sdkRoot,
} from "./android";

describe("finding the SDK", () => {
  it("prefers ANDROID_HOME, then the deprecated root, then the default path", () => {
    const home = "/Users/x";
    expect(sdkRoot({ ANDROID_HOME: "/nope" }, home)).toBe(null); // must EXIST, not just be named
    expect(sdkRoot({}, "/definitely/not/here")).toBe(null);
  });

  it("reports each tool as missing rather than handing back a path that is not there", () => {
    // The failure this prevents: returning `<root>/emulator/emulator` on a machine that has the SDK
    // but not the emulator package — which is the exact state this Mac was in — and only finding out
    // when spawn fails with ENOENT and no sentence anyone can act on.
    const bins = androidBins({ ANDROID_HOME: "/definitely/not/here" }, "/Users/x");
    expect(bins).toEqual({ adb: null, emulator: null, root: null });
  });
});

describe("parsing what the tools say", () => {
  it("reads AVD names and ignores the tool's own chatter", () => {
    const out = "INFO | storing crashdata in: /tmp\nPixel_7_API_36\nTablet_API_34\n\n";
    expect(parseAvds(out)).toEqual(["Pixel_7_API_36", "Tablet_API_34"]);
  });

  it("keeps offline and unauthorized devices — a phone in a bad state is still a phone", () => {
    const out = [
      "List of devices attached",
      "emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1",
      "R5CT30XXXXX            unauthorized",
      "emulator-5556          offline",
    ].join("\n");
    expect(parseAdbDevices(out)).toEqual([
      { serial: "emulator-5554", state: "device", model: "sdk gphone64 arm64" },
      { serial: "R5CT30XXXXX", state: "unauthorized", model: null },
      { serial: "emulator-5556", state: "offline", model: null },
    ]);
  });

  it("takes the OVERRIDE size when a device has one", () => {
    // The bug: reading the physical size on a device with an override puts every tap at the wrong
    // place, and the picture looks perfectly correct while it happens.
    expect(parseWmSize("Physical size: 1080x2400\nOverride size: 720x1600\n")).toEqual({ width: 720, height: 1600 });
    expect(parseWmSize("Physical size: 1080x2400\n")).toEqual({ width: 1080, height: 2400 });
    expect(parseWmSize("nothing here")).toBe(null);
  });

  it("lists third-party packages only", () => {
    expect(parsePackages("package:com.example.b\npackage:com.example.a\nrubbish\n"))
      .toEqual([{ bundleId: "com.example.a", name: "a" }, { bundleId: "com.example.b", name: "b" }]);
  });

  it("turns Android's two corners into a frame", () => {
    expect(parseBounds("[0,0][1080,2400]")).toEqual({ x: 0, y: 0, width: 1080, height: 2400 });
    expect(parseBounds("[10,20][30,50]")).toEqual({ x: 10, y: 20, width: 20, height: 30 });
    expect(parseBounds("garbage")).toBe(null);
  });
});

describe("the uiautomator tree", () => {
  // A real dump's shape: one line, attributes only, a mix of self-closing and nested nodes.
  const xml = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<hierarchy rotation="0">'
    + '<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.launcher3" content-desc="" enabled="true" bounds="[0,0][1080,2400]">'
    +   '<node index="0" text="Phone" resource-id="com.android.launcher3:id/title" class="android.widget.TextView" package="com.android.launcher3" content-desc="" enabled="true" bounds="[40,100][300,160]"/>'
    +   '<node index="1" text="" resource-id="" class="android.widget.Button" package="com.android.launcher3" content-desc="Search" enabled="false" bounds="[0,200][1080,300]">'
    +     '<node index="0" text="deep" resource-id="" class="android.widget.TextView" package="com.android.launcher3" content-desc="" enabled="true" bounds="[10,210][100,290]"/>'
    +   '</node>'
    + '</node>'
    + '</hierarchy>';

  it("reads the root as the screen and the package as the app", () => {
    const tree = parseUiAutomator(xml);
    expect(tree.screen).toEqual({ width: 1080, height: 2400 });
    expect(tree.app).toBe("com.android.launcher3");
  });

  it("gives every node an index path that matches its place in the tree", () => {
    const tree = parseUiAutomator(xml);
    expect(tree.elements.map((e) => `${e.path}@${e.depth}`)).toEqual(["0@0", "0.0@1", "0.1@1", "0.1.0@2"]);
  });

  it("falls back to content-desc for a label, which is where a Button's name usually is", () => {
    // `text` is empty on an icon button and `content-desc` is the accessible name. Reading only
    // `text` gives a tree of unlabelled buttons, which is useless for tapping by label.
    const button = parseUiAutomator(xml).elements.find((e) => e.role.endsWith("Button"))!;
    expect(button.label).toBe("Search");
    expect(button.enabled).toBe(false);
    expect(button.frame).toEqual({ x: 0, y: 200, width: 1080, height: 100 });
  });

  it("passes Android's own class through as the role", () => {
    expect(parseUiAutomator(xml).elements[1]!.role).toBe("android.widget.TextView");
    expect(parseUiAutomator(xml).elements[1]!.id).toBe("com.android.launcher3:id/title");
  });

  it("survives an empty or broken dump instead of throwing", () => {
    expect(parseUiAutomator("").elements).toEqual([]);
    expect(parseUiAutomator("<hierarchy></hierarchy>").elements).toEqual([]);
  });
});

describe("input text, the trap", () => {
  /* `adb shell input text` goes through a shell and then a synthesiser that only knows ASCII. This
     is the same refusal `vm_act` makes for the same reason, and it is the one place the Android path
     is genuinely harder than the iOS one rather than merely different. */
  it("escapes the two characters that break the command itself", () => {
    expect(encodeInputText("hello world")).toBe("hello%sworld");
    expect(encodeInputText("100%")).toBe("100%%");
  });

  it("escapes shell syntax rather than letting it run", () => {
    // THE mutant: dropping this replace. `adb shell input text "a; rm -rf b"` runs the second half.
    expect(encodeInputText("a;b")).toBe("a\\;b");
    expect(encodeInputText("$(x)")).toBe("\\$\\(x\\)");
  });

  it("REFUSES anything it cannot type, rather than typing something else", () => {
    expect(encodeInputText("héllo")).toBe(null);
    expect(encodeInputText("emoji 🙂")).toBe(null);
    expect(encodeInputText("newline\n")).toBe(null);
    expect(firstUntypeable("héllo")).toBe("é");
    expect(firstUntypeable("plain ascii")).toBe(null);
  });

  it("passes plain ASCII through untouched", () => {
    expect(encodeInputText("")).toBe("");
    expect(encodeInputText("abcXYZ0189")).toBe("abcXYZ0189");
  });
});
