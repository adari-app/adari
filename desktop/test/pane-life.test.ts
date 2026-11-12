// Pane life (App/CompanionPaneLife.swift) in the page: the arrivals and the
// connection generations a hand-off pick is bound to.

import { describe, expect, it } from "vitest";

import { PaneLife, type PaneLifeHost } from "../src/shared/pane-life";
import { paneTopology } from "./support/pane-topology";

const host = (panes: Parameters<typeof paneTopology>[0], state: PaneLifeHost["state"] = "connected", address = "r@mini:22"): PaneLifeHost => ({
  id: "mini",
  address,
  state,
  topology: paneTopology(panes),
});

describe("pane life's arrivals and connections", () => {
  it("counts an agent arriving in a pane once per arrival, a resume that keeps its session id included", () => {
    const life = new PaneLife();
    life.observeHosts([host([{ id: "p1", agent: "claude", session: "s-1" }])]);
    life.observeHosts([host([{ id: "p1", agent: "claude", session: "s-1" }])]);
    expect(life.arrival({ id: "mini", address: "r@mini:22" }, "p1")).toBe(1);
    life.observeHosts([host([{ id: "p1" }])]);
    life.observeHosts([host([{ id: "p1", agent: "claude", session: "s-1" }])]);
    expect(life.arrival({ id: "mini", address: "r@mini:22" }, "p1")).toBe(2);
    expect(life.arrival({ id: "mini", address: "r@mini:22" }, "p9")).toBe(0);
  });

  it("counts a connection each time the machine answers again", () => {
    const life = new PaneLife();
    expect(life.connection("mini")).toBe(0);
    life.observeHosts([host([], "connecting")]);
    expect(life.connection("mini")).toBe(0);
    life.observeHosts([host([])]);
    life.observeHosts([host([])]);
    expect(life.connection("mini")).toBe(1);
    expect(life.isLive("mini")).toBe(true);
    life.observeHosts([host([], "offline")]);
    expect(life.isLive("mini")).toBe(false);
    life.observeHosts([host([])]);
    expect(life.connection("mini")).toBe(2);
  });

  it("forgets a machine no longer listed, and a route the host was edited away from", () => {
    const life = new PaneLife();
    life.observeHosts([host([{ id: "p1", agent: "codex" }])]);
    life.observeHosts([host([{ id: "p1", agent: "codex" }], "connected", "r@other:22")]);
    expect(life.arrival({ id: "mini", address: "r@mini:22" }, "p1")).toBe(0);
    expect(life.arrival({ id: "mini", address: "r@other:22" }, "p1")).toBe(1);
    life.observeHosts([]);
    expect(life.arrival({ id: "mini", address: "r@other:22" }, "p1")).toBe(0);
    expect(life.connection("mini")).toBe(0);
  });
});
