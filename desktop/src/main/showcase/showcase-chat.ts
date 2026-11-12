// The showcase's Chat: hand-written transcripts for an invented
// developer, Sam, and the small shop the team builds (a storefront, its API,
// the iOS app, the docs, the servers). Every line is new and invented, in
// Claude Code's and Codex's line shapes, served through the demo's
// DemoTranscriptReader so the real parse, follow and search paths run. Nothing
// here comes from a recording. Times are relative to the showcase's start.
// Four agents are live: their transcripts take a step every few seconds from
// the first read, so their Chats stream while the captures are taken.

import { ClaudeLines, json, type DemoLive, type DemoTranscript, type Json } from "../demo/demo-chat";

/** The two machines' homes. */
export const showcaseHomes = { studio: "/Users/sam", gpu: "/home/sam" } as const;

/** Each agent's folder (its own worktree, as Sam keeps one per task). */
export const showcaseFolders = {
  applePay: "/Users/sam/code/storefront",
  cart: "/Users/sam/code/storefront-cart",
  pdp: "/Users/sam/code/storefront-pdp",
  liveActivity: "/Users/sam/code/ios-app",
  receipts: "/Users/sam/code/ios-app-receipts",
  widget: "/Users/sam/code/ios-app-widget",
  sheet: "/Users/sam/code/ios-app-sheet",
  docs: "/Users/sam/code/docs",
  passkeys: "/home/sam/api",
  rateLimit: "/home/sam/api-search",
  postgres: "/home/sam/infra",
  backups: "/home/sam/infra-backups",
} as const;

/** The panes, unique across both machines (the Changes overview's rows are keyed by pane). */
export const showcasePaneIds = {
  applePay: "w1:p1",
  cart: "w1:p2",
  pdp: "w1:p3",
  liveActivity: "w2:p4",
  receipts: "w2:p5",
  widget: "w2:p6",
  sheet: "w2:p7",
  guide: "w3:p8",
  docsShell: "w3:p9",
  passkeys: "w1:pC",
  rateLimit: "w1:pD",
  postgres: "w2:pE",
  backups: "w2:pF",
} as const;

const minute = 60_000;

const fence = (language: string, ...lines: string[]): string => ["```" + language, ...lines, "```"].join("\n");

const numbered = (count: number, text: (n: number) => string): string =>
  Array.from({ length: count }, (_, i) => `${String(i + 1).padStart(6)}→${text(i + 1)}`).join("\n");

const claudePath = (home: string, folder: string, sessionID: string): string =>
  `${home}/.claude/projects/${folder.replace(/[/.]/g, "-")}/${sessionID}.jsonl`;

const codexPath = (home: string, startMs: number, sessionID: string): string => {
  const day = new Date(startMs).toISOString().slice(0, 10);
  return `${home}/.codex/sessions/${day.replace(/-/g, "/")}/rollout-${day}T08-00-00-${sessionID}.jsonl`;
};

/** A live transcript's steps, `everyMs` apart, once through; each step's lines get uuids of their own. */
function claudeLive(sessionID: string, cwd: string, everyMs: number, steps: readonly ((t: ClaudeLines, index: number, pass: number) => void)[]): DemoLive {
  return {
    everyMs,
    step(index, atMs) {
      // Once through: after its last step the turn waits on its last command, as a real one would.
      const step = steps[index];
      if (step === undefined) return [];
      const t = new ClaudeLines(sessionID, cwd, atMs, `live-${sessionID.slice(0, 8)}-${index}`);
      step(t, index, 0);
      return t.lines;
    },
  };
}

const liveTool = (tag: string, index: number): string => `toolu_live_${tag}_${String(index).padStart(5, "0")}`;

// MARK: Mac Studio · storefront

/** "Add Apple Pay to checkout" (working, live): the hero's Chat. */
function applePay(startMs: number): DemoTranscript {
  const cwd = showcaseFolders.applePay;
  const sessionID = "3c9e51a2-0d4f-4b8e-a1c7-5a3d2f6e0101";
  const t = new ClaudeLines(sessionID, cwd, startMs - 41 * minute, "sc-ap");
  t.user("Add Apple Pay to checkout. Use the Payment Request API behind the PaymentSheet we have, and keep the card form as the fallback.", 0)
    .tool("toolu_ap_01", "Read", { file_path: `${cwd}/src/checkout/PaymentSheet.tsx` }, 4)
    .result("toolu_ap_01", numbered(182, (n) => (n === 24 ? "export function PaymentSheet({ order, methods }: PaymentSheetProps) {" : "…")), 5)
    .tool("toolu_ap_02", "Grep", { path: `${cwd}/src`, pattern: "paymentMethods" }, 9)
    .result("toolu_ap_02", "Found 3 files\nsrc/checkout/PaymentSheet.tsx\nsrc/checkout/methods.ts\nsrc/checkout/__tests__/methods.test.ts", 10)
    .progress("The sheet already takes a list of methods, so Apple Pay can be one more entry instead of a new screen.", 18)
    .tool("toolu_ap_03", "Write", { content: "export async function applePayRequest(order: Order) { … }", file_path: `${cwd}/src/checkout/applePay.ts` }, 44)
    .result("toolu_ap_03", "File created successfully at: src/checkout/applePay.ts", 45)
    .tool(
      "toolu_ap_04",
      "Edit",
      { file_path: `${cwd}/src/checkout/methods.ts`, new_string: "export const methods = [applePay, card] as const;", old_string: "export const methods = [card] as const;" },
      61,
    )
    .result("toolu_ap_04", "The file has been updated.", 62)
    .tool("toolu_ap_05", "Bash", { command: "npm test -- src/checkout", description: "Run the checkout tests" }, 70)
    .result("toolu_ap_05", " ✓ src/checkout/__tests__/methods.test.ts (9 tests) 31ms\n ✓ src/checkout/__tests__/applePay.test.ts (6 tests) 22ms\n\n Test Files  2 passed (2)\n      Tests  15 passed (15)", 74)
    .text(
      [
        "Apple Pay is in as one more method in `PaymentSheet`; the card form stays as it was, and it is still the first thing a customer without Wallet sees.",
        "",
        "The request it builds:",
        "",
        fence(
          "ts",
          "export function applePayRequest(order: Order): PaymentRequest {",
          "  return new PaymentRequest(",
          '    [{ supportedMethods: "https://apple.com/apple-pay", data: merchant }],',
          "    {",
          '      total: { label: "Your order", amount: { currency: "USD", value: order.total } },',
          "      displayItems: order.lines.map(toDisplayItem),",
          "    },",
          "  );",
          "}",
        ),
        "",
        "| Browser | Apple Pay | Fallback |",
        "| --- | :---: | --- |",
        "| Safari on Mac | ✓ | card form |",
        "| Safari on iPhone | ✓ | card form |",
        "| Chrome, Firefox | – | card form |",
        "",
        "Still to do: merchant validation on the server, then the button itself.",
      ].join("\n"),
      96,
      true,
    )
    .user("Go ahead with merchant validation, and only show the button when canMakePayments() says yes.", 38 * 60)
    .tool("toolu_ap_06", "Grep", { path: `${cwd}/server`, pattern: "merchant" }, 38 * 60 + 5)
    .result("toolu_ap_06", "Found 1 file\nserver/config/payments.ts", 38 * 60 + 6)
    .progress("Merchant validation has to happen server to server with the merchant certificate; the browser only passes the validation URL along.", 38 * 60 + 14)
    .tool("toolu_ap_07", "Read", { file_path: `${cwd}/server/routes/payments.ts` }, 38 * 60 + 20)
    .result("toolu_ap_07", numbered(96, (n) => (n === 12 ? 'router.post("/payments/intent", createIntent);' : "…")), 38 * 60 + 21);
  const tag = "ap";
  type Step = (l: ClaudeLines, index: number, pass: number) => void;
  const tool = (name: string, input: { [key: string]: Json }): Step => (l, i) => l.tool(liveTool(tag, i), name, input, 0);
  const result = (output: string): Step => (l, i) => l.result(liveTool(tag, i - 1), output, 0);
  const updated = result("The file has been updated.");
  const live = claudeLive(sessionID, cwd, 1_300, [
    // 1. The session route.
    (l) => l.progress("Adding a POST /payments/apple-pay/session route that forwards the validation URL to Apple.", 0),
    tool("Edit", {
      file_path: `${cwd}/server/routes/payments.ts`,
      new_string: 'router.post("/payments/intent", createIntent);\nrouter.post("/payments/apple-pay/session", validateMerchant);',
      old_string: 'router.post("/payments/intent", createIntent);',
    }),
    updated,
    tool("Bash", { command: "npm test -- server/payments", description: "Run the payment tests" }),
    result(" ✓ server/__tests__/payments.test.ts (11 tests) 184ms\n ✓ server/__tests__/merchant.test.ts (4 tests) 48ms\n\n Test Files  2 passed (2)\n      Tests  15 passed (15)"),
    (l) => l.text("The session route is in and its tests pass. Now the button: hidden unless `canMakePayments()` resolves to true.", 0),
    // 2. The button.
    tool("Read", { file_path: `${cwd}/src/checkout/ApplePayButton.tsx` }),
    result(numbered(38, (n) => (n === 7 ? "export function ApplePayButton({ onPay }: Props) {" : "…"))),
    (l) => l.progress("Checking once on mount and caching the answer, so the button never flickers in on a slow phone.", 0),
    tool("Edit", { file_path: `${cwd}/src/checkout/ApplePayButton.tsx`, new_string: "const available = useCanMakePayments();\nif (!available) return null;", old_string: "// TODO: hide when unavailable" }),
    updated,
    tool("Bash", { command: "npx playwright test checkout --project=webkit", description: "Run checkout in WebKit" }),
    result("Running 3 tests using 3 workers\n\n  ✓ checkout › pays with Apple Pay (simulated) (2.1s)\n  ✓ checkout › hides the button without Apple Pay (1.2s)\n  ✓ checkout › falls back to the card form (1.4s)\n\n  3 passed (4.7s)"),
    (l) => l.text("All three checkout paths pass in WebKit: Apple Pay when it's there, no button when it isn't, the card form either way. The domain file is next.", 0),
    // 3. The domain association file.
    (l) => l.progress("Apple checks a domain association file before it shows the sheet on the web; it has to be served from /.well-known/.", 0),
    tool("Bash", { command: "cp ~/Downloads/apple-developer-merchantid-domain-association public/.well-known/", description: "Add the domain file" }),
    result(""),
    tool("Bash", { command: "curl -sI http://localhost:4173/.well-known/apple-developer-merchantid-domain-association", description: "Check it is served" }),
    result("HTTP/1.1 200 OK\nContent-Type: text/plain\nContent-Length: 10342\nCache-Control: public, max-age=3600"),
    (l) => l.text("The domain file is served as plain text from `/.well-known/`. Last thing: what the customer sees when validation fails.", 0),
    // 4. The error path.
    tool("Edit", {
      file_path: `${cwd}/server/routes/payments.ts`,
      new_string: "  } catch (error) {\n    res.status(502).json({ error: \"apple_pay_unavailable\" });",
      old_string: "  } catch (error) {\n    throw error;",
    }),
    updated,
    tool("Bash", { command: "npm test -- server/payments src/checkout", description: "Run the payment and checkout tests" }),
    result(" ✓ server/__tests__/payments.test.ts (13 tests) 201ms\n ✓ server/__tests__/merchant.test.ts (6 tests) 52ms\n ✓ src/checkout/__tests__/applePay.test.ts (8 tests) 27ms\n\n Test Files  3 passed (3)\n      Tests  27 passed (27)"),
    (l) =>
      l.text(
        [
          "Merchant validation is done:",
          "",
          "- `POST /payments/apple-pay/session` asks Apple for the session with our certificate",
          "- the button shows only where `canMakePayments()` is true",
          "- a failed validation answers 502 and the card form opens, with “Apple Pay isn't available right now”",
          "",
          "27 tests pass. Opening the pull request next.",
        ].join("\n"),
        0,
      ),
    tool("Bash", { command: 'gh pr create --title "Apple Pay at checkout" --fill', description: "Open the pull request" }),
  ]);
  return { paneID: showcasePaneIds.applePay, agent: "claude", sessionID, path: claudePath(showcaseHomes.studio, cwd, sessionID), cwd, working: true, lines: t.lines, live };
}

/** "Fix the flaky cart test" (working): its Terminal is the hero's right tile; Chat has the same story. */
function cart(startMs: number): DemoTranscript {
  const cwd = showcaseFolders.cart;
  const sessionID = "3c9e51a2-0d4f-4b8e-a1c7-5a3d2f6e0102";
  const t = new ClaudeLines(sessionID, cwd, startMs - 6 * minute, "sc-cart");
  t.user("cart.test.ts fails about one run in ten on CI. Find out why and fix it.", 0)
    .tool("toolu_cart_01", "Bash", { command: "npx vitest run test/cart --repeat=20", description: "Run the cart tests 20 times" }, 6)
    .result(
      "toolu_cart_01",
      " ✓ test/cart/totals.test.ts (14 tests) 41ms\n ✓ test/cart/coupons.test.ts (9 tests) 22ms\n × test/cart/cart.test.ts > keeps the item count after a refresh\n   AssertionError: expected 2 to be 3\n\n Test Files  1 failed | 2 passed (3)\n      Tests  2 failed | 478 passed (480)",
      41,
      true,
    )
    .text("It fails 2 runs in 20. The test reads the count before the refresh has saved: `refreshCart()` is never awaited.", 52)
    .tool("toolu_cart_02", "Read", { file_path: `${cwd}/src/cart/store.ts` }, 55)
    .result("toolu_cart_02", numbered(140, (n) => (n === 61 ? "  refreshCart();" : "…")), 56)
    .tool("toolu_cart_03", "Edit", { file_path: `${cwd}/src/cart/store.ts`, new_string: "  await refreshCart();", old_string: "  refreshCart();" }, 80)
    .result("toolu_cart_03", "The file has been updated.", 81)
    .tool("toolu_cart_04", "Bash", { command: "npx vitest run test/cart --repeat=50", description: "Run the cart tests 50 times" }, 86);
  return { paneID: showcasePaneIds.cart, agent: "claude", sessionID, path: claudePath(showcaseHomes.studio, cwd, sessionID), cwd, working: true, lines: t.lines };
}

/** "Speed up the product page" (working, live): the Chat shot, mid-reply with tool rows. */
function pdp(startMs: number): DemoTranscript {
  const cwd = showcaseFolders.pdp;
  const sessionID = "3c9e51a2-0d4f-4b8e-a1c7-5a3d2f6e0103";
  const t = new ClaudeLines(sessionID, cwd, startMs - 27 * minute, "sc-pdp");
  t.user("The product page feels slow on phones. Measure it, then fix the worst of it.", 0)
    .tool("toolu_pdp_01", "Bash", { command: "npx lighthouse http://localhost:4173/p/linen-apron --preset=perf --form-factor=mobile --quiet", description: "Measure the product page" }, 5)
    .result("toolu_pdp_01", "Performance: 61\nLargest Contentful Paint: 4.1 s\nTotal Blocking Time: 410 ms\nCumulative Layout Shift: 0.18", 49)
    .tool("toolu_pdp_02", "Read", { file_path: `${cwd}/src/product/Gallery.tsx` }, 53)
    .result("toolu_pdp_02", numbered(121, (n) => (n === 18 ? "      <img src={image.url} />" : "…")), 54)
    .progress("Every gallery image loads at full size up front, and none has a width or height, so the page jumps as they arrive.", 60)
    .tool(
      "toolu_pdp_03",
      "Edit",
      {
        file_path: `${cwd}/src/product/Gallery.tsx`,
        new_string: '      <img src={image.url} srcSet={srcSet(image)} sizes="(max-width: 640px) 100vw, 50vw"\n           width={image.width} height={image.height} loading={index === 0 ? "eager" : "lazy"} />',
        old_string: "      <img src={image.url} />",
      },
      92,
    )
    .result("toolu_pdp_03", "The file has been updated.", 93)
    .tool("toolu_pdp_04", "Bash", { command: "npx lighthouse http://localhost:4173/p/linen-apron --preset=perf --form-factor=mobile --quiet", description: "Measure again" }, 101)
    .result("toolu_pdp_04", "Performance: 88\nLargest Contentful Paint: 2.0 s\nTotal Blocking Time: 240 ms\nCumulative Layout Shift: 0.01", 144)
    .text(
      [
        "The gallery was most of it. Images now come in the size the screen needs, below-the-fold ones lazily, and each has its box reserved:",
        "",
        fence(
          "tsx",
          "<img",
          "  src={image.url}",
          "  srcSet={srcSet(image)}            // 480w, 960w, 1440w",
          '  sizes="(max-width: 640px) 100vw, 50vw"',
          "  width={image.width}",
          "  height={image.height}             // no more layout shift",
          '  loading={index === 0 ? "eager" : "lazy"}',
          "/>",
        ),
        "",
        "| Mobile (Lighthouse) | Before | After |",
        "| --- | ---: | ---: |",
        "| Performance | 61 | 88 |",
        "| Largest Contentful Paint | 4.1 s | 2.0 s |",
        "| Total Blocking Time | 410 ms | 240 ms |",
        "| Layout shift | 0.18 | 0.01 |",
        "",
        "Blocking time is the review widget's script; that's next if you want it.",
      ].join("\n"),
      171,
      true,
    )
    .user("Yes, do the reviews widget next. Load it when it scrolls into view.", 24 * 60)
    .tool("toolu_pdp_05", "Grep", { path: `${cwd}/src`, pattern: "ReviewsWidget" }, 24 * 60 + 4)
    .result("toolu_pdp_05", "Found 2 files\nsrc/product/ProductPage.tsx\nsrc/product/reviews/ReviewsWidget.tsx", 24 * 60 + 5)
    .tool("toolu_pdp_06", "Read", { file_path: `${cwd}/src/product/ProductPage.tsx` }, 24 * 60 + 9)
    .result("toolu_pdp_06", numbered(88, (n) => (n === 3 ? 'import { ReviewsWidget } from "./reviews/ReviewsWidget";' : "…")), 24 * 60 + 10)
    .progress("The widget is imported at the top of the page, so its 180 KB ship with the first load. A lazy import behind an IntersectionObserver keeps it out until it's needed.", 24 * 60 + 21);
  const tag = "pdp";
  type Step = (l: ClaudeLines, index: number, pass: number) => void;
  const tool = (name: string, input: { [key: string]: Json }): Step => (l, i) => l.tool(liveTool(tag, i), name, input, 0);
  const result = (output: string): Step => (l, i) => l.result(liveTool(tag, i - 1), output, 0);
  const updated = result("The file has been updated.");
  const lighthouse = tool("Bash", { command: "npx lighthouse http://localhost:4173/p/linen-apron --preset=perf --form-factor=mobile --quiet", description: "Measure again" });
  const live = claudeLive(sessionID, cwd, 2_100, [
    // 1. The reviews widget, loaded when it comes into view.
    tool("Edit", {
      file_path: `${cwd}/src/product/ProductPage.tsx`,
      new_string: 'const ReviewsWidget = lazy(() => import("./reviews/ReviewsWidget"));',
      old_string: 'import { ReviewsWidget } from "./reviews/ReviewsWidget";',
    }),
    updated,
    tool("Write", { content: "export function WhenVisible({ children }: Props) { … }", file_path: `${cwd}/src/product/WhenVisible.tsx` }),
    result("File created successfully at: src/product/WhenVisible.tsx"),
    (l) => l.text("The widget now loads when its section is 200 px from view. Measuring again.", 0),
    lighthouse,
    result("Performance: 93\nLargest Contentful Paint: 1.9 s\nTotal Blocking Time: 90 ms\nCumulative Layout Shift: 0.01"),
    (l) => l.progress("Blocking time is down from 240 ms to 90. Next, the two web fonts that hold back the first paint.", 0),
    // 2. Fonts.
    tool("Read", { file_path: `${cwd}/src/styles/fonts.css` }),
    result(numbered(24, (n) => (n === 2 ? '  src: url("/fonts/Inter-var.woff2") format("woff2");' : "…"))),
    tool("Edit", { file_path: `${cwd}/src/styles/fonts.css`, new_string: "  font-display: swap;", old_string: "  font-display: block;" }),
    updated,
    tool("Edit", {
      file_path: `${cwd}/index.html`,
      new_string: '<link rel="preload" href="/fonts/Inter-var.woff2" as="font" type="font/woff2" crossorigin>',
      old_string: "<!-- fonts -->",
    }),
    updated,
    lighthouse,
    result("Performance: 95\nLargest Contentful Paint: 1.6 s\nTotal Blocking Time: 90 ms\nCumulative Layout Shift: 0.01"),
    (l) => l.text("Text paints at once now, in the fallback font for a moment. LCP is **1.6 s**. One more: the first gallery image should be fetched first.", 0),
    // 3. The first image's priority.
    tool("Edit", {
      file_path: `${cwd}/src/product/Gallery.tsx`,
      new_string: '          fetchPriority={index === 0 ? "high" : "auto"}',
      old_string: '          loading={index === 0 ? "eager" : "lazy"}',
    }),
    updated,
    tool("Bash", { command: "npm test -- src/product", description: "Run the product page tests" }),
    result(" ✓ src/product/__tests__/Gallery.test.tsx (11 tests) 52ms\n ✓ src/product/__tests__/ProductPage.test.tsx (14 tests) 96ms\n ✓ src/product/__tests__/WhenVisible.test.tsx (4 tests) 18ms\n\n Test Files  3 passed (3)\n      Tests  29 passed (29)"),
    lighthouse,
    result("Performance: 97\nLargest Contentful Paint: 1.3 s\nTotal Blocking Time: 80 ms\nCumulative Layout Shift: 0.01"),
    (l) =>
      l.text(
        [
          "| Mobile (Lighthouse) | Start | Now |",
          "| --- | ---: | ---: |",
          "| Performance | 61 | 97 |",
          "| Largest Contentful Paint | 4.1 s | 1.3 s |",
          "| Total Blocking Time | 410 ms | 80 ms |",
          "",
          "Committing the three changes separately so they're easy to review.",
        ].join("\n"),
        0,
      ),
    tool("Bash", { command: "git add -p && git commit -m 'product page: reviews widget on demand'", description: "Commit" }),
  ]);
  return { paneID: showcasePaneIds.pdp, agent: "claude", sessionID, path: claudePath(showcaseHomes.studio, cwd, sessionID), cwd, working: true, lines: t.lines, live };
}

// MARK: Mac Studio · ios-app

/** "Order tracking Live Activity" (done): a finished turn with Swift and a table. */
function liveActivity(startMs: number): DemoTranscript {
  const cwd = showcaseFolders.liveActivity;
  const sessionID = "3c9e51a2-0d4f-4b8e-a1c7-5a3d2f6e0104";
  const t = new ClaudeLines(sessionID, cwd, startMs - 34 * minute, "sc-la");
  t.user("Show order tracking as a Live Activity: packed, shipped, out for delivery, delivered. Updates come from our push service.", 0)
    .tool("toolu_la_01", "Glob", { pattern: "Shop/Orders/**/*.swift" }, 4)
    .result("toolu_la_01", "Shop/Orders/OrderStatus.swift\nShop/Orders/OrderDetailView.swift\nShop/Orders/OrdersStore.swift", 5)
    .tool("toolu_la_02", "Read", { file_path: `${cwd}/Shop/Orders/OrderStatus.swift` }, 8)
    .result("toolu_la_02", numbered(42, (n) => (n === 3 ? "enum OrderStatus: String, Codable { case packed, shipped, outForDelivery, delivered }" : "…")), 9)
    .tool("toolu_la_03", "Write", { content: "struct OrderActivityAttributes: ActivityAttributes { … }", file_path: `${cwd}/ShopWidgets/OrderActivity.swift` }, 66)
    .result("toolu_la_03", "File created successfully at: ShopWidgets/OrderActivity.swift", 67)
    .tool("toolu_la_04", "Bash", { command: "xcodebuild test -scheme Shop -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:ShopTests/OrderActivityTests -quiet", description: "Run the Live Activity tests" }, 140)
    .result("toolu_la_04", "Test Suite 'OrderActivityTests' passed.\n\t Executed 7 tests, with 0 failures (0 unexpected) in 0.412 seconds\n** TEST SUCCEEDED **", 236)
    .text(
      [
        "Order tracking is a Live Activity now. It starts when an order ships, and the push service moves it along: packed, shipped, out for delivery, delivered.",
        "",
        "7 tests pass. The push service needs the activity's token, so the app sends it to POST /orders/:id/activity-token.",
        "",
        "Once an order is delivered the activity stays for an hour, then clears itself from the Lock Screen.",
        "",
        "The attributes and the request:",
        "",
        fence(
          "swift",
          "struct OrderActivityAttributes: ActivityAttributes {",
          "    struct ContentState: Codable, Hashable {",
          "        var status: OrderStatus",
          "        var eta: Date?",
          "    }",
          "    let orderNumber: String",
          "}",
          "",
          "let activity = try Activity.request(",
          '    attributes: OrderActivityAttributes(orderNumber: order.number),',
          "    content: .init(state: .init(status: .shipped, eta: order.eta), staleDate: nil),",
          "    pushType: .token",
          ")",
        ),
        "",
        "| Status | Lock Screen | Dynamic Island |",
        "| --- | --- | --- |",
        "| Shipped | carrier and ETA | box icon |",
        "| Out for delivery | ETA countdown | truck and minutes |",
        "| Delivered | ends after 1 hour | – |",
        "",
        "On a phone without Live Activities the order page shows the same steps.",
      ].join("\n"),
      262,
      true,
    );
  return { paneID: showcasePaneIds.liveActivity, agent: "claude", sessionID, path: claudePath(showcaseHomes.studio, cwd, sessionID), cwd, working: false, lines: t.lines };
}

/** Writes Codex rollout lines for one session; `second` is seconds after `baseMs`. */
export class CodexLines {
  readonly lines: string[] = [];
  private ordinal: number;

  constructor(
    private readonly baseMs: number,
    private readonly idPrefix: string,
    firstOrdinal = 0,
  ) {
    this.ordinal = firstOrdinal;
  }

  stamp(second: number): string {
    return new Date(this.baseMs + second * 1_000).toISOString();
  }

  private line(type: string, payload: { [key: string]: Json }, second: number): this {
    this.lines.push(json({ ordinal: this.ordinal++, payload, timestamp: this.stamp(second), type }));
    return this;
  }

  meta(sessionID: string, cwd: string): this {
    this.line("session_meta", { cwd, id: sessionID, originator: "codex_cli_rs", source: "cli", timestamp: this.stamp(0) }, 0);
    // The model and effort its terminal shows (showcase-terminal.ts), as a rollout's turn_context carries them.
    return this.line("turn_context", { cwd, effort: "high", model: "gpt-5-codex" }, 0);
  }

  started(turn: string, second: number): this {
    return this.line("event_msg", { turn_id: turn, type: "task_started" }, second);
  }

  completed(turn: string, durationMs: number, second: number): this {
    // The turn's token count (for the context ring), fixed by the line's place in the session.
    this.line("event_msg", { info: { last_token_usage: { total_tokens: 61_000 + this.ordinal * 700 }, model_context_window: 272_000 }, type: "token_count" }, second);
    return this.line("event_msg", { duration_ms: durationMs, turn_id: turn, type: "task_complete" }, second);
  }

  user(text: string, second: number): this {
    return this.line("response_item", { content: [{ text, type: "input_text" }], id: `${this.idPrefix}-u${this.ordinal}`, role: "user", type: "message" }, second);
  }

  say(text: string, second: number): this {
    return this.line("response_item", { content: [{ text, type: "output_text" }], id: `${this.idPrefix}-a${this.ordinal}`, role: "assistant", type: "message" }, second);
  }

  /** A shell command (exec_command) and, when `output` is given, its result. */
  exec(call: string, command: string, second: number, output?: string, exitCode = 0, wallSeconds = 1.2): this {
    this.line("response_item", { arguments: json({ cmd: command }), call_id: call, id: `${this.idPrefix}-c${this.ordinal}`, name: "exec_command", type: "function_call" }, second);
    if (output !== undefined) this.output(call, output, second + wallSeconds, exitCode, wallSeconds);
    return this;
  }

  output(call: string, output: string, second: number, exitCode = 0, wallSeconds = 1.2): this {
    return this.line(
      "response_item",
      { call_id: call, id: `${this.idPrefix}-o${this.ordinal}`, output: `Exit code: ${exitCode}\nWall time: ${wallSeconds.toFixed(1)} seconds\nOutput:\n${output}`, type: "function_call_output" },
      second,
    );
  }

  /** An apply_patch call and its result. */
  patch(call: string, patch: string, file: string, second: number): this {
    this.line("response_item", { call_id: call, id: `${this.idPrefix}-p${this.ordinal}`, input: patch, name: "apply_patch", status: "completed", type: "custom_tool_call" }, second);
    return this.line(
      "response_item",
      { call_id: call, id: `${this.idPrefix}-q${this.ordinal}`, output: `Success. Updated the following files:\nM ${file}\n`, type: "custom_tool_call_output" },
      second + 1,
    );
  }
}

const receiptPatch = (file: string, before: string, after: string): string =>
  ["*** Begin Patch", `*** Update File: ${file}`, "@@", `-${before}`, `+${after}`, "*** End Patch"].join("\n");

/** "Dark mode for receipts" (Codex, working, live). */
function receipts(startMs: number): DemoTranscript {
  const cwd = showcaseFolders.receipts;
  const sessionID = "019a4e7c-2b11-7c40-8d2e-5a3d2f6e0105";
  const base = startMs - 12 * minute;
  const c = new CodexLines(base, "sc-rc");
  c.meta(sessionID, cwd)
    .started("turn-rc-1", 1)
    .user("Receipts are unreadable in dark mode: white paper, light grey text. Use the app's semantic colours and keep the PDF export light.", 1)
    .exec("call_rc_1", "rg -n 'Color\\.(white|gray)' Shop/Receipts", 4, "Shop/Receipts/ReceiptView.swift:22:        .background(Color.white)\nShop/Receipts/ReceiptView.swift:31:            .foregroundStyle(Color.gray)\nShop/Receipts/ReceiptLineView.swift:14:        .foregroundStyle(Color.gray)\n", 0, 0.4)
    .say("Three hard-coded colours. I'll move them to the asset catalogue's `ReceiptPaper` and `ReceiptInk`, with dark variants, and pin the PDF renderer to the light appearance.", 18)
    .patch("call_rc_2", receiptPatch("Shop/Receipts/ReceiptView.swift", "        .background(Color.white)", "        .background(Color(\"ReceiptPaper\"))"), "Shop/Receipts/ReceiptView.swift", 40)
    .patch("call_rc_3", receiptPatch("Shop/Receipts/ReceiptLineView.swift", "        .foregroundStyle(Color.gray)", "        .foregroundStyle(Color(\"ReceiptInk\"))"), "Shop/Receipts/ReceiptLineView.swift", 52);
  const steps: readonly ((l: CodexLines, call: string, previous: string) => void)[] = [
    // 1. The snapshots.
    (l, call) => l.exec(call, "xcodebuild test -scheme Shop -only-testing:ShopSnapshotTests/ReceiptSnapshotTests -quiet", 0),
    (l, _call, previous) => l.output(previous, "Test Suite 'ReceiptSnapshotTests' passed.\n\t Executed 8 tests, with 0 failures (0 unexpected) in 1.204 seconds\n** TEST SUCCEEDED **\n", 0, 0, 38.2),
    (l) => l.say("Snapshots pass in light and dark. Now the PDF export: it renders with the phone's appearance, so a dark phone made a dark PDF.", 0),
    // 2. The PDF stays light.
    (l, call) =>
      l.patch(call, receiptPatch("Shop/Receipts/ReceiptPDF.swift", "        let renderer = ImageRenderer(content: view)", "        let renderer = ImageRenderer(content: view.environment(\\.colorScheme, .light))"), "Shop/Receipts/ReceiptPDF.swift", 0),
    (l, call) => l.exec(call, "swift test --filter ReceiptPDFTests", 0, "Test Suite 'ReceiptPDFTests' passed.\n\t Executed 4 tests, with 0 failures (0 unexpected) in 0.231 seconds\n", 0, 6.8),
    (l) => l.say("The PDF stays light whatever the phone's setting. Checking the barcode keeps its white quiet zone on the dark paper.", 0),
    // 3. The barcode.
    (l, call) => l.exec(call, "rg -n 'BarcodeView' Shop/Receipts", 0, "Shop/Receipts/ReceiptView.swift:44:            BarcodeView(code: receipt.code)\n", 0, 0.3),
    (l, call) =>
      l.patch(call, receiptPatch("Shop/Receipts/ReceiptView.swift", "            BarcodeView(code: receipt.code)", "            BarcodeView(code: receipt.code).padding(8).background(.white, in: .rect(cornerRadius: 6))"), "Shop/Receipts/ReceiptView.swift", 0),
    (l, call) => l.exec(call, "xcodebuild test -scheme Shop -only-testing:ShopSnapshotTests/ReceiptSnapshotTests -quiet", 0),
    (l, _call, previous) => l.output(previous, "Test Suite 'ReceiptSnapshotTests' passed.\n\t Executed 10 tests, with 0 failures (0 unexpected) in 1.388 seconds\n** TEST SUCCEEDED **\n", 0, 0, 41.6),
    (l) => l.say("The barcode scans on dark paper too: it keeps a white box of its own. Last, the share sheet's preview.", 0),
    // 4. The share preview.
    (l, call) => l.exec(call, "rg -n 'ShareLink' Shop/Receipts", 0, "Shop/Receipts/ReceiptActions.swift:18:        ShareLink(item: receipt.pdfURL, preview: SharePreview(receipt.title))\n", 0, 0.2),
    (l) => l.say("The share preview uses the PDF, so it's already light. Nothing to change there. Running the whole receipts suite once more before I hand it back.", 0),
    (l, call) => l.exec(call, "xcodebuild test -scheme Shop -only-testing:ShopTests/Receipts -quiet", 0),
  ];
  const live: DemoLive = {
    everyMs: 2_400,
    step(index, atMs) {
      const step = steps[index];
      if (step === undefined) return [];
      const l = new CodexLines(atMs, `sc-rc-live-${index}`, 1_000 + index * 4);
      step(l, `call_rc_live_${index}`, `call_rc_live_${index - 1}`);
      return l.lines;
    },
  };
  return { paneID: showcasePaneIds.receipts, agent: "codex", sessionID, path: codexPath(showcaseHomes.studio, startMs, sessionID), cwd, working: true, lines: c.lines, live };
}

/** "Reorder from the widget" (working): its Terminal shows the edit. */
function widget(startMs: number): DemoTranscript {
  const cwd = showcaseFolders.widget;
  const sessionID = "3c9e51a2-0d4f-4b8e-a1c7-5a3d2f6e0106";
  const t = new ClaudeLines(sessionID, cwd, startMs - 9 * minute, "sc-wg");
  t.user("Let people reorder their last order from the Home Screen widget, with one tap and a confirmation in the app.", 0)
    .tool("toolu_wg_01", "Read", { file_path: `${cwd}/ShopWidgets/LastOrderWidget.swift` }, 5)
    .result("toolu_wg_01", numbered(77, () => "…"), 6)
    .text("The widget can run an App Intent from its button. I'll add a `ReorderIntent` that opens the app on the confirmation sheet.", 24)
    .tool("toolu_wg_02", "Write", { content: "struct ReorderIntent: AppIntent { … }", file_path: `${cwd}/Shop/Intents/ReorderIntent.swift` }, 70)
    .result("toolu_wg_02", "File created successfully at: Shop/Intents/ReorderIntent.swift", 71)
    .tool("toolu_wg_03", "Edit", { file_path: `${cwd}/ShopWidgets/LastOrderWidget.swift`, new_string: "Button(intent: ReorderIntent(order: entry.order)) {", old_string: "Link(destination: entry.order.url) {" }, 98);
  return { paneID: showcasePaneIds.widget, agent: "claude", sessionID, path: claudePath(showcaseHomes.studio, cwd, sessionID), cwd, working: true, lines: t.lines };
}

/** "Crash when the cart sheet closes twice" (Codex, working): its Terminal runs the tests. */
function sheet(startMs: number): DemoTranscript {
  const cwd = showcaseFolders.sheet;
  const sessionID = "019a4e7c-2b11-7c40-8d2e-5a3d2f6e0107";
  const c = new CodexLines(startMs - 4 * minute, "sc-sh");
  c.meta(sessionID, cwd)
    .started("turn-sh-1", 1)
    .user("Crash reports say the cart sheet crashes when it's dismissed twice quickly. Reproduce it in a test, then fix it.", 1)
    .exec("call_sh_1", "rg -n 'dismiss' Shop/Cart", 5, "Shop/Cart/CartSheet.swift:58:        viewModel.dismiss()\nShop/Cart/CartViewModel.swift:91:    func dismiss() {\n", 0, 0.3)
    .say("`dismiss()` clears the checkout task and then awaits it, so a second call awaits a task that's already gone. Writing a test that taps close twice first.", 22)
    .patch("call_sh_2", receiptPatch("ShopTests/CartSheetTests.swift", "    // MARK: dismissal", "    func testDismissTwice() async { await sut.dismiss(); await sut.dismiss() }"), "ShopTests/CartSheetTests.swift", 58)
    .exec("call_sh_3", "xcodebuild test -scheme Shop -only-testing:ShopTests/CartSheetTests -quiet", 64);
  return { paneID: showcasePaneIds.sheet, agent: "codex", sessionID, path: codexPath(showcaseHomes.studio, startMs, sessionID), cwd, working: true, lines: c.lines };
}

// MARK: Mac Studio · docs

/** "Write the Apple Pay guide" (done): the Send to… target. */
function guide(startMs: number): DemoTranscript {
  const cwd = showcaseFolders.docs;
  const sessionID = "3c9e51a2-0d4f-4b8e-a1c7-5a3d2f6e0108";
  const t = new ClaudeLines(sessionID, cwd, startMs - 29 * minute, "sc-gd");
  t.user("Start the help centre article for Apple Pay at checkout: what customers see, and what to do when the button doesn't show.", 0)
    .tool("toolu_gd_01", "Read", { file_path: `${cwd}/guides/paying-by-card.md` }, 4)
    .result("toolu_gd_01", numbered(64, () => "…"), 5)
    .tool("toolu_gd_02", "Write", { content: "# Paying with Apple Pay\n…", file_path: `${cwd}/guides/apple-pay.md` }, 48)
    .result("toolu_gd_02", "File created successfully at: guides/apple-pay.md", 49)
    .text(
      [
        "The draft is in guides/apple-pay.md, in the same voice as the card article. One open question: merchant validation may change what the error says, so I left a note where it goes.",
        "",
        "- What you'll see: the Apple Pay button above the card form, on Safari and in the app",
        "- If the button is missing: no card in Wallet, or a browser without Apple Pay",
        "- Refunds: back to the same card, 3 to 5 working days",
      ].join("\n"),
      71,
      true,
    );
  return { paneID: showcasePaneIds.guide, agent: "claude", sessionID, path: claudePath(showcaseHomes.studio, cwd, sessionID), cwd, working: false, lines: t.lines };
}

// MARK: gpu-box · api

/** "Passkeys for sign in" (needs you): its last call waits for a yes in the Terminal. */
function passkeys(startMs: number): DemoTranscript {
  const cwd = showcaseFolders.passkeys;
  const sessionID = "3c9e51a2-0d4f-4b8e-a1c7-5a3d2f6e0109";
  const t = new ClaudeLines(sessionID, cwd, startMs - 15 * minute, "sc-pk");
  t.user("Add passkeys to sign in: register one from account settings, sign in with it, and keep passwords working alongside.", 0)
    .tool("toolu_pk_01", "Grep", { path: `${cwd}/src/auth`, pattern: "verifyPassword" }, 4)
    .result("toolu_pk_01", "Found 2 files\nsrc/auth/login.ts\nsrc/auth/password.ts", 5)
    .tool("toolu_pk_02", "Write", { content: "export async function startRegistration(user: User) { … }", file_path: `${cwd}/src/auth/passkeys.ts` }, 61)
    .result("toolu_pk_02", "File created successfully at: src/auth/passkeys.ts", 62)
    .tool("toolu_pk_03", "Write", { content: "CREATE TABLE passkeys ( … );", file_path: `${cwd}/migrations/0042_add_passkeys.sql` }, 80)
    .result("toolu_pk_03", "File created successfully at: migrations/0042_add_passkeys.sql", 81)
    .text("Registration and sign-in are written; the passkeys table needs its migration before the tests can run. Applying it to the dev database.", 120)
    .tool("toolu_pk_04", "Bash", { command: "npm run db:migrate -- --name add_passkeys", description: "Create the passkeys table in the dev database" }, 124);
  return { paneID: showcasePaneIds.passkeys, agent: "claude", sessionID, path: claudePath(showcaseHomes.gpu, cwd, sessionID), cwd, working: false, lines: t.lines };
}

/** "Rate limit the search endpoint" (Codex, done). */
function rateLimit(startMs: number): DemoTranscript {
  const cwd = showcaseFolders.rateLimit;
  const sessionID = "019a4e7c-2b11-7c40-8d2e-5a3d2f6e0110";
  const c = new CodexLines(startMs - 52 * minute, "sc-rl");
  c.meta(sessionID, cwd)
    .started("turn-rl-1", 1)
    .user("Rate limit GET /search: 30 requests a minute per API key, 429 with Retry-After past that.", 1)
    .exec("call_rl_1", "rg -n 'router.get\\(\"/search' src", 4, 'src/routes/search.ts:9:router.get("/search", search);\n', 0, 0.2)
    .patch("call_rl_2", receiptPatch("src/routes/search.ts", 'router.get("/search", search);', 'router.get("/search", rateLimit({ perMinute: 30, key: apiKey }), search);'), "src/routes/search.ts", 40)
    .exec("call_rl_3", "npm test -- search", 61, " ✓ test/search.test.ts (18 tests) 302ms\n ✓ test/rate-limit.test.ts (7 tests) 1.1s\n\n Test Files  2 passed (2)\n      Tests  25 passed (25)\n", 0, 4.1)
    .say("GET /search is limited to 30 requests a minute per key, a sliding window in Redis. Past that it answers 429 with `Retry-After`; 25 tests pass, including the window's edges.", 80)
    .completed("turn-rl-1", 79_000, 80);
  return { paneID: showcasePaneIds.rateLimit, agent: "codex", sessionID, path: codexPath(showcaseHomes.gpu, startMs, sessionID), cwd, working: false, lines: c.lines };
}

// MARK: gpu-box · infra

/** "Postgres 17 upgrade plan" (done): a plan as a table. */
function postgres(startMs: number): DemoTranscript {
  const cwd = showcaseFolders.postgres;
  const sessionID = "3c9e51a2-0d4f-4b8e-a1c7-5a3d2f6e0111";
  const t = new ClaudeLines(sessionID, cwd, startMs - 63 * minute, "sc-pg");
  t.user("Plan the Postgres 15 to 17 upgrade for the shop database. Least downtime we can get, and a way back.", 0)
    .tool("toolu_pg_01", "Bash", { command: "psql \"$STAGING_URL\" -c 'select version()' -c '\\dx'", description: "Check the version and extensions" }, 5)
    .result("toolu_pg_01", " PostgreSQL 15.8 on x86_64-pc-linux-gnu\n\n   Name    | Version\n-----------+---------\n pg_trgm   | 1.6\n pgcrypto  | 1.3\n plpgsql   | 1.0", 6)
    .tool("toolu_pg_02", "Read", { file_path: `${cwd}/db/replication.tf` }, 10)
    .result("toolu_pg_02", numbered(58, () => "…"), 11)
    .tool("toolu_pg_03", "Write", { content: "# Postgres 17 upgrade\n…", file_path: `${cwd}/docs/pg17-upgrade.md` }, 140)
    .result("toolu_pg_03", "File created successfully at: docs/pg17-upgrade.md", 141)
    .text(
      [
        "The plan is in docs/pg17-upgrade.md: logical replication to a new 17 server, so the switch itself is about a minute, early Thursday and before the Apple Pay launch.",
        "",
        "The way back is the reverse replication: 15 keeps receiving every write for a week, so switching back is one URL.",
        "",
        "| Step | When | Downtime |",
        "| --- | --- | ---: |",
        "| Build the 17 replica, start logical replication | Mon | none |",
        "| Let it catch up, compare row counts | Mon to Wed | none |",
        "| Rehearse the switch on staging | Wed | none |",
        "| Pause writes, switch the app's URL | Thu 06:00 | ~1 min |",
        "| Keep 15 replicating back for a week | Thu to Thu | none |",
        "",
        "`pg_trgm` and `pgcrypto` both have 17 builds.",
      ].join("\n"),
      188,
      true,
    );
  return { paneID: showcasePaneIds.postgres, agent: "claude", sessionID, path: claudePath(showcaseHomes.gpu, cwd, sessionID), cwd, working: false, lines: t.lines };
}

/** "Nightly backup restore test" (Codex, idle): finished hours ago. */
function backups(startMs: number): DemoTranscript {
  const cwd = showcaseFolders.backups;
  const sessionID = "019a4e7c-2b11-7c40-8d2e-5a3d2f6e0112";
  const c = new CodexLines(startMs - 4 * 60 * minute, "sc-bk");
  c.meta(sessionID, cwd)
    .started("turn-bk-1", 1)
    .user("Write a nightly job that restores last night's backup into a scratch database and checks the row counts.", 1)
    .exec("call_bk_1", "ls jobs", 3, "rotate-logs.sh\nvacuum.sh\n", 0, 0.1)
    .patch("call_bk_2", ["*** Begin Patch", "*** Add File: jobs/restore-check.sh", "+#!/usr/bin/env bash", "+set -euo pipefail", "*** End Patch"].join("\n"), "jobs/restore-check.sh", 44)
    .exec("call_bk_3", "bash jobs/restore-check.sh --dry-run", 50, "restore: shop-2026-11-02.dump → scratch_restore\ncheck: 42 tables, row counts within 0.1%\nok\n", 0, 96.0)
    .say("`jobs/restore-check.sh` restores into `scratch_restore` and compares row counts table by table. A dry run passed; it's in the crontab for 03:30.", 150)
    .completed("turn-bk-1", 149_000, 150);
  return { paneID: showcasePaneIds.backups, agent: "codex", sessionID, path: codexPath(showcaseHomes.gpu, startMs, sessionID), cwd, working: false, lines: c.lines };
}

/** The Mac Studio's transcripts. */
export function showcaseStudioTranscripts(startMs: number): DemoTranscript[] {
  return [applePay(startMs), cart(startMs), pdp(startMs), liveActivity(startMs), receipts(startMs), widget(startMs), sheet(startMs), guide(startMs)];
}

/** The gpu-box's transcripts. */
export function showcaseGpuTranscripts(startMs: number): DemoTranscript[] {
  return [passkeys(startMs), rateLimit(startMs), postgres(startMs), backups(startMs)];
}

/** The reply Send to… carries in the captures: the Apple Pay agent's, to the docs agent. */
export const showcaseHandoffText = [
  "Merchant validation is in: the browser posts the validation URL to `POST /payments/apple-pay/session` and the server answers with Apple's session.",
  "",
  "For the guide: when validation fails the button now says “Apple Pay isn't available right now” and the card form opens.",
].join("\n");
