// The showcase setup (`--showcase`): one invented developer, Sam,
// and two machines, entirely hand-written; nothing from the recorded fixtures.
//
// - "Mac Studio" (macOS): storefront (a tab split in two, Apple Pay in Chat and
//   the flaky cart test in Terminal, plus the product page on its own), ios-app
//   (a tab of four: a Live Activity, dark receipts, the reorder widget, a crash
//   fix) and docs (the Apple Pay guide and an idle shell).
// - "gpu-box" (Linux): api (passkeys waiting on a permission dialog, a search
//   rate limit) and infra (a Postgres 17 plan, a nightly restore check).
//
// Each machine is a session snapshot in Herdr's wire JSON, answered by the
// demo's FixtureTransport through the real client, with its own transcripts
// (showcase-chat.ts), git (showcase-git.ts) and terminals (showcase-terminal.ts).

import type { DemoClock } from "../demo/demo-backend";
import { demoAgentSession, type DemoTranscript } from "../demo/demo-chat";
import type { DemoHost } from "../demo/demo-hosts";
import type { TerminalSink } from "../herdr/backend";
import type { TerminalDimensions } from "../herdr/terminal";
import type { TopologyPaneInfo } from "../herdr/wire";
import { showcaseFolders as folders, showcaseGpuTranscripts, showcaseHomes, showcasePaneIds as ids, showcaseStudioTranscripts } from "./showcase-chat";
import { showcaseGpuCommits, showcaseGpuGit, showcaseStudioCommits, showcaseStudioGit } from "./showcase-git";
import { claudeScene, codexScene, permissionScene, SceneTerminal, shellScene, type ClaudeItem, type ClaudeScript, type CodexScript, type Scene } from "./showcase-terminal";

type Json = Record<string, unknown>;

const minute = 60_000;

export const showcaseHostIds = { studio: "showcase-mac-studio", gpu: "showcase-gpu-box" } as const;

/** The hero: storefront's checkout tab, split in two (Chat left, Terminal right). */
export const showcaseHeroTab = { workspaceId: "w1", tabId: "w1:t1", chat: ids.applePay, terminal: ids.cart } as const;

/** ios-app's release tab: four panes, two in Chat and two in Terminal. */
export const showcaseFourTab = {
  workspaceId: "w2",
  tabId: "w2:t1",
  chats: [ids.liveActivity, ids.receipts],
  terminals: [ids.widget, ids.sheet],
} as const;

interface PaneSpec {
  readonly id: string;
  readonly tab: string;
  readonly label: string;
  readonly cwd: string;
  /** Null for a shell. */
  readonly agent: "claude" | "codex" | null;
  readonly status: "working" | "done" | "idle" | "blocked" | "unknown";
  readonly minutesAgo: number;
  readonly title: string;
}

interface WorkspaceSpec {
  readonly id: string;
  readonly label: string;
  readonly tabs: readonly { readonly id: string; readonly label: string }[];
}

const studioWorkspaces: readonly WorkspaceSpec[] = [
  { id: "w1", label: "storefront", tabs: [{ id: "w1:t1", label: "checkout" }, { id: "w1:t2", label: "product page" }] },
  { id: "w2", label: "ios-app", tabs: [{ id: "w2:t1", label: "release 3.2" }] },
  { id: "w3", label: "docs", tabs: [{ id: "w3:t1", label: "guides" }, { id: "w3:t2", label: "terminal" }] },
];

const studioPanes: readonly PaneSpec[] = [
  { id: ids.applePay, tab: "w1:t1", label: "Add Apple Pay", cwd: folders.applePay, agent: "claude", status: "working", minutesAgo: 3, title: "Merchant validation" },
  { id: ids.cart, tab: "w1:t1", label: "Fix the flaky cart test", cwd: folders.cart, agent: "claude", status: "working", minutesAgo: 1, title: "Running tests" },
  { id: ids.pdp, tab: "w1:t2", label: "Faster product page", cwd: folders.pdp, agent: "claude", status: "working", minutesAgo: 2, title: "Lazy reviews" },
  { id: ids.liveActivity, tab: "w2:t1", label: "Order Live Activity", cwd: folders.liveActivity, agent: "claude", status: "done", minutesAgo: 6, title: "Live Activity" },
  { id: ids.receipts, tab: "w2:t1", label: "Dark mode receipts", cwd: folders.receipts, agent: "codex", status: "working", minutesAgo: 4, title: "Dark colours" },
  { id: ids.widget, tab: "w2:t1", label: "Reorder widget", cwd: folders.widget, agent: "claude", status: "working", minutesAgo: 7, title: "Reorder intent" },
  { id: ids.sheet, tab: "w2:t1", label: "Cart sheet crash", cwd: folders.sheet, agent: "codex", status: "working", minutesAgo: 2, title: "Double close" },
  { id: ids.guide, tab: "w3:t1", label: "Apple Pay guide", cwd: folders.docs, agent: "claude", status: "done", minutesAgo: 17, title: "Help article" },
  { id: ids.docsShell, tab: "w3:t2", label: "", cwd: folders.docs, agent: null, status: "unknown", minutesAgo: 0, title: "zsh" },
];

const gpuWorkspaces: readonly WorkspaceSpec[] = [
  { id: "w1", label: "api", tabs: [{ id: "w1:t1", label: "passkeys" }, { id: "w1:t2", label: "search" }] },
  { id: "w2", label: "infra", tabs: [{ id: "w2:t1", label: "postgres" }, { id: "w2:t2", label: "backups" }] },
];

const gpuPanes: readonly PaneSpec[] = [
  { id: ids.passkeys, tab: "w1:t1", label: "Passkeys for sign in", cwd: folders.passkeys, agent: "claude", status: "blocked", minutesAgo: 2, title: "Migration" },
  { id: ids.rateLimit, tab: "w1:t2", label: "Rate limit search", cwd: folders.rateLimit, agent: "codex", status: "done", minutesAgo: 31, title: "Rate limit" },
  { id: ids.postgres, tab: "w2:t1", label: "Postgres 17 upgrade", cwd: folders.postgres, agent: "claude", status: "done", minutesAgo: 44, title: "Upgrade plan" },
  { id: ids.backups, tab: "w2:t2", label: "Restore check", cwd: folders.backups, agent: "codex", status: "idle", minutesAgo: 226, title: "Restore job" },
];

/** A workspace's or tab's rolled-up status, as Herdr reports it: what needs you wins. */
function rollUp(statuses: readonly string[]): string {
  for (const status of ["blocked", "working", "done", "idle"]) if (statuses.includes(status)) return status;
  return "unknown";
}

function snapshot(workspaces: readonly WorkspaceSpec[], panes: readonly PaneSpec[], transcripts: readonly DemoTranscript[], startMs: number, terminalPrefix: string): Json {
  const statusOf = (filter: (pane: PaneSpec) => boolean): string => rollUp(panes.filter(filter).map((pane) => pane.status));
  const first = panes[0]!;
  return {
    version: "0.9.5",
    protocol: 22,
    focused_workspace_id: workspaces[0]!.id,
    focused_tab_id: first.tab,
    focused_pane_id: first.id,
    workspaces: workspaces.map((workspace, index) => ({
      workspace_id: workspace.id,
      number: index + 1,
      label: workspace.label,
      focused: index === 0,
      pane_count: panes.filter((pane) => pane.tab.startsWith(workspace.id + ":")).length,
      tab_count: workspace.tabs.length,
      active_tab_id: workspace.tabs[0]!.id,
      agent_status: statusOf((pane) => pane.tab.startsWith(workspace.id + ":")),
    })),
    tabs: workspaces.flatMap((workspace, wIndex) =>
      workspace.tabs.map((tab, index) => ({
        tab_id: tab.id,
        workspace_id: workspace.id,
        number: index + 1,
        label: tab.label,
        focused: wIndex === 0 && index === 0,
        pane_count: panes.filter((pane) => pane.tab === tab.id).length,
        agent_status: statusOf((pane) => pane.tab === tab.id),
      })),
    ),
    panes: panes.map((pane, index) => ({
      pane_id: pane.id,
      terminal_id: `${terminalPrefix}-${index + 1}`,
      workspace_id: pane.tab.split(":")[0],
      tab_id: pane.tab,
      focused: index === 0,
      cwd: pane.cwd,
      foreground_cwd: pane.cwd,
      ...(pane.label === "" ? {} : { label: pane.label }),
      ...(pane.agent === null ? {} : { agent: pane.agent }),
      agent_status: pane.status,
      terminal_title_stripped: pane.title,
      revision: 2,
    })),
    layouts: [],
    agents: panes
      .filter((pane) => pane.agent !== null)
      .map((pane, index) => {
        const transcript = transcripts.find((candidate) => candidate.paneID === pane.id);
        return {
          pane_id: pane.id,
          name: pane.label,
          agent: pane.agent,
          agent_status: pane.status,
          cwd: pane.cwd,
          terminal_id: `${terminalPrefix}-${panes.indexOf(pane) + 1}`,
          terminal_title_stripped: pane.title,
          status_since_unix_ms: startMs - pane.minutesAgo * minute - index * 7_000,
          interactive_ready: true,
          ...(pane.status === "blocked" ? { input_pending: true, input_prompt_kind: "permission" } : {}),
          ...(transcript === undefined ? {} : { agent_session: demoAgentSession(transcript) }),
        };
      }),
  };
}

// MARK: terminals

const vitestRun = (run: number, total: number): string => ` ✓ test/cart/cart.test.ts (12 tests) ${31 + ((run * 13) % 17)}ms  ${"\u001b[38;2;133;133;133m"}run ${run}/${total}\u001b[0m`;

/** The hero's right tile: Claude Code fixing the flaky cart test, the suite running. */
function cartScene(): Scene {
  const history: ClaudeItem[] = [
    { at: -60_000, kind: "user", text: "cart.test.ts fails about one run in ten on CI. Find out why and fix it." },
    { at: -58_000, kind: "say", text: "I'll run the cart suite 20 times to catch the failure." },
    {
      at: -57_000,
      kind: "tool",
      name: "Bash",
      arg: "npx vitest run test/cart --repeat=20",
      every: 1,
      keep: 6,
      failed: true,
      lines: [
        " ✓ test/cart/totals.test.ts (14 tests) 41ms",
        " ✓ test/cart/coupons.test.ts (9 tests) 22ms",
        ...Array.from({ length: 18 }, (_, i) => vitestRun(i + 1, 20)),
        "\u001b[38;2;255;107;128m × test/cart/cart.test.ts > keeps the item count after a refresh\u001b[0m",
        "   → expected 2 to be 3",
        " Test Files  1 failed | 2 passed (3)",
        "      Tests  2 failed | 478 passed (480)",
      ],
    },
    { at: -30_000, kind: "say", text: "It fails 2 runs in 20. The test counts before the refresh has saved: addItem() never awaits refreshCart()." },
    { at: -28_000, kind: "read", file: "src/cart/store.ts", count: 140 },
    { at: -20_000, kind: "verb", verb: "Fixing" },
  ];
  const live: ClaudeItem[] = [
    {
      at: 1_200,
      kind: "edit",
      file: "src/cart/store.ts",
      diff: [
        [59, " ", "  async addItem(item: CartItem) {"],
        [60, " ", "    set({ items: [...get().items, item] });"],
        [61, "-", "    refreshCart();"],
        [61, "+", "    await refreshCart();"],
        [62, " ", "  },"],
      ],
    },
    {
      at: 3_600,
      kind: "edit",
      file: "test/cart/cart.test.ts",
      diff: [
        [32, " ", '  it("keeps the item count after a refresh", async () => {'],
        [33, " ", "    await cart.addItem(apron);"],
        [34, "-", "    await new Promise((r) => setTimeout(r, 20)); // wait for the refresh"],
        [34, " ", "    await cart.addItem(mug);"],
      ],
    },
    { at: 6_000, kind: "verb", verb: "Testing" },
    {
      at: 6_000,
      kind: "tool",
      name: "Bash",
      arg: "npx vitest run test/cart --repeat=50",
      every: 170,
      keep: 9,
      lines: [...Array.from({ length: 50 }, (_, i) => vitestRun(i + 1, 50)), "", " Test Files  3 passed (3)", "      Tests  1200 passed (1200)", "   Duration  9.31s"],
    },
    { at: 16_500, kind: "say", text: "50 of 50 runs pass. The test also slept 20 ms to hide the race; that's gone now. Running the whole suite before I commit." },
    { at: 18_000, kind: "verb", verb: "Running the suite" },
    {
      at: 18_000,
      kind: "tool",
      name: "Bash",
      arg: "npm test",
      every: 230,
      keep: 8,
      lines: [
        ...[
          "test/cart/cart.test.ts (12 tests) 38ms",
          "test/cart/totals.test.ts (14 tests) 41ms",
          "test/cart/coupons.test.ts (9 tests) 22ms",
          "test/checkout/methods.test.ts (9 tests) 30ms",
          "test/checkout/applePay.test.ts (6 tests) 24ms",
          "test/checkout/address.test.ts (21 tests) 64ms",
          "test/product/gallery.test.ts (11 tests) 52ms",
          "test/product/reviews.test.ts (8 tests) 47ms",
          "test/search/query.test.ts (33 tests) 88ms",
          "test/search/filters.test.ts (17 tests) 41ms",
          "test/account/orders.test.ts (19 tests) 73ms",
          "test/account/addresses.test.ts (12 tests) 35ms",
          "test/i18n/prices.test.ts (26 tests) 29ms",
          "test/i18n/dates.test.ts (14 tests) 18ms",
          "test/ui/button.test.tsx (10 tests) 61ms",
          "test/ui/sheet.test.tsx (15 tests) 112ms",
        ].map((line) => ` \u001b[38;2;78;186;101m✓\u001b[0m ${line}`),
        "",
        " Test Files  48 passed (48)",
        "      Tests  612 passed (612)",
      ],
    },
    { at: 24_500, kind: "say", text: "All 612 tests pass. Committing as “cart: await the refresh before counting”." },
    { at: 26_000, kind: "tool", name: "Bash", arg: 'git commit -am "cart: await the refresh before counting"', every: 300, lines: ["[fix/flaky-cart-test 2c81f0e] cart: await the refresh before counting", " 2 files changed, 1 insertion(+), 2 deletions(-)"] },
    { at: 28_000, kind: "verb", verb: "Writing the summary" },
  ];
  return claudeScene({ folder: "~/code/storefront-cart", items: [...history, ...live], working: true, loopMs: 40_000, tokens: 8.4 });
}

/** Reorder from the widget (Terminal in the four-pane tab): edits landing, a build. */
function widgetScene(): Scene {
  return claudeScene({
    folder: "~/code/ios-app-widget",
    working: true,
    loopMs: 30_000,
    tokens: 5.1,
    items: [
      { at: -60_000, kind: "user", text: "Let people reorder their last order from the Home Screen widget, with one tap and a confirmation in the app." },
      { at: -50_000, kind: "read", file: "ShopWidgets/LastOrderWidget.swift", count: 77 },
      { at: -40_000, kind: "say", text: "The widget can run an App Intent from its button. Adding a ReorderIntent that opens the app on the confirmation sheet." },
      { at: -30_000, kind: "verb", verb: "Editing" },
      {
        at: 1_000,
        kind: "edit",
        file: "ShopWidgets/LastOrderWidget.swift",
        diff: [
          [41, " ", "            Text(entry.order.summary)"],
          [42, " ", "                .font(.caption)"],
          [43, "-", "            Link(destination: entry.order.url) {"],
          [43, "+", "            Button(intent: ReorderIntent(order: entry.order)) {"],
          [44, " ", '                Label("Reorder", systemImage: "arrow.clockwise")'],
          [45, " ", "            }"],
          [46, "+", "            .buttonStyle(.borderedProminent)"],
        ],
      },
      { at: 5_000, kind: "verb", verb: "Building" },
      {
        at: 5_000,
        kind: "tool",
        name: "Bash",
        arg: "xcodebuild build -scheme ShopWidgets -quiet",
        every: 600,
        keep: 5,
        lines: ["CompileSwift ShopWidgets/LastOrderWidget.swift", "CompileSwift Shop/Intents/ReorderIntent.swift", "Ld ShopWidgets.appex", "CodeSign ShopWidgets.appex", "** BUILD SUCCEEDED **"],
      },
      { at: 9_500, kind: "say", text: "It builds. The widget's button now runs the intent; the app opens on the confirmation sheet with the last order filled in." },
      { at: 11_000, kind: "verb", verb: "Testing" },
      {
        at: 11_000,
        kind: "tool",
        name: "Bash",
        arg: "xcodebuild test -scheme Shop -only-testing:ShopTests/ReorderIntentTests -quiet",
        every: 700,
        keep: 6,
        lines: ["Test Case 'testReordersLastOrder' passed (0.081 seconds).", "Test Case 'testOpensConfirmation' passed (0.064 seconds).", "Test Case 'testEmptyHistory' passed (0.012 seconds).", "Executed 3 tests, with 0 failures", "** TEST SUCCEEDED **"],
      },
    ],
  });
}

/** The cart sheet crash (Codex in Terminal, four-pane tab): a test, a fix, the run. */
function sheetScene(): Scene {
  return codexScene({
    folder: "~/code/ios-app-sheet",
    working: true,
    loopMs: 32_000,
    items: [
      { at: -60_000, kind: "user", text: "Crash reports say the cart sheet crashes when it's dismissed twice quickly. Reproduce it in a test, then fix it." },
      { at: -55_000, kind: "explored", lines: ["Search dismiss in Shop/Cart", "Read CartSheet.swift, CartViewModel.swift"] },
      { at: -40_000, kind: "say", text: "dismiss() clears the checkout task and then awaits it, so a second call awaits a task that's already gone. A test first." },
      {
        at: 1_000,
        kind: "edited",
        file: "Shop/Cart/CartViewModel.swift",
        diff: [
          [91, " ", "    func dismiss() async {"],
          [92, "-", "        checkoutTask = nil"],
          [93, "-", "        await checkoutTask!.value"],
          [92, "+", "        guard let task = checkoutTask else { return }"],
          [93, "+", "        checkoutTask = nil"],
          [94, "+", "        await task.value"],
          [95, " ", "    }"],
        ],
      },
      {
        at: 4_000,
        kind: "ran",
        command: "xcodebuild test -scheme Shop -only-testing:ShopTests/CartSheetTests",
        every: 650,
        keep: 6,
        lines: [
          "Test Suite 'CartSheetTests' started",
          "Test Case 'testOpenShowsTotals' passed (0.044 seconds).",
          "Test Case 'testDismissOnce' passed (0.031 seconds).",
          "Test Case 'testDismissTwice' passed (0.029 seconds).",
          "Test Case 'testDismissWhilePaying' passed (0.052 seconds).",
          "Executed 4 tests, with 0 failures (0 unexpected)",
          "** TEST SUCCEEDED **",
        ],
      },
      { at: 10_000, kind: "say", text: "The double close no longer crashes; testDismissTwice failed before the change and passes now. Running the whole cart suite." },
      {
        at: 12_000,
        kind: "ran",
        command: "xcodebuild test -scheme Shop -only-testing:ShopTests/Cart",
        every: 800,
        keep: 6,
        lines: ["Test Suite 'Cart' started", "CartSheetTests: 4 passed", "CartViewModelTests: 18 passed", "CartTotalsTests: 11 passed", "Executed 33 tests, with 0 failures", "** TEST SUCCEEDED **"],
      },
    ],
  });
}

/** A Claude pane's screen when its Terminal is shown (the agents whose Chat is the story). */
function claudeSummary(folder: string, ask: string, steps: readonly ClaudeItem[], reply: string, working: boolean): Scene {
  const script: ClaudeScript = {
    folder,
    working,
    tokens: 3.2,
    items: [{ at: -60_000, kind: "user", text: ask }, ...steps.map((step) => ({ ...step, at: -50_000 })), { at: -10_000, kind: "say", text: reply }],
  };
  return claudeScene(script);
}

function codexSummary(folder: string, ask: string, ran: string, output: readonly string[], reply: string, working: boolean): Scene {
  const script: CodexScript = {
    folder,
    working,
    items: [
      { at: -60_000, kind: "user", text: ask },
      { at: -50_000, kind: "ran", command: ran, lines: output, every: 1 },
      { at: -10_000, kind: "say", text: reply },
    ],
  };
  return codexScene(script);
}

const passkeysBefore: ClaudeScript = {
  folder: "~/api",
  working: false,
  items: [
    { at: 0, kind: "user", text: "Add passkeys to sign in: register one from account settings, sign in with it, and keep passwords working alongside." },
    { at: 0, kind: "tool", name: "Write", arg: "src/auth/passkeys.ts", every: 1, lines: ["Wrote 64 lines to src/auth/passkeys.ts"] },
    { at: 0, kind: "tool", name: "Write", arg: "migrations/0042_add_passkeys.sql", every: 1, lines: ["Wrote 10 lines to migrations/0042_add_passkeys.sql"] },
    { at: 0, kind: "say", text: "Registration and sign-in are written; the passkeys table needs its migration before the tests can run. Applying it to the dev database." },
  ],
};

/** After the dialog is answered: the migration runs, then the tests. */
function passkeysAnswered(): Scene {
  return claudeScene({
    folder: "~/api",
    working: true,
    tokens: 6.3,
    items: [
      ...passkeysBefore.items.map((item) => ({ ...item, at: -60_000 })),
      { at: 0, kind: "verb", verb: "Migrating" },
      {
        at: 0,
        kind: "tool",
        name: "Bash",
        arg: "npm run db:migrate -- --name add_passkeys",
        every: 260,
        lines: ["> api@3.8.0 db:migrate", "> node scripts/migrate.mjs --name add_passkeys", "applying 0042_add_passkeys.sql", "  CREATE TABLE passkeys … ok", "  CREATE INDEX passkeys_user_id … ok", "done in 212 ms"],
      },
      { at: 2_600, kind: "say", text: "The table is in. Running the sign-in tests against it." },
      { at: 3_200, kind: "verb", verb: "Testing" },
      {
        at: 3_200,
        kind: "tool",
        name: "Bash",
        arg: "npm test -- src/auth",
        every: 450,
        keep: 7,
        lines: [" ✓ src/auth/password.test.ts (16 tests) 140ms", " ✓ src/auth/passkeys.test.ts (12 tests) 233ms", " ✓ src/auth/login.test.ts (21 tests) 188ms", "", " Test Files  3 passed (3)", "      Tests  49 passed (49)"],
      },
    ],
  });
}

const scenes = (): Readonly<Record<string, () => Scene>> => ({
  [ids.applePay]: () =>
    claudeSummary(
      "~/code/storefront",
      "Go ahead with merchant validation, and only show the button when canMakePayments() says yes.",
      [{ at: 0, kind: "read", file: "server/routes/payments.ts", count: 96 }, { at: 0, kind: "verb", verb: "Validating" }],
      "Adding a POST /payments/apple-pay/session route that forwards the validation URL to Apple.",
      true,
    ),
  [ids.cart]: cartScene,
  [ids.pdp]: () =>
    claudeSummary(
      "~/code/storefront-pdp",
      "Yes, do the reviews widget next. Load it when it scrolls into view.",
      [{ at: 0, kind: "read", file: "src/product/ProductPage.tsx", count: 88 }, { at: 0, kind: "verb", verb: "Measuring" }],
      "The widget is imported at the top of the page, so its 180 KB ship with the first load. Moving it behind a lazy import.",
      true,
    ),
  [ids.liveActivity]: () =>
    claudeSummary(
      "~/code/ios-app",
      "Show order tracking as a Live Activity: packed, shipped, out for delivery, delivered.",
      [{ at: 0, kind: "tool", name: "Bash", arg: "xcodebuild test -scheme Shop -only-testing:ShopTests/OrderActivityTests", every: 1, lines: ["Executed 7 tests, with 0 failures", "** TEST SUCCEEDED **"] }],
      "Order tracking is a Live Activity now. It starts when an order ships, and the push service moves it along. 7 tests pass.",
      false,
    ),
  [ids.receipts]: () =>
    codexSummary(
      "~/code/ios-app-receipts",
      "Receipts are unreadable in dark mode: white paper, light grey text. Use the app's semantic colours.",
      "rg -n 'Color\\.(white|gray)' Shop/Receipts",
      ["Shop/Receipts/ReceiptView.swift:22", "Shop/Receipts/ReceiptLineView.swift:14"],
      "Three hard-coded colours; moving them to ReceiptPaper and ReceiptInk with dark variants.",
      true,
    ),
  [ids.widget]: widgetScene,
  [ids.sheet]: sheetScene,
  [ids.guide]: () =>
    claudeSummary(
      "~/code/docs",
      "Start the help centre article for Apple Pay at checkout.",
      [{ at: 0, kind: "tool", name: "Write", arg: "guides/apple-pay.md", every: 1, lines: ["Wrote 64 lines to guides/apple-pay.md"] }],
      "The draft is in guides/apple-pay.md, in the same voice as the card article.",
      false,
    ),
  [ids.docsShell]: () =>
    shellScene("sam@Mac-Studio docs %", [
      ["git pull", ["Already up to date."]],
      ["npm run build", ["", "> docs@2.4.0 build", "> node scripts/build-docs.mjs", "", "  ✓ 48 pages built in 3.1s", "  ✓ search index: 1,206 entries", ""]],
      ["git status -s", ["A  guides/apple-pay.md"]],
    ]),
  [ids.passkeys]: () =>
    permissionScene({
      before: passkeysBefore,
      title: "Bash command",
      description: "Create the passkeys table in the dev database",
      command: "npm run db:migrate -- --name add_passkeys",
      always: "Yes, and don't ask again for npm run db:migrate commands in ~/api",
    }),
  [ids.rateLimit]: () =>
    codexSummary(
      "~/api-search",
      "Rate limit GET /search: 30 requests a minute per API key, 429 with Retry-After past that.",
      "npm test -- search",
      ["✓ test/search.test.ts (18 tests)", "✓ test/rate-limit.test.ts (7 tests)", "Tests  25 passed (25)"],
      "GET /search is limited to 30 requests a minute per key. Past that it answers 429 with Retry-After.",
      false,
    ),
  [ids.postgres]: () =>
    claudeSummary(
      "~/infra",
      "Plan the Postgres 15 to 17 upgrade for the shop database. Least downtime we can get, and a way back.",
      [{ at: 0, kind: "tool", name: "Write", arg: "docs/pg17-upgrade.md", every: 1, lines: ["Wrote 86 lines to docs/pg17-upgrade.md"] }],
      "The plan is in docs/pg17-upgrade.md: logical replication to a new 17 server, so the switch itself is about a minute.",
      false,
    ),
  [ids.backups]: () =>
    codexSummary(
      "~/infra-backups",
      "Write a nightly job that restores last night's backup into a scratch database and checks the row counts.",
      "bash jobs/restore-check.sh --dry-run",
      ["restore: shop-2026-11-02.dump → scratch_restore", "check: 42 tables, row counts within 0.1%", "ok"],
      "jobs/restore-check.sh restores into scratch_restore and compares row counts table by table. It runs at 03:30.",
      false,
    ),
});

/** Every scene the showcase's terminals can show (the guard test draws them). */
export function showcaseScenes(): Scene[] {
  return [...Object.values(scenes()).map((make) => make()), passkeysAnswered()];
}

/** A dialog's answer: Return, 1 or y. */
const answers = (data: Uint8Array): boolean => {
  const text = new TextDecoder().decode(data);
  return text.includes("\r") || text === "1" || text.toLowerCase() === "y";
};

/** The pane's agent moves on from its dialog: working, nothing pending, as Herdr would report it. */
export function answerDialog(snapshot: Json, paneId: string, nowMs: number): void {
  const list = (key: string): Json[] => (Array.isArray(snapshot[key]) ? (snapshot[key] as Json[]) : []);
  for (const agent of list("agents")) {
    if (agent["pane_id"] !== paneId) continue;
    agent["agent_status"] = "working";
    agent["status_since_unix_ms"] = nowMs;
    agent["terminal_title_stripped"] = "Migrating";
    delete agent["input_pending"];
    delete agent["input_prompt_kind"];
  }
  const pane = list("panes").find((candidate) => candidate["pane_id"] === paneId);
  if (pane === undefined) return;
  pane["agent_status"] = "working";
  pane["terminal_title_stripped"] = "Migrating";
  const statuses = (filter: (candidate: Json) => boolean): string => rollUp(list("panes").filter(filter).map((candidate) => String(candidate["agent_status"])));
  for (const tab of list("tabs")) if (tab["tab_id"] === pane["tab_id"]) tab["agent_status"] = statuses((candidate) => candidate["tab_id"] === pane["tab_id"]);
  for (const workspace of list("workspaces")) {
    if (workspace["workspace_id"] === pane["workspace_id"]) workspace["agent_status"] = statuses((candidate) => candidate["workspace_id"] === pane["workspace_id"]);
  }
}

function terminalFactory(snapshotJson: Json, now: () => number) {
  const made = scenes();
  return (pane: TopologyPaneInfo, size: TerminalDimensions, sink: TerminalSink, clock: DemoClock): SceneTerminal => {
    const scene = made[pane.paneID]?.() ?? shellScene(pane.cwd?.startsWith(showcaseHomes.gpu) === true ? "sam@gpu-box:~$" : "sam@Mac-Studio ~ %", []);
    const waiting = pane.paneID === ids.passkeys;
    const terminal = new SceneTerminal(scene, size.cols, size.rows, sink, clock, (data, self) => {
      const agent = (Array.isArray(snapshotJson["agents"]) ? (snapshotJson["agents"] as Json[]) : []).find((candidate) => candidate["pane_id"] === pane.paneID);
      if (!waiting || agent?.["input_pending"] !== true || !answers(data)) return;
      answerDialog(snapshotJson, pane.paneID, now());
      self.play(passkeysAnswered());
    });
    terminal.start();
    return terminal;
  };
}

/** The showcase's two machines, with times relative to `startMs`. */
export function showcaseHosts(startMs: number, now: () => number = Date.now): DemoHost[] {
  const studioTranscripts = showcaseStudioTranscripts(startMs);
  const gpuTranscripts = showcaseGpuTranscripts(startMs);
  const studio = snapshot(studioWorkspaces, studioPanes, studioTranscripts, startMs, "term-studio");
  const gpu = snapshot(gpuWorkspaces, gpuPanes, gpuTranscripts, startMs, "term-gpu");
  return [
    {
      descriptor: { id: showcaseHostIds.studio, name: "Mac Studio", kind: "demo", address: "showcase", platform: "macOS" },
      snapshot: studio,
      transcripts: studioTranscripts,
      git: showcaseStudioGit,
      commits: showcaseStudioCommits,
      home: showcaseHomes.studio,
      terminal: terminalFactory(studio, now),
    },
    {
      descriptor: { id: showcaseHostIds.gpu, name: "gpu-box", kind: "demo", address: "showcase", platform: "Linux" },
      snapshot: gpu,
      transcripts: gpuTranscripts,
      git: showcaseGpuGit,
      commits: showcaseGpuCommits,
      home: showcaseHomes.gpu,
      terminal: terminalFactory(gpu, now),
    },
  ];
}
