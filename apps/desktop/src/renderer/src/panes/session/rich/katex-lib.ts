import katex from "katex";
// KaTeX's own stylesheet, imported from the package rather than vendored: it is the half of KaTeX
// that positions every glyph, it is versioned with the renderer that emits the markup, and the two
// drifting apart is what a fork of it would eventually cause. Vite emits the font files it
// references beside the bundle, so nothing here reaches the network at runtime. It rides in
// KaTeX's chunk, and Vite loads a chunk's CSS before the chunk resolves, so a formula is never
// drawn unstyled.
import "katex/dist/katex.min.css";

export default katex;
