import CodeBlock from "@tiptap/extension-code-block";
import { NodeSelection, Selection, TextSelection } from "@tiptap/pm/state";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import { uiBlockKind } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useRef, useState } from "react";
import { DrawnBlock, useUiBlock, type BlockState } from "../session/rich/UiBlock";
import { openFence } from "./markdown-model";

/**
 * A ```mermaid, ```realm-chart or ```realm-compare fence in a Markdown document, drawn in the rich
 * view as the transcript draws it — the document an agent keeps as a board, the notes it leaves.
 *
 * It is still the code block it was. The node, its language and its text are untouched, so the file
 * round-trips byte for byte (`markdown-model.ts`); only what the rich view SHOWS changes. The source
 * is one control away, and comes back by itself wherever the caret goes into it, so editing a chart
 * is editing its JSON in place — the drawing following each pause in the typing. A body that does not
 * parse stays the code, with the reason over it, and a fence the file has not closed yet stays code
 * until it is closed.
 */
export const UiCodeBlock = CodeBlock.extend({
  addNodeView() {
    const drawn = ReactNodeViewRenderer(BlockNodeView, {
      // A fence whose language stops being a block, or becomes one, is a different view.
      update: ({ oldNode, newNode, updateProps }) => {
        if (newNode.type !== oldNode.type || uiBlockKind(newNode.attrs["language"] as string | null) !== uiBlockKind(oldNode.attrs["language"] as string | null)) return false;
        updateProps();
        return true;
      },
      // The drawing is the block's own interface: its clicks are its buttons', never a selection.
      stopEvent: ({ event }) => event.target instanceof Element && event.target.closest(".ui-block-node-view") !== null,
    });
    // Every other code block keeps ProseMirror's own rendering — a null view is ProseMirror's cue to
    // draw the node from its schema.
    return (props) => (uiBlockKind(props.node.attrs["language"] as string | null) ? drawn(props) : (null as unknown as ReturnType<typeof drawn>));
  },
});

function BlockNodeView({ node, editor, getPos, selectionInside }: ReactNodeViewProps) {
  const kind = uiBlockKind(node.attrs["language"] as string | null)!;
  const source = node.textContent;
  const open = openFence(node);
  const state = useUiBlock(kind, source, { skip: open });
  const [editing, setEditing] = useState(false);
  // While the source is being edited, a body that stops parsing mid-word keeps the last drawing up,
  // with the reason over the code, rather than the figure blinking out at every keystroke.
  const last = useRef<Extract<BlockState, { status: "drawn" }> | null>(null);
  if (state.status === "drawn") last.current = state;
  const showCode = open || editing || Boolean(selectionInside) || state.status !== "drawn";
  const drawn = state.status === "drawn" ? state : (editing || selectionInside) && !open ? last.current : null;

  const toggle = () => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    const { state: doc, view } = editor;
    if (showCode && state.status === "drawn") {
      setEditing(false);
      // Out of the source, to the next place a caret can go — or onto the block, when it is last.
      const after = Selection.findFrom(doc.doc.resolve(pos + node.nodeSize), 1, true);
      view.dispatch(doc.tr.setSelection(after ?? NodeSelection.create(doc.doc, pos)));
    } else {
      setEditing(true);
      view.dispatch(doc.tr.setSelection(TextSelection.create(doc.doc, pos + 1 + node.content.size)));
    }
    view.focus();
  };

  return (
    <NodeViewWrapper className="ui-block-node" data-code={showCode || undefined}>
      {drawn && (
        <div className="ui-block-node-view" contentEditable={false}>
          <DrawnBlock state={drawn} kind={kind} source={source} sourceShown={showCode}
            actions={(
              <button type="button" className="tool-copy ui-block-act" aria-pressed={showCode} aria-label="Edit source"
                title={showCode ? "Done editing the source" : "Edit the source"} onClick={toggle}>
                <Icon name="code" size={14} />
              </button>
            )} />
        </div>
      )}
      {state.status === "failed" && !open && <p className="ui-block-node-reason" contentEditable={false}>Not drawn — {state.reason}</p>}
      <pre className="ui-block-node-code" hidden={!showCode}><NodeViewContent<"code"> as="code" /></pre>
    </NodeViewWrapper>
  );
}
