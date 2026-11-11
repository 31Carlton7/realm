import { icons } from "@realm/ui";

/** The outline a rendered control draws: its svg's path data, in order. */
export function drawnGlyph(el: Element): string[] {
  return [...el.querySelectorAll("svg path")].map((p) => p.getAttribute("d") ?? "");
}

/** The outline `<Icon name>` draws, from the icon set itself. */
export function glyphOf(name: keyof typeof icons): string[] {
  return (icons[name] as readonly (readonly [string, Record<string, unknown>])[])
    .filter(([tag]) => tag === "path").map(([, attrs]) => String(attrs.d));
}
