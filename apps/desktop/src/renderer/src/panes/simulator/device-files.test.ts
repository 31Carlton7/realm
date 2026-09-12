import { describe, expect, it } from "vitest";
import { sortForDevice } from "./device-files";

const f = (name: string, path = `/tmp/${name}`) => ({ name, path });

describe("sortForDevice", () => {
  it("sends an app to be installed and a picture to the photo library", () => {
    const sorted = sortForDevice([f("Acme.app"), f("Acme.ipa"), f("shot.png"), f("clip.mov")]);
    expect(sorted.apps).toEqual(["/tmp/Acme.app", "/tmp/Acme.ipa"]);
    expect(sorted.media).toEqual(["/tmp/shot.png", "/tmp/clip.mov"]);
    expect(sorted.unusable).toEqual([]);
  });

  it("reads the extension, not the MIME type", () => {
    /* Chromium reports an empty type for a `.app` — it is a directory — and for plenty of video
       containers. The name is the only thing that is always there. */
    expect(sortForDevice([f("Thing.APP"), f("PHOTO.HEIC")])).toMatchObject({
      apps: ["/tmp/Thing.APP"], media: ["/tmp/PHOTO.HEIC"], unusable: [],
    });
  });

  it("names what it cannot use, rather than dropping it silently", () => {
    // A target that quietly ignores two of your four files looks like a target that missed.
    const sorted = sortForDevice([f("notes.md"), f("shot.png"), f("data.csv")]);
    expect(sorted.media).toEqual(["/tmp/shot.png"]);
    expect(sorted.unusable).toEqual(["notes.md", "data.csv"]);
  });

  it("a file with no path on disk is unusable whatever it is called", () => {
    /* A paste, or a drag out of a browser: Electron pins no path to it, and every one of these
       commands takes a path. Naming it is how the user learns that dragging the image out of a web
       page is not the same as dragging the file. */
    expect(sortForDevice([{ name: "pasted.png", path: "" }])).toEqual({ apps: [], media: [], unusable: ["pasted.png"] });
  });

  it("a name with no extension at all is not an app", () => {
    expect(sortForDevice([f("Makefile"), f(".gitignore")])).toMatchObject({ apps: [], media: [], unusable: ["Makefile", ".gitignore"] });
  });
});
