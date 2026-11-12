# Adari for Mac

The Mac app of Adari, built for [Herdr](https://herdr.dev): first-class Chat for Claude Code and
Codex, early Chat for [15 more agents](../README.md#agents), and the real terminal for every coding
agent you run in Herdr panes, on this Mac and on the Macs you add over SSH. Adari is an independent
project, not made or endorsed by Herdr, Inc.

## Use it

Download the signed, notarized DMG (Apple silicon) from the repository's Releases page, drag
Adari to Applications and open it. Then choose **Add a machine** and enter the Mac's address,
your user name, and a password or SSH key file. On that Mac, Herdr must be running, and Remote
Login (System Settings → General → Sharing) must be on.

- **First contact.** Adari shows the Mac's SSH host key the first time and asks you to trust it.
  A changed key stops the connection until you accept the new one.
- **Your secrets.** A password or key passphrase is encrypted with Electron's `safeStorage`
  (a key in your login Keychain) into `host-secrets.json` in the app's data folder, readable
  only by you (mode 0600). `hosts.json` never holds a secret. Adari reads a secret only in its
  main process, when it connects, and deletes it when you remove the machine.
- **Edit or remove a machine.** Right-click its header in the sidebar.
- **Updates.** The signed download from GitHub Releases updates itself: about 15 seconds after it
  opens, then every 4 minutes, it asks GitHub for a newer release (turn that off in Settings ›
  Updates; **Check for Updates…** still works). A **Download** button in the sidebar footer
  fetches it, then **Restart** asks before it installs. Nothing downloads or installs without a
  click. A build you make yourself is not signed and never checks (`src/main/updates.ts`).

## Build it

Needs Node.js 22 or newer. Run every command from this folder.

```bash
npm ci --ignore-scripts      # nothing native is built; ssh2 runs as plain JavaScript
npm run ensure:electron      # fetches the Electron binary for npm start (once)
npm start                    # build and run in development
npm run typecheck && npm run lint && npm test
```

Packages, each built into `release/` (ignored by git), with nothing published:

```bash
npm run dist:mac             # DMG and zip, arm64
npm run dist:linux           # AppImage and deb, x64
npm run dist:win             # NSIS installer, x64 (needs Windows, or Rosetta for makensis)
```

A plain `npm run dist:mac` is unsigned. To sign with a Developer ID and notarize it, set two
environment variables.

### Development builds only

`npm start` and `npm run build` include a demo: a fake Herdr made from the repository's
fixtures, with no network. `npm start -- --demo` opens it; `npm run demo` does the same.
Development builds also have flags for screenshots and timing probes. They are listed at the
top of `src/main/launch-options.ts`.

`npm run dist:*` builds leave the demo and those tools out. The build script sets a constant
that drops them, with their fixtures, from the bundle. The packaged app also ignores the flags.

## How it is built

The structure follows T3 Code's desktop app (MIT; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)):

- **The main process** (`src/main`) holds the connections. `herdr/` speaks Herdr's protocol
  over SSH (ssh2). Other folders hold Chat, the prompts, uploads, search and the saved machines.
- **The preload** (`src/preload`) is sandboxed and exposes a fixed, allowlisted bridge.
- **The renderer** (`src/renderer`) is React, served from the app's own scheme under a strict
  Content Security Policy. The terminal is ghostty-web.
- **Shared code** (`src/shared`) holds the types and the pure code both sides use.
- **Tests** are in `test` and run on Vitest. `fixtures` holds copies of the Swift app's test
  fixtures, kept identical by `test/fixtures-sync.test.ts`.

esbuild bundles the main process and the preload (`scripts/build.mjs`). Vite builds the
renderer. electron-builder makes the packages (`electron-builder.config.cjs`).

## License

Apache License 2.0, like the rest of the repository (see [../LICENSE](../LICENSE) and
[../NOTICE](../NOTICE)). The third-party code and fonts in this app, and their licences, are
listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). That file ships inside the app.
