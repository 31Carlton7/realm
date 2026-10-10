import { createElement, useId, type CSSProperties, type ReactNode } from "react";
import { REALMITE_CSS } from "./css";
import { drawRealmite, type SvgNode } from "./draw";
import type { Face } from "./parts";
import type { RealmiteSpec, RealmiteState } from "./spec";

/** SVG attribute names as React spells them. Only the ones the drawing uses. */
const REACT_ATTR: Record<string, string> = {
  class: "className", "clip-path": "clipPath", "stroke-width": "strokeWidth", "fill-opacity": "fillOpacity",
};

function styleObject(text: string): CSSProperties {
  const out: Record<string, string> = {};
  for (const decl of text.split(";")) {
    const i = decl.indexOf(":");
    if (i > 0) out[decl.slice(0, i)] = decl.slice(i + 1);
  }
  return out as CSSProperties;
}

function toReact(node: SvgNode, key?: number): ReactNode {
  const props: Record<string, unknown> = key === undefined ? {} : { key };
  for (const [k, v] of Object.entries(node.attrs)) {
    if (k === "xmlns") continue;
    if (k === "style") props.style = styleObject(String(v));
    else props[REACT_ATTR[k] ?? k] = v;
  }
  return createElement(node.tag, props, ...(node.children ?? []).map((c, i) => toReact(c, i)));
}

/**
 * A team role's creature, drawn inline: no asset, no fetch. `size` is the rendered square in px and
 * picks how much detail survives (16 a row, 24 a card, 48 a list head, 160 the role page). Give it a
 * `title` where nothing beside it names the role; leave it out beside the role's name, where it is
 * decoration.
 *
 * The stylesheet is hoisted once per document by React (`href` + `precedence`), however many are on
 * screen.
 */
export function Realmite({ spec, size, state = "idle", face, title }: {
  spec: RealmiteSpec;
  size: number;
  state?: RealmiteState;
  face?: Face;
  title?: string;
}) {
  const uid = `rmt${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <>
      <style href="realm-realmite" precedence="default">{REALMITE_CSS}</style>
      {toReact(drawRealmite(spec, { size, state, uid, face, title }))}
    </>
  );
}
