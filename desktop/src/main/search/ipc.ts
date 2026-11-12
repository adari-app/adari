// "Search conversations" on the IPC surface (the contract's search channels):
// the page sends the query, "N more", "Try again" and its close; each window's
// results go back to it alone. The sender checks are ipc.ts's.

import { IPC } from "../../shared/ipc-contract";
import { on } from "../ipc";
import type { SearchService } from "./service";

/** Bounds on what the page may send. */
const maxQueryBytes = 4_096;
const maxIdLength = 256;

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= maxIdLength;

export function registerSearchIpc(search: SearchService): void {
  on(IPC.searchRun, (event, query) => {
    if (typeof query !== "string" || Buffer.byteLength(query) > maxQueryBytes) return;
    search.search(event.sender, query);
  });
  on(IPC.searchExpand, (event, macId, paneId) => {
    if (!isId(macId) || !isId(paneId)) return;
    search.expand(event.sender, macId, paneId);
  });
  on(IPC.searchRetry, (event, macId) => {
    if (!isId(macId)) return;
    search.retry(event.sender, macId);
  });
  on(IPC.searchClose, (event) => search.close(event.sender));
}
