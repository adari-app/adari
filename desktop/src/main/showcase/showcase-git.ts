// The showcase's git: each agent's worktree as Changes reads it
// (branch, files changed, their diffs, commits) and the commits the away
// digest finds. Answered from memory by the demo's DemoGit and DemoRemote;
// invented content only.

import type { DemoGitData, DemoGitFolder } from "../demo/demo-git";
import type { DemoCommit } from "../demo/demo-remote";
import { showcaseFolders as folders } from "./showcase-chat";

type Diff = { readonly staged: string; readonly unstaged: string };

/** One file's diff as git prints it: a header, then hunks. */
function diff(path: string, hunks: readonly string[]): string {
  return [`diff --git a/${path} b/${path}`, "index 4b1e2c9..9f3a7d0 100644", `--- a/${path}`, `+++ b/${path}`, ...hunks, ""].join("\n");
}

function newFile(path: string, lines: readonly string[]): string {
  return [`diff --git a/${path} b/${path}`, "new file mode 100644", "index 0000000..5c2e8a1", "--- /dev/null", `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => "+" + line), ""].join("\n");
}

const unstaged = (text: string): Diff => ({ staged: "", unstaged: text });
const staged = (text: string): Diff => ({ staged: text, unstaged: "" });

/** "Add Apple Pay to checkout": the diff the Changes shot opens. */
const paymentSheet = diff("src/checkout/PaymentSheet.tsx", [
  "@@ -22,14 +22,24 @@ export function PaymentSheet({ order, methods }: PaymentSheetProps) {",
  "   const [method, setMethod] = useState<Method>(methods[0]);",
  "   const pay = usePay(order);",
  "+  const applePay = useCanMakePayments();",
  " ",
  "   return (",
  '     <Sheet title="Payment">',
  "+      {applePay && (",
  "+        <ApplePayButton",
  "+          onPay={() => pay(applePayRequest(order))}",
  '+          label="Pay with Apple Pay"',
  "+        />",
  "+      )}",
  "+      {applePay && <Divider>or pay by card</Divider>}",
  "       <MethodPicker",
  "-        methods={methods}",
  "+        methods={methods.filter((m) => m.id !== \"apple-pay\")}",
  "         value={method}",
  "         onChange={setMethod}",
  "       />",
  "-      <CardForm onSubmit={pay} />",
  "+      <CardForm onSubmit={pay} autoFocus={!applePay} />",
  "     </Sheet>",
  "   );",
  " }",
]);

const paymentsRoute = diff("server/routes/payments.ts", [
  "@@ -10,6 +10,18 @@ const router = Router();",
  ' router.post("/payments/intent", createIntent);',
  '+router.post("/payments/apple-pay/session", validateMerchant);',
  "+",
  "+async function validateMerchant(req: Request, res: Response) {",
  "+  const { validationURL } = req.body;",
  "+  if (!isAppleHost(validationURL)) return res.status(400).json({ error: \"bad validation URL\" });",
  "+  const session = await fetchWithCert(validationURL, {",
  "+    merchantIdentifier: config.applePay.merchantId,",
  "+    domainName: config.publicHost,",
  '+    displayName: "Your order",',
  "+  });",
  "+  res.json(session);",
  "+}",
]);

const cartStore = diff("src/cart/store.ts", [
  "@@ -58,7 +58,7 @@ export const cart = createStore((set, get) => ({",
  "   async addItem(item: CartItem) {",
  "     set({ items: [...get().items, item] });",
  "-    refreshCart();",
  "+    await refreshCart();",
  "   },",
]);

const cartTest = diff("test/cart/cart.test.ts", [
  "@@ -31,9 +31,8 @@ describe(\"cart\", () => {",
  '   it("keeps the item count after a refresh", async () => {',
  "     await cart.addItem(apron);",
  "-    await new Promise((r) => setTimeout(r, 20)); // wait for the refresh",
  "     await cart.addItem(mug);",
  "     await cart.refresh();",
  "     expect(cart.count()).toBe(3);",
  "   });",
]);

const gallery = diff("src/product/Gallery.tsx", [
  "@@ -15,7 +15,12 @@ export function Gallery({ images }: GalleryProps) {",
  "     <div className=\"gallery\">",
  "       {images.map((image, index) => (",
  "-        <img src={image.url} />",
  "+        <img",
  "+          src={image.url}",
  "+          srcSet={srcSet(image)}",
  '+          sizes="(max-width: 640px) 100vw, 50vw"',
  "+          width={image.width}",
  "+          height={image.height}",
  '+          loading={index === 0 ? "eager" : "lazy"}',
  "+        />",
  "       ))}",
]);

const productPage = diff("src/product/ProductPage.tsx", [
  "@@ -1,5 +1,6 @@",
  ' import { Gallery } from "./Gallery";',
  '-import { ReviewsWidget } from "./reviews/ReviewsWidget";',
  '+const ReviewsWidget = lazy(() => import("./reviews/ReviewsWidget"));',
  '+import { WhenVisible } from "./WhenVisible";',
]);

const receiptView = diff("Shop/Receipts/ReceiptView.swift", [
  "@@ -19,16 +19,16 @@ struct ReceiptView: View {",
  "         VStack(alignment: .leading, spacing: 12) {",
  "             header",
  "             ForEach(receipt.lines) { ReceiptLineView(line: $0) }",
  "         }",
  "         .padding(20)",
  "-        .background(Color.white)",
  '+        .background(Color("ReceiptPaper"))',
  "         .clipShape(.rect(cornerRadius: 14))",
  "         Text(receipt.footer)",
  "             .font(.footnote)",
  "-            .foregroundStyle(Color.gray)",
  '+            .foregroundStyle(Color("ReceiptInk"))',
]);

const widgetDiff = diff("ShopWidgets/LastOrderWidget.swift", [
  "@@ -40,7 +40,9 @@ struct LastOrderView: View {",
  "             Text(entry.order.summary)",
  "                 .font(.caption)",
  "-            Link(destination: entry.order.url) {",
  "+            Button(intent: ReorderIntent(order: entry.order)) {",
  '                 Label("Reorder", systemImage: "arrow.clockwise")',
  "             }",
  "+            .buttonStyle(.borderedProminent)",
  "+            .tint(.accentColor)",
]);

const passkeysMigration = newFile("migrations/0042_add_passkeys.sql", [
  "CREATE TABLE passkeys (",
  "  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),",
  "  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
  "  credential_id bytea NOT NULL UNIQUE,",
  "  public_key    bytea NOT NULL,",
  "  sign_count    bigint NOT NULL DEFAULT 0,",
  "  created_at    timestamptz NOT NULL DEFAULT now()",
  ");",
  "CREATE INDEX passkeys_user_id ON passkeys(user_id);",
]);

const passkeysTs = newFile("src/auth/passkeys.ts", [
  'import { generateRegistrationOptions, verifyRegistrationResponse } from "./webauthn";',
  "",
  "export async function startRegistration(user: User) {",
  "  const options = await generateRegistrationOptions({",
  '    rpName: "Shop",',
  "    userID: user.id,",
  "    userName: user.email,",
  "    excludeCredentials: await existingCredentials(user.id),",
  "  });",
  "  await saveChallenge(user.id, options.challenge);",
  "  return options;",
  "}",
]);

const guideDiff = newFile("guides/apple-pay.md", [
  "# Paying with Apple Pay",
  "",
  "On Safari and in the app you'll see **Pay with Apple Pay** above the card form.",
  "",
  "## If the button is missing",
  "",
  "- Add a card to Wallet on this device.",
  "- Use Safari, or the app on iPhone.",
]);

const pgPlan = diff("docs/pg17-upgrade.md", [
  "@@ -1,3 +1,14 @@",
  " # Postgres 17 upgrade",
  "+",
  "+Logical replication from 15 to a new 17 server; the switch is about a minute.",
  "+",
  "+1. Build the 17 replica, start logical replication (Mon)",
  "+2. Let it catch up, compare row counts (Mon to Wed)",
  "+3. Rehearse the switch on staging (Wed)",
  "+4. Pause writes, switch the app's URL (Thu 06:00, ~1 min)",
  "+5. Keep 15 replicating back for a week",
]);

/** A commit: hash, minutes before the showcase's start, subject, shortstat. */
type Commit = readonly [string, number, string, string];

function folder(branch: string, files: readonly (readonly [path: string, where: " M" | "M " | "??" | "A ", added: number, removed: number, diff: Diff])[], commits: readonly Commit[]): DemoGitFolder {
  return {
    branch,
    status: files.map(([path, where]) => `${where} ${path}\0`).join(""),
    unstaged: files
      .filter(([, where]) => where === " M")
      .map(([path, , added, removed]) => `${added}\t${removed}\t${path}\0`)
      .join(""),
    staged: files
      .filter(([, where]) => where === "M " || where === "A ")
      .map(([path, , added, removed]) => `${added}\t${removed}\t${path}\0`)
      .join(""),
    diffs: Object.fromEntries(files.filter(([, where]) => where !== "??").map(([path, , , , d]) => [path, d])),
    commits,
  };
}

const hash = (seed: string): string => (seed.repeat(8) + "0123456789abcdef".repeat(3)).slice(0, 40);

export const showcaseCommitHashes = {
  applePayMethods: hash("3e1a7c"),
  applePayRequest: hash("8b2f40"),
  pdpImages: hash("c47d19"),
  liveActivity: hash("5f0e2b"),
  liveActivityPush: hash("a913d6"),
  receiptsColors: hash("72c0e4"),
  guide: hash("d18b5a"),
  rateLimit: hash("6e3f97"),
  pgPlan: hash("19ad2c"),
  backups: hash("b05e81"),
} as const;

const h = showcaseCommitHashes;

const studioFolders: Readonly<Record<string, DemoGitFolder>> = {
  [folders.applePay]: folder(
    "feature/apple-pay",
    [
      ["src/checkout/PaymentSheet.tsx", " M", 10, 2, unstaged(paymentSheet)],
      ["server/routes/payments.ts", "M ", 12, 0, staged(paymentsRoute)],
      ["src/checkout/ApplePayButton.tsx", "??", 0, 0, unstaged("")],
    ],
    [
      [h.applePayRequest, 22, "checkout: build the Apple Pay payment request", " 3 files changed, 96 insertions(+), 4 deletions(-)"],
      [h.applePayMethods, 31, "checkout: Apple Pay as a payment method", " 2 files changed, 18 insertions(+), 2 deletions(-)"],
    ],
  ),
  [folders.cart]: folder(
    "fix/flaky-cart-test",
    [
      ["src/cart/store.ts", " M", 1, 1, unstaged(cartStore)],
      ["test/cart/cart.test.ts", " M", 0, 1, unstaged(cartTest)],
    ],
    [],
  ),
  [folders.pdp]: folder(
    "perf/product-page",
    [
      ["src/product/ProductPage.tsx", " M", 2, 1, unstaged(productPage)],
      ["src/product/WhenVisible.tsx", "??", 0, 0, unstaged("")],
    ],
    [[h.pdpImages, 19, "product page: responsive, lazy gallery images", " 2 files changed, 41 insertions(+), 6 deletions(-)"]],
  ),
  [folders.liveActivity]: folder(
    "feature/order-live-activity",
    [],
    [
      [h.liveActivityPush, 9, "orders: send the activity's push token to the API", " 2 files changed, 37 insertions(+)"],
      [h.liveActivity, 26, "orders: Live Activity for order tracking", " 6 files changed, 284 insertions(+), 3 deletions(-)"],
    ],
  ),
  [folders.receipts]: folder(
    "fix/dark-receipts",
    [["Shop/Receipts/ReceiptView.swift", " M", 2, 2, unstaged(receiptView)]],
    [[h.receiptsColors, 5, "receipts: ReceiptPaper and ReceiptInk colours with dark variants", " 3 files changed, 52 insertions(+), 4 deletions(-)"]],
  ),
  [folders.widget]: folder("feature/reorder-widget", [["ShopWidgets/LastOrderWidget.swift", " M", 3, 1, unstaged(widgetDiff)]], []),
  [folders.sheet]: folder("fix/cart-sheet-dismiss", [], []),
  [folders.docs]: folder(
    "guides/apple-pay",
    [["guides/apple-pay.md", "A ", 8, 0, staged(guideDiff)]],
    [[h.guide, 17, "guides: Apple Pay at checkout (draft)", " 1 file changed, 64 insertions(+)"]],
  ),
};

const gpuFolders: Readonly<Record<string, DemoGitFolder>> = {
  [folders.passkeys]: folder(
    "feature/passkeys",
    [
      ["src/auth/passkeys.ts", "A ", 12, 0, staged(passkeysTs)],
      ["migrations/0042_add_passkeys.sql", "??", 0, 0, unstaged("")],
    ],
    [],
  ),
  [folders.rateLimit]: folder(
    "feature/search-rate-limit",
    [],
    [[h.rateLimit, 36, "search: 30 requests a minute per API key", " 4 files changed, 118 insertions(+), 2 deletions(-)"]],
  ),
  [folders.postgres]: folder("plan/pg17", [["docs/pg17-upgrade.md", " M", 9, 0, unstaged(pgPlan)]], [[h.pgPlan, 44, "docs: Postgres 17 upgrade plan", " 1 file changed, 86 insertions(+)"]]),
  [folders.backups]: folder("main", [], [[h.backups, 230, "jobs: nightly restore check", " 2 files changed, 74 insertions(+)"]]),
};

const untracked: Readonly<Record<string, string>> = {
  "src/checkout/ApplePayButton.tsx": newFile("src/checkout/ApplePayButton.tsx", [
    "export function ApplePayButton({ onPay, label }: Props) {",
    "  return (",
    '    <button className="apple-pay" lang="en" onClick={onPay} aria-label={label}>',
    '      <span className="apple-pay-logo" aria-hidden="true" />',
    "    </button>",
    "  );",
    "}",
  ]),
  "src/product/WhenVisible.tsx": newFile("src/product/WhenVisible.tsx", [
    "export function WhenVisible({ children, margin = 200 }: Props) {",
    "  const [ref, visible] = useInView({ rootMargin: `${margin}px` });",
    "  return <div ref={ref}>{visible ? children : null}</div>;",
    "}",
  ]),
  "migrations/0042_add_passkeys.sql": passkeysMigration,
};

/** `git show` for a commit: its header, message, stat and the start of its patch. */
function show(commit: string, subject: string, stat: string, patch: string): string {
  return [`commit ${commit}`, "Author: Sam <sam@example.invalid>", "Date:   Tue Nov 3 09:12:00 2026 +0000", "", `    ${subject}`, "", "---", stat, "", patch].join("\n");
}

const shows: Readonly<Record<string, string>> = {
  [h.applePayRequest]: show(h.applePayRequest, "checkout: build the Apple Pay payment request", " 3 files changed, 96 insertions(+), 4 deletions(-)", paymentSheet),
  [h.pdpImages]: show(h.pdpImages, "product page: responsive, lazy gallery images", " 2 files changed, 41 insertions(+), 6 deletions(-)", gallery),
  [h.receiptsColors]: show(h.receiptsColors, "receipts: ReceiptPaper and ReceiptInk colours with dark variants", " 3 files changed, 52 insertions(+), 4 deletions(-)", receiptView),
};

function data(gitFolders: Readonly<Record<string, DemoGitFolder>>): DemoGitData {
  return {
    folders: gitFolders,
    shows,
    defaultShow: show(h.applePayMethods, "checkout: Apple Pay as a payment method", " 2 files changed, 18 insertions(+), 2 deletions(-)", paymentSheet),
    untracked,
    defaultUntracked: untracked["src/checkout/ApplePayButton.tsx"]!,
  };
}

export const showcaseStudioGit = data(studioFolders);
export const showcaseGpuGit = data(gpuFolders);

/** The away digest's commits (git log in each folder): the folders' own commits. */
function awayCommits(gitFolders: Readonly<Record<string, DemoGitFolder>>): Record<string, DemoCommit[]> {
  return Object.fromEntries(
    Object.entries(gitFolders).map(([path, entry]) => [path, entry.commits.map(([commit, minutesAgo, subject]) => ({ hash: commit, minutesAgo, subject }))]),
  );
}

export const showcaseStudioCommits = awayCommits(studioFolders);
export const showcaseGpuCommits = awayCommits(gpuFolders);

/** Every diff and show the showcase can open (the guard test reads them). */
export const showcaseGitTexts: readonly string[] = [
  paymentSheet,
  paymentsRoute,
  cartStore,
  cartTest,
  gallery,
  productPage,
  receiptView,
  widgetDiff,
  passkeysMigration,
  passkeysTs,
  guideDiff,
  pgPlan,
  ...Object.values(untracked),
  ...Object.values(shows),
];
