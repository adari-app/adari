# Adari

**Built for Herdr.** Keep Herdr. Step out of the terminal.

Adari is a Mac app for [Herdr](https://herdr.dev): first-class Chat for Claude Code and Codex,
and the real terminal for every coding agent you run in Herdr, across all your Macs.

An iPhone and iPad app is coming soon. It is not released yet.

- **Chat** shows an agent's conversation as messages. You can answer its questions and approve
  its tools from a card, and send it new messages and images.
- **Terminal** is the pane itself, drawn by Ghostty.
- **The sidebar** lists every workspace, tab and pane on every Mac you add. Panes that need you
  come first.

Adari talks to Herdr directly: on this Mac, or over SSH to the Macs you add. There is no relay,
no account and no telemetry. The signed download checks GitHub for updates, which you can turn
off. Your passwords and keys stay in the Keychain on your Mac.

Adari is an independent project. It is not made or endorsed by Herdr, Inc.

## What you need

- A Mac running Herdr. Check it in Terminal with `herdr --version` and `herdr status server`.
  Adari 0.1.0 is for Herdr only. herdr-core comes after: its code is in 0.1.0, but it has not
  been tested against a live herdr-core.
- To reach another Mac, turn on Remote Login on it in System Settings → General → Sharing. Your
  Mac must be able to reach its address, for example on the same network or over a VPN such as
  Tailscale.

## Agents

Chat is first class for these agents. You read the conversation with its tools and thinking,
answer its questions and approvals from Chat, and pick the model and effort while the agent runs:

- Claude Code
- Codex

Chat is early for these agents. It reads their sessions, but it can miss things. Their Chat tab
and their row in New agent and Settings say **Early**:

- Grok Build
- Cursor Agent
- OpenCode
- Pi
- Oh My Pi
- Kilo Code CLI
- Gemini CLI (deprecated: Antigravity CLI is the agent for Google's models)
- Qwen Code
- Antigravity CLI (it becomes supported once it has been tested live)
- GitHub Copilot
- Factory Droid
- Kimi Code CLI
- Hermes Agent
- Mastra Code
- Cline

For Grok Build, Cursor Agent and OpenCode, Chat reads their sessions and the Model menu works on
a running agent, but they are not tested enough yet to promise.

Every other agent Herdr runs opens on its own screen: the agent's tab, which is the real
terminal. Its Chat tab says Chat doesn't read its sessions yet. These are:

- Amp
- Kiro CLI
- Muse Code
- Devin CLI
- Qoder CLI
- Letta Code
- Maki

Every agent Herdr runs works in the Terminal view, exactly as it does in Herdr. The terminal is
always exact, and it works with any pane, agent or shell.

### Known limitations

- **Amp has no Chat.** Amp keeps its threads on Amp's servers, not in files on your Mac. A
  running Amp also doesn't say which thread it is on. So Adari has nothing local to read. Amp
  works in its own tab. Chat for Amp can come if Amp offers a local thread file or Herdr
  reports the thread.

## Coming soon

- The iPhone and iPad app.
- herdr-core.
- Chat out of Early for more agents, starting with Grok Build, Cursor Agent and OpenCode.

## Install on the Mac

1. Download `Adari-<version>-arm64.dmg` from this repository's
   [Releases](../../releases) page. Builds are for Apple silicon. They are signed with a
   Developer ID and notarized by Apple.
2. Open the DMG and drag Adari to Applications.
3. Open Adari. Choose **Add a machine** and enter the Mac's address, your user name, and a
   password or SSH key. The first time you connect, Adari shows the Mac's host key and asks you
   to trust it. If the key ever changes, Adari will not connect until you check and accept it.

### Updates

The signed download updates itself from this repository's Releases. About 15 seconds after it
opens, and then every 4 minutes, it asks GitHub whether a newer version is out. When one is, a **Download**
button appears at the bottom of the sidebar. Nothing downloads or installs until you click it.
When the download is done the button reads **Restart**, and Adari asks before it quits and opens
the new version. Your agents keep running in Herdr while Adari restarts.

To check only when you ask, turn off **Check for updates automatically** in Settings › Updates and
use **Check for Updates…** in the Adari menu. A build you make yourself (below) is not signed, so
it does not update itself.

## Build the Mac app from source

The Mac app is in `desktop/`. It needs Node.js 22 or newer.

```bash
cd desktop
npm ci --ignore-scripts  # nothing native is built
npm run ensure:electron   # fetches the Electron binary for npm start
npm start                 # run in development
npm run dist:mac          # an unsigned DMG and zip in desktop/release/ (no updates)
```

`npm test`, `npm run typecheck` and `npm run lint` run the checks. There is more in
[desktop/README.md](desktop/README.md).

## Repository layout

```
desktop/      the Mac app (Electron, TypeScript, React)
App/          the fonts the Mac app bundles, with their licences
Sources/      the relay script, the source of desktop/src/main/herdr/relay-script.ts
scripts/      the script that writes relay-script.ts, and the fake Herdr its live test runs
Tests/        recorded screens and fixtures that the Mac app's tests compare against
```

The files outside `desktop/` are shared with the iPhone and iPad app and keep their paths.
The iPhone and iPad app's source comes with that app.

## Security

Please report security problems privately. Use GitHub's private vulnerability reporting, as
described in [SECURITY.md](SECURITY.md). Do not open a public issue.

## License and credits

Adari is licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Elysium Technologies.

Adari began as a fork of [Herdrup](https://github.com/themartianapp/herdrup), an Apache-2.0 iOS
client for Herdr. [NOTICE](NOTICE) lists what came from it. The terminal is drawn by Ghostty
through libghostty-spm. Third-party licences are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (the iPhone and iPad app's source) and
[desktop/THIRD_PARTY_NOTICES.md](desktop/THIRD_PARTY_NOTICES.md) (Mac app). Keep these notices
when you redistribute Adari.
