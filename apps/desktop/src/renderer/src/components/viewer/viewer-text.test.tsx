import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { ViewerText, textViewFor } from "./ViewerText";

afterEach(() => { vi.unstubAllGlobals(); });
/* The two editors are split out of the viewer's chunk, and their first import is a transform of
   CodeMirror and ProseMirror — seconds on a loaded machine. Taken once here, so each test times the
   view and not the bundler. */
beforeAll(async () => {
  await Promise.all([import("../../panes/documents/CodeEditor"), import("../../panes/documents/RichTextEditor")]);
}, 60_000);

describe("textViewFor", () => {
  it("reads Markdown as Markdown and source, LaTeX and a CSV as source", () => {
    expect(textViewFor("/x/README.md")).toBe("markdown");
    expect(textViewFor("/x/server.ts")).toBe("code");
    expect(textViewFor("/x/notes.txt")).toBe("code");
    expect(textViewFor("/x/paper.tex")).toBe("code");
    expect(textViewFor("/x/rows.csv")).toBe("code");
  });

  it("tries a name with no extension, and leaves the picture to what renders", () => {
    expect(textViewFor("/x/Makefile")).toBe("try");
    expect(textViewFor("/x/.zshrc")).toBe("try");
    expect(textViewFor("/x/report.pdf")).toBeNull();
    expect(textViewFor("/x/brief.docx")).toBeNull();
    expect(textViewFor("/x/page.html")).toBeNull();
    expect(textViewFor("/x/archive.zip")).toBeNull();
  });
});

describe("ViewerText", () => {
  it("draws source with the documents pane's code editor, read-only, with line numbers", async () => {
    vi.stubGlobal("realm", { files: { readText: vi.fn(async () => ({ ok: true, text: "const a = 1;\nconst b = 2;\n" })) } });
    const { container } = render(<ViewerText path="/x/a.ts" view="code" version={1} onBackdrop={() => {}} fallback={<p>picture</p>} />);
    await waitFor(() => expect(container.querySelector(".media-viewer-doc .cm-editor")).not.toBeNull(), { timeout: 4000 });
    expect(container.querySelector(".media-viewer-doc")!.getAttribute("data-view")).toBe("code");
    expect(container.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(container.querySelector('.cm-content[contenteditable="true"]')).toBeNull();
    expect(container.textContent).toContain("const b = 2;");
  });

  it("renders Markdown as the pane's rich view", async () => {
    vi.stubGlobal("realm", { files: { readText: vi.fn(async () => ({ ok: true, text: "# Atlas\n\nA line.\n" })) } });
    const { container } = render(<ViewerText path="/x/README.md" view="markdown" version={1} onBackdrop={() => {}} fallback={<p>picture</p>} />);
    await waitFor(() => expect(container.querySelector(".media-viewer-doc .documents-rich-surface h1")?.textContent).toBe("Atlas"), { timeout: 4000 });
  });

  it("shows the picture when the file is not text after all", async () => {
    vi.stubGlobal("realm", { files: { readText: vi.fn(async () => ({ ok: false, reason: "binary" })) } });
    const { findByText, container } = render(<ViewerText path="/x/Makefile" view="try" version={1} onBackdrop={() => {}} fallback={<p>picture</p>} />);
    await findByText("picture");
    expect(container.querySelector(".media-viewer-doc")).toBeNull();
  });

  it("shows the picture where there is no bridge to read through", async () => {
    vi.stubGlobal("realm", { files: {} });
    const { findByText } = render(<ViewerText path="/x/a.ts" view="code" version={1} onBackdrop={() => {}} fallback={<p>picture</p>} />);
    await findByText("picture");
  });
});
