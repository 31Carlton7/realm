import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@xterm/xterm/css/xterm.css";
// BUI foundation first (Tailwind layers + tokens); styles.css is unlayered and so wins conflicts.
import "./theme/tokens.css";
import "./styles.css";
import { enableSquircles } from "./theme/squircle";
import { preloadRichLibs } from "./panes/session/rich/rich-libs";
// Fire and forget: the cards render on their circular-corner fallback until the painter is ready,
// and stay there if it never loads. Nothing waits on a corner shape.
void enableSquircles();
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
// KaTeX and highlight.js are not in the boot chunk; they arrive once the first frame is out.
preloadRichLibs();
