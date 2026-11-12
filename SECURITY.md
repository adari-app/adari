# Security policy

## Reporting a vulnerability

Please report security problems privately, through GitHub's private vulnerability reporting:
open this repository's **Security** tab and choose **Report a vulnerability**. Only the
maintainers see the report. Please do not open a public issue, pull request or discussion about
it.

A useful report says what is affected (the Mac app, Adari.app with the bundle ID
`ai.adari.desktop`; the iPhone and iPad app, `ai.adari.app`; the notification helper,
`ai.adari.notification-helper`; or the source), which version or commit, how to reproduce it,
and what an attacker gains. We will reply in the report, keep you posted while we fix it, and credit you in the
release notes if you want.

## Supported versions

Security fixes go into the latest release and the `main` branch.

## In scope

- **SSH connections** in both apps: host-key checking and pinning, authentication, how saved
  passwords and keys are stored, and the SSH transport, including the iPhone and iPad app's
  vendored swift-nio-ssh fork.
- **Commands Adari builds** and runs over SSH, and keys it sends to Herdr panes. This includes
  text from a terminal, a transcript, a Git repository or a remote Mac that reaches a shell or
  a pane.
- **The Mac app's Electron surface**: renderer sandboxing, the preload bridge and IPC, the app's
  protocol, navigation and link opening, and content shown from transcripts.
- **The iPhone and iPad app**: Keychain and on-device storage, image attachments and uploads,
  the terminal (libghostty) as Adari uses it, and links in Chat.
- **The notification helper** (the launchd job `ai.adari.notification-helper`): pairing, APNs
  delivery and its state on the Mac, in `~/Library/Application Support/Adari Notifications`.
- **Release artifacts**: the signed and notarized DMG and zip on GitHub Releases
  (`Adari-0.1.0-arm64.dmg` and `Adari-0.1.0-arm64.zip` for 0.1.0).

## Out of scope

- Herdr itself (the server, its CLI and its socket). Report those to the Herdr project.
- The coding agents Adari shows (Claude Code, Codex, Grok, Cursor) and what they do in a pane.
- Problems in a third-party dependency that Adari's use does not expose. Please report those
  upstream. Tell us too if Adari is affected.
- Attacks that need an already-compromised Mac or device, or an SSH account you already control
  on the Mac you connect to.
- Builds you made yourself with changed code or signing.
