import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@xterm/xterm/css/xterm.css";
// KaTeX's own stylesheet, imported from the package rather than vendored: it is the half of KaTeX
// that positions every glyph, it is versioned with the renderer that emits the markup, and the two
// drifting apart is what a fork of it would eventually cause. Vite emits the font files it
// references beside the bundle, so nothing here reaches the network at runtime.
import "katex/dist/katex.min.css";
// BUI foundation first (Tailwind layers + tokens); styles.css is unlayered and so wins conflicts.
import "./theme/tokens.css";
import "./styles.css";
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
