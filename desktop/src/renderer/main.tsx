import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/markdown.css";
import "./styles/chat.css";
import "./styles/handoff.css";
import "./styles/changes.css";
import "./styles/away-search.css";
import "./styles/split.css";
import "./styles/terminal-drawer.css";
import "./styles/needs-card.css";
import "./styles/settings.css";

const root = document.getElementById("root");
if (!root) throw new Error("no #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
