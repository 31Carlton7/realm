import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { FILE_MARK_IDS, FileMark, fileMarkId } from "./file-icon";

const VENDORED = import.meta.glob<string>("../assets/file-icons/*.svg", { query: "?raw", import: "default", eager: true });

describe("fileMarkId", () => {
  it("reads the whole name before the extension", () => {
    expect(fileMarkId("/x/package.json")).toBe("nodejs");
    expect(fileMarkId("/x/data.json")).toBe("json");
    expect(fileMarkId("/x/README.md")).toBe("readme");
    expect(fileMarkId("/x/notes.md")).toBe("markdown");
    expect(fileMarkId("/x/Dockerfile")).toBe("docker");
    expect(fileMarkId("/x/tsconfig.node.json")).toBe("tsconfig");
    expect(fileMarkId("/x/vite.config.mts")).toBe("vite");
    expect(fileMarkId("/x/vitest.config.ts")).toBe("vitest");
    expect(fileMarkId("/x/.env.local")).toBe("tune");
    expect(fileMarkId("/x/pnpm-lock.yaml")).toBe("pnpm");
  });

  it("then the extension, a .ts the TS square and a .tsx React's", () => {
    expect(fileMarkId("a/b/server.ts")).toBe("typescript");
    expect(fileMarkId("App.tsx")).toBe("react_ts");
    expect(fileMarkId("main.PY")).toBe("python");
    expect(fileMarkId("deck.key")).toBeNull(); // Keynote on a Mac, not a key — no mark beats a wrong one
    expect(fileMarkId("mystery.qqq")).toBeNull();
  });

  it("every mark the tables can name is a file in the vendored set", () => {
    const have = new Set(Object.keys(VENDORED).map((p) => p.split("/").pop()!.replace(/\.svg$/, "")));
    expect(FILE_MARK_IDS.filter((id) => !have.has(id))).toEqual([]);
  });
});

describe("FileMark", () => {
  it("draws the logo as a picture with no name of its own", () => {
    const { container } = render(<FileMark path="server.ts" size={20} />);
    const mark = container.querySelector(".file-mark")!;
    expect(mark.getAttribute("data-mark")).toBe("typescript");
    const img = mark.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("width")).toBe("20");
  });

  it("carries the light-ground drawing beside the dark one where the set has one", () => {
    const { container } = render(<FileMark path="next.config.js" size={20} />);
    expect(container.querySelector(".file-mark")!.hasAttribute("data-has-light")).toBe(true);
    expect(container.querySelectorAll(".file-mark img")).toHaveLength(2);
  });

  it("is a folder when told so, whatever the name says", () => {
    const { container } = render(<FileMark path="photos.png" folder size={20} />);
    expect(container.querySelector(".file-mark")!.getAttribute("data-mark")).toBe("folder");
  });

  it("falls back to Realm's glyph for its type where the set has nothing", () => {
    const { container } = render(<FileMark path="mystery.qqq" size={16} />);
    expect(container.querySelector(".file-mark")!.hasAttribute("data-glyph")).toBe(true);
    expect(container.querySelector(".file-mark svg")).not.toBeNull();
  });
});
