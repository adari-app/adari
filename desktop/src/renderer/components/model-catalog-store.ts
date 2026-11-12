// The page's copy of each machine's model
// lists (main's src/main/model-catalogs.ts holds and reads them). A list is
// asked for when a picker or an Effort menu first needs it (load); main's
// changes (a read begun or ended) come in on one listener for the page's life.

import type { HerdrDesktopBridge, ModelCatalogChange } from "../../shared/ipc-contract";
import { builtInCatalog, catalogAgentNames, isCatalogView, type CatalogAgent, type CatalogView } from "../../shared/model-catalog";

type CatalogBridge = Pick<HerdrDesktopBridge, "modelCatalog" | "onModelCatalog">;

const keyOf = (hostId: string, agent: CatalogAgent): string => `${hostId}\u{0}${agent}`;

export class ModelCatalogStore {
  private readonly views = new Map<string, CatalogView>();
  private readonly asked = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private detach: (() => void) | null = null;

  constructor(private readonly bridge: () => CatalogBridge | undefined) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  version = (): number => this.revision;

  private changed(): void {
    this.revision += 1;
    for (const listener of Array.from(this.listeners)) listener();
  }

  /** The list as the page holds it (null: not asked for yet, or no answer yet). */
  view(hostId: string, agent: CatalogAgent): CatalogView | null {
    if (agent === "agy") return builtInCatalog("agy");
    return this.views.get(keyOf(hostId, agent)) ?? null;
  }

  /** Asks main for the list (each open of a picker: main answers from its cache and reads again behind when old). */
  load(hostId: string, agent: CatalogAgent): void {
    const bridge = this.bridge();
    if (agent === "agy" || bridge?.modelCatalog === undefined) return;
    this.listen(bridge);
    const key = keyOf(hostId, agent);
    this.asked.add(key);
    bridge.modelCatalog(hostId, agent).then(
      (view) => {
        if (isCatalogView(view)) this.set(hostId, view);
      },
      (failure: unknown) => {
        const reason = failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "it did not answer";
        this.set(hostId, { ...builtInCatalog(agent), ...this.views.get(key), loading: false, error: `Could not read ${catalogAgentNames[agent]}'s models: ${reason.replace(/\.$/, "")}.` });
      },
    );
  }

  /** A view main sent (an answer or a change). */
  set(hostId: string, view: CatalogView): void {
    this.views.set(keyOf(hostId, view.agent), view);
    this.changed();
  }

  private listen(bridge: CatalogBridge): void {
    if (this.detach !== null || bridge.onModelCatalog === undefined) return;
    this.detach = bridge.onModelCatalog((change: ModelCatalogChange) => {
      if (typeof change?.hostId !== "string" || !isCatalogView(change.view)) return;
      // Only lists this page asked for (another window's are its own).
      if (!this.asked.has(keyOf(change.hostId, change.view.agent))) return;
      this.set(change.hostId, change.view);
    });
  }

  /** Forgets everything (the tests start from it). */
  clear(): void {
    this.views.clear();
    this.asked.clear();
    this.detach?.();
    this.detach = null;
    this.changed();
  }
}

export const modelCatalogStore = new ModelCatalogStore(() => (typeof window === "undefined" ? undefined : window.herdrDesktop));
