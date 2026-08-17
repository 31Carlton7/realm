import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
if (window.realm?.vibrancy) document.body.dataset.vibrancy = "1";
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
