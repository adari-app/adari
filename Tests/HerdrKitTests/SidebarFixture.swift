import Foundation
@testable import HerdrKit

/// A Herdr 0.9.5 server's `herdr workspace list` / `tab list` / `pane list`
/// replies, with every name, label, title and folder replaced by a made-up one.
/// The panes are trimmed to the fields the sidebar reads (scroll, terminal_title
/// and agent_session dropped); ids, numbers, counts, statuses and order are as
/// read. Statuses in the sample: done, idle, working, and one shell pane (w8:p1)
/// reporting unknown; no blocked pane.
enum SidebarFixture {
    static let workspacesJSON = #"""
[
{"active_tab_id":"w3:t1","agent_status":"done","focused":false,"label":"notes","number":1,"pane_count":1,"tab_count":1,"workspace_id":"w3"},
{"active_tab_id":"w2:t1","agent_status":"done","focused":false,"label":"Quartz","number":2,"pane_count":2,"tab_count":2,"workspace_id":"w2"},
{"active_tab_id":"w5:tH","agent_status":"done","focused":false,"label":"Atelier","number":3,"pane_count":2,"tab_count":2,"workspace_id":"w5"},
{"active_tab_id":"w6:t1","agent_status":"done","focused":false,"label":"Sundial","number":4,"pane_count":1,"tab_count":1,"workspace_id":"w6"},
{"active_tab_id":"w7:t1","agent_status":"done","focused":true,"label":"herdr-companion","number":5,"pane_count":3,"tab_count":2,"workspace_id":"w7"},
{"active_tab_id":"w8:t1","agent_status":"unknown","focused":false,"label":"Meterbox","number":6,"pane_count":1,"tab_count":1,"workspace_id":"w8"},
{"active_tab_id":"w9:t1","agent_status":"idle","focused":false,"label":"Inkwell","number":7,"pane_count":1,"tab_count":1,"workspace_id":"w9"},
{"active_tab_id":"wA:t6","agent_status":"idle","focused":false,"label":"Starling","number":8,"pane_count":4,"tab_count":2,"workspace_id":"wA"},
{"active_tab_id":"wB:t1","agent_status":"idle","focused":false,"label":"Bellhop","number":9,"pane_count":1,"tab_count":1,"workspace_id":"wB"},
{"active_tab_id":"wC:t1","agent_status":"idle","focused":false,"label":"Harbor","number":10,"pane_count":1,"tab_count":1,"workspace_id":"wC"},
{"active_tab_id":"wD:t6","agent_status":"idle","focused":false,"label":"Tidepool","number":11,"pane_count":2,"tab_count":2,"workspace_id":"wD"}
]
"""#

    static let tabsJSON = #"""
[
{"agent_status":"done","focused":false,"label":"Workbench","number":1,"pane_count":1,"tab_id":"w3:t1","workspace_id":"w3"},
{"agent_status":"done","focused":false,"label":"Notes Fable","number":1,"pane_count":1,"tab_id":"w2:t1","workspace_id":"w2"},
{"agent_status":"idle","focused":false,"label":"Notes Opus","number":72,"pane_count":1,"tab_id":"w2:t28","workspace_id":"w2"},
{"agent_status":"done","focused":false,"label":"Atelier Desk","number":1,"pane_count":1,"tab_id":"w5:t1","workspace_id":"w5"},
{"agent_status":"idle","focused":false,"label":"2","number":17,"pane_count":1,"tab_id":"w5:tH","workspace_id":"w5"},
{"agent_status":"done","focused":false,"label":"Desk","number":1,"pane_count":1,"tab_id":"w6:t1","workspace_id":"w6"},
{"agent_status":"working","focused":true,"label":"Dev","number":1,"pane_count":1,"tab_id":"w7:t1","workspace_id":"w7"},
{"agent_status":"done","focused":false,"label":"workers 1","number":19,"pane_count":2,"tab_id":"w7:tK","workspace_id":"w7"},
{"agent_status":"unknown","focused":false,"label":"Notes","number":1,"pane_count":1,"tab_id":"w8:t1","workspace_id":"w8"},
{"agent_status":"idle","focused":false,"label":"Dev","number":1,"pane_count":1,"tab_id":"w9:t1","workspace_id":"w9"},
{"agent_status":"idle","focused":false,"label":"Desk","number":1,"pane_count":1,"tab_id":"wA:t1","workspace_id":"wA"},
{"agent_status":"idle","focused":false,"label":"workers 1","number":6,"pane_count":3,"tab_id":"wA:t6","workspace_id":"wA"},
{"agent_status":"idle","focused":false,"label":"Dev","number":1,"pane_count":1,"tab_id":"wB:t1","workspace_id":"wB"},
{"agent_status":"idle","focused":false,"label":"Workbench","number":1,"pane_count":1,"tab_id":"wC:t1","workspace_id":"wC"},
{"agent_status":"idle","focused":false,"label":"Workbench","number":1,"pane_count":1,"tab_id":"wD:t1","workspace_id":"wD"},
{"agent_status":"idle","focused":false,"label":"workers 5","number":6,"pane_count":1,"tab_id":"wD:t6","workspace_id":"wD"}
]
"""#

    static let panesJSON = #"""
[
{"pane_id":"w3:p1","terminal_id":"term_65efccd8ecce21","workspace_id":"w3","tab_id":"w3:t1","focused":false,"agent_status":"done","revision":5,"cwd":"/Users/demo/code/notes","foreground_cwd":"/Users/demo/code/notes","label":"Workbench","agent":"claude","terminal_title_stripped":"Notes status"},
{"pane_id":"w2:p1","terminal_id":"term_65efccd8ed7532","workspace_id":"w2","tab_id":"w2:t1","focused":false,"agent_status":"done","revision":5,"cwd":"/Users/demo/code/quartz","foreground_cwd":"/Users/demo/code/quartz","agent":"claude","terminal_title_stripped":"Quartz 2.2.10 release"},
{"pane_id":"w2:p70","terminal_id":"term_65efccd8edfdb3","workspace_id":"w2","tab_id":"w2:t28","focused":false,"agent_status":"idle","revision":1,"cwd":"/Users/demo/code/quartz","foreground_cwd":"/Users/demo/code/quartz","agent":"claude","terminal_title_stripped":"Quartz sync retry rollout"},
{"pane_id":"w5:p1","terminal_id":"term_65efccd903ca46","workspace_id":"w5","tab_id":"w5:t1","focused":false,"agent_status":"done","revision":1,"cwd":"/Users/demo/code/atelier","foreground_cwd":"/Users/demo/code/atelier","agent":"claude","terminal_title_stripped":"Weekly planning review"},
{"pane_id":"w5:pH","terminal_id":"term_65f0e1f0c4aeb1b","workspace_id":"w5","tab_id":"w5:tH","focused":false,"agent_status":"idle","revision":7,"cwd":"/Users/demo/code/atelier","foreground_cwd":"/Users/demo/code/atelier","agent":"codex","terminal_title_stripped":"Check Qwen and DeepSeek options | Atelier"},
{"pane_id":"w6:p1","terminal_id":"term_65efccd90435f7","workspace_id":"w6","tab_id":"w6:t1","focused":false,"agent_status":"done","revision":3,"cwd":"/Users/demo/code/sundial","foreground_cwd":"/Users/demo/code/sundial","agent":"claude","terminal_title_stripped":"Sundial status review"},
{"pane_id":"w7:p1","terminal_id":"term_65efccd90520f9","workspace_id":"w7","tab_id":"w7:t1","focused":true,"agent_status":"working","revision":2,"cwd":"/Users/demo/code/herdr-companion","foreground_cwd":"/Users/demo/code/herdr-companion","agent":"claude","terminal_title_stripped":"Adari Mac app build 0.1.0"},
{"pane_id":"w7:p1G","terminal_id":"term_65f2a36bc66512a","workspace_id":"w7","tab_id":"w7:tK","focused":false,"agent_status":"working","revision":1,"cwd":"/Users/demo/code/worktrees/aurora-web-mac","foreground_cwd":"/Users/demo/code/worktrees/aurora-web-mac","label":"aurora-web-mac · opus","agent":"claude","terminal_title_stripped":"aurora-web-mac"},
{"pane_id":"w7:p1H","terminal_id":"term_65f2a5c3c812a2b","workspace_id":"w7","tab_id":"w7:tK","focused":false,"agent_status":"done","revision":1,"cwd":"/Users/demo/code/worktrees/aurora-web-design","foreground_cwd":"/Users/demo/code/worktrees/aurora-web-design","label":"aurora-web-design-system-refresh · opus","agent":"claude","terminal_title_stripped":"aurora-web-design"},
{"pane_id":"w8:p1","terminal_id":"term_65efccd905abfa","workspace_id":"w8","tab_id":"w8:t1","focused":false,"agent_status":"unknown","revision":0,"cwd":"/Users/demo/code/meterbox","foreground_cwd":"/Users/demo/code/meterbox"},
{"pane_id":"w9:p1","terminal_id":"term_65efccd9061f6b","workspace_id":"w9","tab_id":"w9:t1","focused":false,"agent_status":"idle","revision":1,"cwd":"/Users/demo/code/inkwell","foreground_cwd":"/Users/demo/code/inkwell","agent":"claude","terminal_title_stripped":"Inkwell market review"},
{"pane_id":"wA:p1","terminal_id":"term_65efccd9069f4c","workspace_id":"wA","tab_id":"wA:t1","focused":false,"agent_status":"idle","revision":1,"cwd":"/Users/demo/code/lumen","foreground_cwd":"/Users/demo/code/lumen","agent":"claude","terminal_title_stripped":"Lumen project status"},
{"pane_id":"wA:pJ","terminal_id":"term_65efccd9073eed","workspace_id":"wA","tab_id":"wA:t6","focused":false,"agent_status":"idle","revision":1,"cwd":"/Users/demo/code/worktrees/lumen-memory","foreground_cwd":"/Users/demo/code/worktrees/lumen-memory","label":"lumen-memory · opus","agent":"claude","terminal_title_stripped":"lumen-memory"},
{"pane_id":"wA:pM","terminal_id":"term_65efccd907e8fe","workspace_id":"wA","tab_id":"wA:t6","focused":false,"agent_status":"idle","revision":1,"cwd":"/Users/demo/code/worktrees/lumen-onboarding-perf","foreground_cwd":"/Users/demo/code/worktrees/lumen-onboarding-perf","label":"lumen-onboarding-perf · codex","agent":"codex","terminal_title_stripped":"lumen-onboarding..."},
{"pane_id":"wA:pK","terminal_id":"term_65efccd9089f0f","workspace_id":"wA","tab_id":"wA:t6","focused":false,"agent_status":"idle","revision":1,"cwd":"/Users/demo/code/worktrees/lumen-duo","foreground_cwd":"/Users/demo/code/worktrees/lumen-duo","label":"lumen-duo · opus","agent":"claude","terminal_title_stripped":"lumen-duo"},
{"pane_id":"wB:p1","terminal_id":"term_65efccd90984910","workspace_id":"wB","tab_id":"wB:t1","focused":false,"agent_status":"idle","revision":1,"cwd":"/Users/demo/code/marigold","foreground_cwd":"/Users/demo/code/marigold","agent":"claude","terminal_title_stripped":"Marigold next steps"},
{"pane_id":"wC:p1","terminal_id":"term_65efccd90a23511","workspace_id":"wC","tab_id":"wC:t1","focused":false,"agent_status":"idle","revision":1,"cwd":"/Users/demo/code/harbor","foreground_cwd":"/Users/demo/code/harbor","agent":"claude","terminal_title_stripped":"Harbor status update"},
{"pane_id":"wD:p1","terminal_id":"term_65efccd90adda12","workspace_id":"wD","tab_id":"wD:t1","focused":false,"agent_status":"idle","revision":1,"cwd":"/Users/demo/code/tidepool","foreground_cwd":"/Users/demo/code/tidepool","agent":"claude","terminal_title_stripped":"Unspecified session topic"},
{"pane_id":"wD:pK","terminal_id":"term_65efccd90bdfe13","workspace_id":"wD","tab_id":"wD:t6","focused":false,"agent_status":"idle","revision":1,"cwd":"/Users/demo/code/worktrees/tidepool-narration","foreground_cwd":"/Users/demo/code/worktrees/tidepool-narration","label":"tidepool-narration · opus","agent":"claude","terminal_title_stripped":"tidepool-narration"}
]
"""#

    static let nowUnixMs: UInt64 = 1_800_000_000_000

    /// The three lists as one protocol 22 session snapshot (no agents entries:
    /// `pane list` has none, and 0.9.5's carry no status-since anyway).
    static func topology(agentsJSON: String = "[]") -> SessionTopology {
        let json = #"{"version":"0.9.5","protocol":22,"workspaces":"# + workspacesJSON
            + #","tabs":"# + tabsJSON + #","panes":"# + panesJSON
            + #","layouts":[],"agents":"# + agentsJSON + "}"
        return try! JSONDecoder().decode(SessionTopology.self, from: Data(json.utf8))
    }

    static func input(
        mac: String = "mac-mini", fold: SidebarFoldState = SidebarFoldState(), search: String = "",
        summaries: [String: String] = [:], seen: Set<String> = [], shellKind: String = "shell"
    ) -> SidebarInput {
        SidebarInput(
            topology: topology(), macID: mac, needsYouSummaries: summaries, seenDonePaneIDs: seen,
            fold: fold, search: search, nowUnixMs: nowUnixMs, shellKind: shellKind)
    }
}

extension SidebarInput {
    /// The same input with some panes' status and status-since replaced.
    func setting(_ changes: [String: (AgentStatus, UInt64?)]) -> SidebarInput {
        var copy = self
        copy.panes = panes.map { pane in
            guard let (status, since) = changes[pane.paneID] else { return pane }
            return SidebarPane(
                paneID: pane.paneID, tabID: pane.tabID, workspaceID: pane.workspaceID, cwd: pane.cwd,
                label: pane.label, agentKind: pane.agentKind, status: status, title: pane.title,
                statusSinceUnixMs: since)
        }
        return copy
    }

    /// `minutes` before the fixture's now, in ms.
    static func ago(minutes: UInt64) -> UInt64 { SidebarFixture.nowUnixMs - minutes * 60_000 }
}
