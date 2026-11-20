import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { DOMParser, DOMSerializer } from "@tiptap/pm/model";
import { documentImageSrc, spaceImageFromMediaUrl } from "@realm/contracts";
import { RichTextEditor } from "./RichTextEditor";
import { DocumentImage, RawBlock, TABLE_EXTENSIONS, parseMarkdown, serializeMarkdown } from "./markdown-model";

afterEach(() => { cleanup(); });

const ROOT = "/Users/me/space";

async function imagesIn(text: string, onChange: (md: string) => void = () => {}) {
  render(<RichTextEditor text={text} onChange={onChange} root={ROOT} path="notes/note.md" />);
  await screen.findByLabelText("Rich text editor", {}, { timeout: 4000 });
  return [...document.querySelectorAll<HTMLImageElement>(".documents-rich-surface img")];
}

/* A picture beside a Markdown file drew as a broken image (#548): the raw `pic.png` resolved against
   the renderer's own page, not the file's folder. */
describe("a picture in a Markdown document", () => {
  it("is drawn from the document's folder", async () => {
    const [beside, nested] = await imagesIn("![x](pic.png) ![y](img/pic.png)\n");
    expect(spaceImageFromMediaUrl(beside!.getAttribute("src")!)).toEqual({ root: ROOT, path: "notes/pic.png" });
    expect(spaceImageFromMediaUrl(nested!.getAttribute("src")!)).toEqual({ root: ROOT, path: "notes/img/pic.png" });
  });

  it("keeps a web picture and a data: one as written", async () => {
    const data = "data:image/png;base64,iVBORw0KGgo=";
    const [web, inline] = await imagesIn(`![w](https://example.com/a.png) ![d](${data})\n`);
    expect(web!.getAttribute("src")).toBe("https://example.com/a.png");
    expect(inline!.getAttribute("src")).toBe(data);
  });

  /* The resolved URL is a fact about this window, not about the file: written back, it would point
     at one Mac's folder and stop meaning anything everywhere else. */
  it("saves its relative path after its own block is edited", async () => {
    const onChange = vi.fn();
    await imagesIn("![x](pic.png)\n", onChange);
    fireEvent.click(screen.getByRole("button", { name: "Heading 1" }));
    const saved = onChange.mock.calls.at(-1)![0] as string;
    expect(saved).toBe("# ![x](pic.png)\n");
  });

  it("is left untouched, byte for byte, when nothing is edited", () => {
    const src = "Intro.\n\n![x](pic.png)\n\n![y](img/pic.png \"A title\")\n";
    expect(serializeMarkdown(parseMarkdown(src))).toBe(src);
  });

  /* Copy and paste reads the editor's own HTML back, and that HTML carries the resolved URL in `src`. */
  it("comes back from the editor's own HTML with its relative path", () => {
    const schema = getSchema([StarterKit, DocumentImage.configure({ inline: true, resolveSrc: (s: string) => documentImageSrc(s, "note.md", ROOT) }), ...TABLE_EXTENSIONS, RawBlock]);
    const doc = parseMarkdown("![x](pic.png)\n", schema);
    const html = DOMSerializer.fromSchema(schema).serializeFragment(doc.content);
    const box = document.createElement("div");
    box.appendChild(html);
    expect(box.querySelector("img")!.getAttribute("src")).toMatch(/^realm-media:/);
    const back = DOMParser.fromSchema(schema).parse(box);
    expect(serializeMarkdown(back)).toBe("![x](pic.png)\n");
  });
});
