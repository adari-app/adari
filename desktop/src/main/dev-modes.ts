// Everything the demo flags reach, in one module: the demo
// machines and their fixtures, the showcase, the captures (with This Mac's
// fake-herdr fixture) and the probes.
// main.ts loads it only when scripts/build.mjs builds with __ADARI_DEMO__ true
// (npm run build, npm start, npm run demo); `npm run dist:mac|win|linux` build
// with it false, so esbuild leaves this module, the demo and showcase code and
// the fixtures out of dist/main.

export {
  chipsEffortCaptureSteps,
  codexAskCaptureSteps,
  codexLiveCaptureSteps,
  cursorCaptureSteps,
  cursorChipsCaptureSteps,
  cursorLiveCaptureSteps,
  demoCaptureSteps,
  grokCaptureSteps,
  grokCardCaptureSteps,
  grokChipsCaptureSteps,
  hostKeyCaptureSteps,
  liveRowCaptureSteps,
  manageCaptureSteps,
  modesCaptureSteps,
  needsCardCaptureSteps,
  ringCaptureSteps,
  runCaptures,
  runningCaptureSteps,
  sendCaptureSteps,
  sidebarCaptureSteps,
  sidebarFoldedCaptureSteps,
  sidebarWidthCaptureSteps,
  settingsCaptureSteps,
  tallCardCaptureSteps,
  terminalDrawerCaptureSteps,
  thisMacCaptureSteps,
  updateMarkCaptureSteps,
} from "./capture";
// A dozen kinds, New agent's list, an Amp pane on its own screen (121-125).
export { agentsCaptureSteps } from "./agents-captures";
// The app's own updates (134-140), on a fake updater with no network.
export { updateCaptureSteps } from "./update-captures";
// The folder field's list, New workspace's machine picker and rows, New agent's Starts in (141-148).
export { folderPickCaptureSteps } from "./folder-pick-captures";
// New agent and New workspace on the demo Herdr's start quirks (149-154).
export { startFixCaptureSteps } from "./start-fix-captures";
// Settings › Chat's Codex note, and a Codex Chat from another folder or with no session (155-157).
export { codexSessionCaptureSteps } from "./codex-session-captures";
// Chat's no-session state naming Herdr's missing integration, Install, Settings' line, a no-session send (158-162).
export { integrationsCaptureSteps } from "./integrations-captures";
// A chat link under the mouse, a terminal URL with Cmd held, the Model chip and Send in the box (163-168).
export { linksChipsCaptureSteps } from "./links-chips-captures";
export { firstChatCaptureSteps } from "./first-chat-captures";
// /compact held while a monitor's turn runs (173), then compacted (174).
export { compactCapturePane, compactCaptureSteps } from "./compact-captures";
// A message waiting in Claude's queue (175), taken back by Esc (176).
export { takeBackCapturePane, takeBackCaptureSteps } from "./takeback-captures";
// Grok Build's, Cursor Agent's and Gemini CLI's own start questions as Needs you (177-180).
export { startQuestionCaptureSteps } from "./start-question-captures";
// The model pickers on Codex, Cursor and OpenCode, Codex's Effort for two models,
// New agent with a model and effort chosen, the new pane's chips before its first reply (181-187).
export { cursorPickCaptureSteps, pickersCaptureSteps, pickersCodexPane } from "./pickers-captures";
// The Model menu picking on Grok Build, Cursor Agent (families) and OpenCode (display names) (210-214).
export { livepickCaptureSteps } from "./livepick-captures";
// The Model menu's not-sent line, Grok's chip after a pick and its menu (220-222).
export { livefixCaptureSteps } from "./livefix-captures";
// Grok Build's Chat tab with Early, New agent's list, a Claude Code pane, Settings' start commands (230-233).
export { twotierCaptureSteps } from "./twotier-captures";
export { DemoClaudeQueue } from "./demo/demo-claude-queue";
// An early kind's pane with its Early badge and line, New agent's list, Settings, a split tile (190-196).
export { chatSupportCaptureSteps, chatSupportCaptureTargets } from "./chat-support-captures";
// The icons (201), Cursor's list from This Mac (202), Codex's update card (203), Claude's note (204).
export { listsCaptureSteps, listsCodexPane, listsCodexUpdateScreen } from "./lists-captures";
// The capture's fake-herdr This Mac (steps 99-100); This Mac itself (this-mac.ts) ships.
export { openThisMacFixture } from "./this-mac-fixture";
export { runFlickerProbe } from "./flicker-probe";
export { runLookProbe } from "./look-probe";
export { demoProbeScenarios, runFramesProbe } from "./frame-probe";
export { bundledDemoFixtures } from "./demo/bundled";
export { DemoBackend } from "./demo/demo-backend";
export { demoHostIds, demoHosts } from "./demo/demo-hosts";
export { newKeyBackend, newKeyHost } from "./demo/demo-new-key";
export { findFfmpeg, runShowcaseCapture, showcaseWindow } from "./showcase/showcase-capture";
export { showcaseHostIds, showcaseHosts } from "./showcase/showcase-hosts";
