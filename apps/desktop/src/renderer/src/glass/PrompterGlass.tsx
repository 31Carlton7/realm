import { createElement, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PROMPTER_LENS, type FilterPrimitive, type GlassLens, type LensShape } from "./lens";

const draw = (p: FilterPrimitive, key: number): ReactNode =>
  createElement(p.tag, { key, ...p.props }, p.children?.map(draw));

/**
 * The glass under the prompter's content: one empty layer that bends and frosts what is behind the
 * card (styles.css, `.composer-glass`). Over a picture the card has no face, so what it bends is the
 * picture's canvas; on a plain pane the card's own tinted face is in that backdrop, so the filter
 * never works on the window's bare transparency. The editor, the caret and the bars stay where
 * they were, as ordinary children of the card above it.
 *
 * The filter goes on only once its map exists. A `backdrop-filter` naming a filter that is not there
 * yet is not a no-op, so until then the layer is an empty box and the card reads as the plain one.
 */
export function PrompterGlass({ lens = PROMPTER_LENS }: { lens?: GlassLens }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shape, setShape] = useState<LensShape | null>(null);
  const id = `prompter-glass-${useId().replace(/:/g, "")}`;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
      setShape((prev) => (prev && prev.width === width && prev.height === height && prev.radius === radius ? prev
        : width > 0 && height > 0 ? { width, height, radius } : null));
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const primitives = useMemo(() => (shape ? lens.primitives(shape) : null), [lens, shape]);
  // A new id for every new graph: Chromium keeps the filter it resolved for a url() until the url changes.
  const version = useRef(0);
  const filterId = useMemo(() => `${id}-${(version.current += 1)}`, [id, primitives]);

  // The stylesheet composes the lens with the frost (`--glass-frost`). Unset, `var(--glass-lens)` makes
  // the whole backdrop-filter invalid, which is `none`.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (primitives) el.style.setProperty("--glass-lens", `url(#${filterId})`);
    else el.style.removeProperty("--glass-lens");
  }, [primitives, filterId]);

  return (
    <span ref={ref} className="composer-glass" aria-hidden="true" data-lens={lens.name}>
      {shape && primitives && (
        <svg width={0} height={0} focusable="false">
          <filter id={filterId} x={0} y={0} width={shape.width} height={shape.height}
            filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
            {primitives.map(draw)}
          </filter>
        </svg>
      )}
    </span>
  );
}
