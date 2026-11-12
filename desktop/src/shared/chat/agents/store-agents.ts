// The agents whose sessions Chat reads from a store (stores.ts): Hermes
// (agents/hermes-*.ts), Mastra Code (agents/mastra-*.ts) and Cline (agents/cline-*.ts), by Herdr's kinds.
// Imports nothing, so the shared files that only skip them (Away, Changes, Search, the settings tap) stay light.

/** Herdr's kinds for the three (detect/mod.rs: "hermes", "mastracode", "cline"). */
export type StoreAgentFormat = "hermes" | "mastracode" | "cline";

export const storeAgentFormats: readonly StoreAgentFormat[] = ["hermes", "mastracode", "cline"];

export const isStoreAgentFormat = (value: string | null | undefined): value is StoreAgentFormat =>
  value === "hermes" || value === "mastracode" || value === "cline";
