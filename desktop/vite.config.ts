import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

// The renderer: React + TypeScript, served to the window from the app's own
// protocol (src/main/protocol.ts), so every asset path is relative.
export default defineConfig({
  root: path.join(here, "src/renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.join(here, "dist/renderer"),
    emptyOutDir: true,
    target: "chrome140",
    sourcemap: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2048,
  },
  server: {
    // The fonts are read from the repo's App/Fonts (one copy for every app).
    fs: { allow: [path.join(here, ".."), here] },
  },
});
