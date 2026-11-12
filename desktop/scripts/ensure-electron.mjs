// Electron 44 has no install script (T3 Code's note in pnpm-workspace.yaml), so
// `npm start` needs the Electron binary fetched once. Set ELECTRON_CACHE to keep
// the download cache somewhere other than the default.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("electron/install.js");
