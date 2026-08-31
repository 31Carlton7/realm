import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@xterm/xterm/css/xterm.css";
// BUI foundation first (Tailwind layers + tokens); styles.css is unlayered and so wins conflicts.
import "./theme/tokens.css";
import "./styles.css";
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
