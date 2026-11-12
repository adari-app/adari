import XCTest
@testable import HerdrCompanion

/// Prompt texts as `pane.read` (`source: recent`, `format: text`,
/// `strip_ansi: true`) returns them. Built from the v2 design's examples
/// (design/v2/tools/data.py) and the agents' documented prompt shapes; no
/// live agent was read. Older agent versions draw these; today's agents,
/// read live, are `CompanionLiveFixtures`.
enum CompanionPromptFixtures {
    /// Claude Code's edit permission, in its box (design `pairing-helper`).
    static let claudeEdit = """
    ● Bash(swift test --filter PairingTests)
      ⎿  Executed 14 tests, 0 failures (2.31 s)
    ● Update Tests/HelperTests/PairingTests.swift
          88 +func testExpiredTokenIsRejected() {
          89 +  let clock = TestClock()
          90 +  let token = issuer.issue(at: clock.now)
          91 +  clock.advance(by: .minutes(6))
          92 +  XCTAssertThrowsError(try verify(token))
          93 +}

    ╭──────────────────────────────────────────────────────╮
    │ Edit Tests/HelperTests/PairingTests.swift?            │
    │                                                       │
    │ ❯ 1. Yes                                              │
    │   2. Yes, allow all edits this session                │
    │   3. No, tell the agent what to change                │
    ╰──────────────────────────────────────────────────────╯
    """

    /// Claude Code's command permission, without a box, with its footer.
    static let claudeBash = """
    ● I'll push the branch now.

     Bash command

       git push origin fix/relay-timeout
       Push the fix branch to origin

     Do you want to proceed?
     ❯ 1. Yes
       2. Yes, and don't ask again for git push commands in /Users/fixture/code/aurora-web
       3. No, and tell Claude what to do differently (esc)

     Esc to cancel
    """

    /// Codex's approval menu: › marks the choice, shortcuts in parentheses.
    static let codexCommand = """
    • Running the Quartz tests before the copy change lands.

    Would you like to run the following command?

      $ xcodebuild test -scheme Quartz -destination 'platform=iOS Simulator'

    › 1. Yes, proceed (y)
      2. Yes, and don't ask again for this command (a)
      3. No, and tell Codex what to do differently (esc)

      Press enter to confirm or esc to cancel
    """

    /// Grok's confirmation menu.
    static let grokMenu = """
    ⏺ Write docs/plans/sweep-2026-10-16.md
      + ## Sweep
      + - 3 issues closed
      - (empty)

    Do you want to proceed with this operation?
    ❯ 1. Yes
      2. Yes, and don't ask again this session
      3. No
      4. No, with feedback
    """

    /// A `[y/N]` line prompt (design `paywall-copy`): Return means No.
    static let codexYesNo = """
    $ xcodebuild test -scheme Quartz -destination 'platform=iOS Simulator'
    Allow command? [y/N]
    """

    /// A `[Y/n]` line prompt with the default on Yes.
    static let defaultYes = """
    $ git push origin fix/relay-timeout
    Push fix/relay-timeout to origin? [Y/n]
    """

    /// The bracket on its own line.
    static let bracketAlone = """
    Overwrite App/Resources/en.lproj/Localizable.strings?
    [y/N]
    """

    /// An agent at work: nothing to answer.
    static let working = """
    ● Bash(swift test --filter HelperTests)
      ✓ testIssuesTokenWith256Bits (0.004 s)
      ✓ testTokenRoundTrips (0.002 s)
    ✻ Running tests… (1m 12s · esc to interrupt)

    ›
    """

    /// A list that only looks like a menu: output follows it.
    static let staleList = """
    Plan:
    1. Read the pairing code
    2. Add the expiry test
    3. Run the suite
    ● Read Sources/Helper/Pairing.swift (212 lines)
    """

    // MARK: the agents' own text fields

    /// Claude Code once "No, tell the agent what to change" went: the edit
    /// rejected and its boxed field, empty, with its hint under it.
    static let claudeInput = """
    ⏺ Update(Tests/HelperTests/PairingTests.swift)
      ⎿  User rejected update to Tests/HelperTests/PairingTests.swift
      ⎿  Interrupted · What should Claude do instead?

    ╭──────────────────────────────────────────────────────────────────╮
    │ >                                                                │
    ╰──────────────────────────────────────────────────────────────────╯
      ? for shortcuts
    """

    /// Claude Code's field drawn between two rules (no box).
    static let claudeInputRuled = """
    ● Bash(git push origin fix/relay-timeout)
      ⎿  Interrupted · What should Claude do instead?

    ────────────────────────────────────────────────────────────────────
    >\u{0020}
    ────────────────────────────────────────────────────────────────────
      ? for shortcuts
    """

    /// Codex once "No, and tell Codex what to do differently" went: the
    /// request cancelled and its bare › field.
    static let codexInput = """
    ■ Request cancelled. Tell Codex what to do differently.

    ›\u{0020}
    """

    /// Grok once "No, with feedback" went: its boxed ❯ field.
    static let grokInput = """
    ⏺ Write docs/plans/sweep-2026-10-16.md
      ⎿ Rejected: No, with feedback

    ╭────────────────────────────────────────────────────────╮
    │ ❯                                                      │
    ╰────────────────────────────────────────────────────────╯
    """

    /// Claude's field with text in it: not empty, so not proved open for
    /// this app's text.
    static let claudeInputTyped = claudeInput.replacingOccurrences(
        of: "│ >                                                                │",
        with: "│ > Use TestClock                                                  │")

    /// Claude's field still drawing: no bottom edge yet.
    static let claudeInputPartial = """
    ⏺ Update(Tests/HelperTests/PairingTests.swift)
      ⎿  Interrupted · What should Claude do instead?

    ╭──────────────────────────────────────────────────────────────────╮
    │ >                                                                │
    """

    /// An approval no recorded shape matches.
    static let unsupportedApproval = "A custom approval? Type CONFIRM or CANCEL"

    static func lines(_ count: Int, _ make: (Int) -> String) -> String {
        (0..<count).map(make).joined(separator: "\n")
    }

    /// The last `count` lines of `text`, as a full `pane.read` returns them.
    static func lastLines(_ text: String, _ count: Int = Int(CompanionPromptMatcher.readLines)) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false).suffix(count).joined(separator: "\n")
    }

    /// `rows` in a box drawn as Claude Code draws it: an edge, one cell of
    /// padding, each row padded to `width`.
    static func box(_ rows: [String], width: Int) -> String {
        let edge = String(repeating: "─", count: width + 2)
        let body = rows.map { "│ " + $0.padding(toLength: max(width, $0.count), withPad: " ", startingAt: 0) + " │" }
        return (["╭" + edge + "╮"] + body + ["╰" + edge + "╯"]).joined(separator: "\n")
    }

    static func claudeEditCursorOnTwo() -> String {
        claudeEdit
            .replacingOccurrences(of: "│ ❯ 1. Yes ", with: "│   1. Yes ")
            .replacingOccurrences(of: "│   2. Yes, allow", with: "│ ❯ 2. Yes, allow")
    }
}

final class CompanionPromptMatcherTests: XCTestCase {
    private func match(_ text: String, pane: String = "pane-1") throws -> CompanionPromptMatch {
        let reading = CompanionPromptMatcher.match(text, paneID: pane)
        return try XCTUnwrap(reading.match, "expected a match, got \(reading)")
    }

    func testClaudeEditMenuInItsBox() throws {
        let m = try match(CompanionPromptFixtures.claudeEdit)
        XCTAssertEqual(m.kind, .menu)
        XCTAssertEqual(m.question, "Edit Tests/HelperTests/PairingTests.swift?")
        XCTAssertEqual(m.options.map(\.key), ["1", "2", "3"])
        XCTAssertEqual(m.options.map(\.label),
                       ["Yes", "Yes, allow all edits this session", "No, tell the agent what to change"])
        XCTAssertEqual(m.options.map(\.keys), [["1"], ["2"], ["3"]])
        XCTAssertEqual(m.primary?.key, "1")
        XCTAssertTrue(m.options[0].isReturnDefault)
        XCTAssertTrue(m.options[1].isSessionWide, "session-wide sits behind More")
        XCTAssertTrue(m.options[2].opensComposer)
        XCTAssertFalse(m.sideBySide)
        XCTAssertEqual(m.moreOptions.map(\.key), ["2", "3"])
        XCTAssertEqual(m.context, .diff(added: 6, removed: 0), "the edit's diff, not the earlier Bash call")
    }

    func testClaudeBashMenuWithoutBoxFindsTheCommand() throws {
        let m = try match(CompanionPromptFixtures.claudeBash)
        XCTAssertEqual(m.question, "Do you want to proceed?")
        XCTAssertEqual(m.context, .command("git push origin fix/relay-timeout"))
        XCTAssertEqual(m.options.count, 3)
        XCTAssertTrue(m.options[1].isSessionWide, "don't ask again is session-wide")
        XCTAssertEqual(m.options[2].label, "No, and tell Claude what to do differently", "(esc) hint dropped")
        XCTAssertTrue(m.options[2].opensComposer)
        XCTAssertEqual(m.primary?.label, "Yes")
    }

    func testCodexApprovalMenu() throws {
        let m = try match(CompanionPromptFixtures.codexCommand)
        XCTAssertEqual(m.question, "Would you like to run the following command?")
        XCTAssertEqual(m.context, .command("xcodebuild test -scheme Quartz -destination 'platform=iOS Simulator'"))
        XCTAssertEqual(m.options.map(\.label), [
            "Yes, proceed", "Yes, and don't ask again for this command",
            "No, and tell Codex what to do differently",
        ])
        XCTAssertTrue(m.options[0].isReturnDefault, "› marks the choice")
        XCTAssertTrue(m.options[1].isSessionWide)
        XCTAssertEqual(m.primary?.key, "1")
    }

    func testGrokMenuWithFourOptions() throws {
        let m = try match(CompanionPromptFixtures.grokMenu)
        XCTAssertEqual(m.question, "Do you want to proceed with this operation?")
        XCTAssertEqual(m.options.map(\.key), ["1", "2", "3", "4"])
        XCTAssertTrue(m.options[1].isSessionWide)
        XCTAssertFalse(m.options[2].opensComposer, "a plain No answers")
        XCTAssertTrue(m.options[3].opensComposer, "No, with feedback opens the field")
        XCTAssertEqual(m.context, .diff(added: 2, removed: 1))
        XCTAssertEqual(m.moreOptions.map(\.key), ["2", "3", "4"])
    }

    func testYesNoFillsNothingAndMarksTheReturnDefault() throws {
        let m = try match(CompanionPromptFixtures.codexYesNo)
        XCTAssertEqual(m.kind, .yesNo)
        XCTAssertEqual(m.question, "Allow command? [y/N]")
        XCTAssertNil(m.primary, "[y/N] fills nothing")
        XCTAssertTrue(m.sideBySide)
        XCTAssertEqual(m.options.map(\.label), ["Allow", "Deny"])
        XCTAssertEqual(m.options.map(\.keys), [["y", "Enter"], ["n", "Enter"]])
        XCTAssertFalse(m.options[0].isReturnDefault)
        XCTAssertTrue(m.options[1].isReturnDefault, "Return means No")
        XCTAssertEqual(m.context, .command("xcodebuild test -scheme Quartz -destination 'platform=iOS Simulator'"))
    }

    func testYesDefaultAndBracketOnItsOwnLine() throws {
        let yes = try match(CompanionPromptFixtures.defaultYes)
        XCTAssertTrue(yes.options[0].isReturnDefault)
        XCTAssertFalse(yes.options[1].isReturnDefault)
        let alone = try match(CompanionPromptFixtures.bracketAlone)
        XCTAssertEqual(alone.question, "Overwrite App/Resources/en.lproj/Localizable.strings? [y/N]")
    }

    func testUnmatchedShowsTheLastLinesAndNoButtons() {
        let working = CompanionPromptMatcher.match(CompanionPromptFixtures.working, paneID: "p")
        guard case .unmatched(let lines, _) = working else { return XCTFail("\(working)") }
        XCTAssertEqual(lines.count, CompanionPromptMatcher.unmatchedLineCount)
        XCTAssertEqual(lines.last, "›")
        let stale = CompanionPromptMatcher.match(CompanionPromptFixtures.staleList, paneID: "p")
        XCTAssertNil(stale.match, "a numbered list with output after it is not a live menu")
        XCTAssertNil(CompanionPromptMatcher.match("", paneID: "p").match)
    }

    func testFingerprintIgnoresTheCursorButNotTheQuestionOrPane() throws {
        let original = try match(CompanionPromptFixtures.claudeEdit)
        let moved = try match(CompanionPromptFixtures.claudeEditCursorOnTwo())
        XCTAssertEqual(original.fingerprint, moved.fingerprint, "moving ❯ is the same prompt")
        XCTAssertEqual(moved.primary?.key, "1", "a session-wide ❯ never leads the card")
        let otherFile = try match(CompanionPromptFixtures.claudeEdit
            .replacingOccurrences(of: "Edit Tests/HelperTests/PairingTests.swift?", with: "Edit Sources/Helper/Pairing.swift?"))
        XCTAssertNotEqual(original.fingerprint, otherFile.fingerprint)
        let otherPane = try match(CompanionPromptFixtures.claudeEdit, pane: "pane-2")
        XCTAssertNotEqual(original.fingerprint, otherPane.fingerprint)
        let otherOptions = try match(CompanionPromptFixtures.claudeEdit
            .replacingOccurrences(of: "allow all edits this session", with: "allow edits to this file"))
        XCTAssertNotEqual(original.fingerprint, otherOptions.fingerprint)
    }

    func testReadingRoundTripsThroughJSON() throws {
        let reading = CompanionPromptMatcher.match(CompanionPromptFixtures.claudeEdit, paneID: "p")
        let data = try JSONEncoder().encode(reading)
        XCTAssertEqual(try JSONDecoder().decode(CompanionPromptReading.self, from: data), reading)
    }

    // MARK: whole frames only

    private func reading(_ text: String) -> CompanionPromptReading {
        CompanionPromptMatcher.match(text, paneID: "w1:p1")
    }

    @MainActor
    func testChangedCommandUnderTheSameQuestionChangesTheFingerprint() async throws {
        let shown = try XCTUnwrap(reading(CompanionPromptFixtures.codexCommand).match)
        let pushed = CompanionPromptFixtures.codexCommand.replacingOccurrences(
            of: "xcodebuild test -scheme Quartz -destination 'platform=iOS Simulator'", with: "git push origin main")
        let changed = try XCTUnwrap(reading(pushed).match)
        XCTAssertNotEqual(shown.fingerprint, changed.fingerprint, "the command is what is approved")
        let yesNo = try XCTUnwrap(reading(CompanionPromptFixtures.codexYesNo).match)
        let yesNoPushed = try XCTUnwrap(reading(CompanionPromptFixtures.codexYesNo.replacingOccurrences(
            of: "xcodebuild test -scheme Quartz -destination 'platform=iOS Simulator'", with: "git push origin main")).match)
        XCTAssertNotEqual(yesNo.fingerprint, yesNoPushed.fingerprint)
        let pane = CompanionScriptedPane(pushed)
        let outcome = await CompanionPromptAnswerer(io: pane.io).answer(shown.options[0], to: shown)
        let sent = pane.sent
        XCTAssertTrue(sent.isEmpty, "nothing reaches a command the user did not see: \(outcome)")
    }

    func testSameDiffCountsWithADifferentEditChangeTheFingerprint() throws {
        let boxed = CompanionLaunchFixture.pairingPrompt
        let boxedOther = boxed.replacingOccurrences(
            of: "func testPairingCodeExpiresAfterTenMinutes() async {", with: "func testPairingCodeNeverExpires() async {   ")
        let a = try XCTUnwrap(reading(boxed).match)
        let b = try XCTUnwrap(reading(boxedOther).match)
        XCTAssertEqual(a.context, b.context, "the card's one line is the same")
        XCTAssertNotEqual(a.fingerprint, b.fingerprint, "the diff body in the frame differs")

        let above = try XCTUnwrap(reading(CompanionPromptFixtures.claudeEdit).match)
        let aboveOther = try XCTUnwrap(reading(CompanionPromptFixtures.claudeEdit.replacingOccurrences(
            of: "let clock = TestClock()", with: "let clock = WallClock()")).match)
        XCTAssertEqual(above.context, aboveOther.context)
        XCTAssertNotEqual(above.fingerprint, aboveOther.fingerprint)

        let grok = try XCTUnwrap(reading(CompanionPromptFixtures.grokMenu).match)
        let grokOther = try XCTUnwrap(reading(CompanionPromptFixtures.grokMenu.replacingOccurrences(
            of: "+ - 3 issues closed", with: "+ - 4 issues closed")).match)
        XCTAssertNotEqual(grok.fingerprint, grokOther.fingerprint)
    }

    func testWrappedQuestionsEndingInTheSameLineBindEveryLine() throws {
        // Claude's box, its question wrapped over two rows.
        let boxed = CompanionPromptFixtures.box(["Edit App/One/", "Localizable.strings?", "❯ 1. Yes", "  2. No"], width: 30)
        let one = try XCTUnwrap(reading(boxed).match)
        let two = try XCTUnwrap(reading(boxed.replacingOccurrences(of: "App/One/", with: "App/Two/")).match)
        XCTAssertEqual(one.question, "Edit App/One/ Localizable.strings?")
        XCTAssertNotEqual(one.fingerprint, two.fingerprint)
        // Grok's menu under a wrapped question.
        let grok = CompanionPromptFixtures.grokMenu.replacingOccurrences(
            of: "Do you want to proceed with this operation?", with: "Do you want to write\ndocs/plans/one.md?")
        let grokOne = try XCTUnwrap(reading(grok).match)
        let grokTwo = try XCTUnwrap(reading(grok.replacingOccurrences(of: "Do you want to write", with: "Do you want to erase")).match)
        XCTAssertEqual(grokOne.question, "Do you want to write docs/plans/one.md?")
        XCTAssertNotEqual(grokOne.fingerprint, grokTwo.fingerprint)
        // The bare two-option form is a menu nobody recorded: unmatched.
        XCTAssertNil(reading("Edit App/One/\nLocalizable.strings?\n1. Yes\n2. No").match)
    }

    func testClippedFrameTopOrBodyIsUnmatched() {
        // A diff longer than the read: its header is cut off above.
        let longEdit = "● Update App/Big.swift\n" + CompanionPromptFixtures.lines(45) { "  \($0 + 1) +let value\($0) = \($0)" }
            + "\n\n╭────────────────────────────╮\n│ Edit App/Big.swift?         │\n│ ❯ 1. Yes                    │\n│   2. No                     │\n╰────────────────────────────╯"
        XCTAssertNotNil(reading(longEdit).match, "the whole frame matches")
        XCTAssertNil(reading(CompanionPromptFixtures.lastLines(longEdit)).match, "the edit's header was cut: unmatched")
        // A box taller than the read: its top is cut off.
        let tallBox = "⏺ Update(App/Big.swift)\n╭────────────╮\n│ Edit file  │\n"
            + CompanionPromptFixtures.lines(45) { "│ \($0 + 1) +let value\($0) = \($0) │" }
            + "\n│            │\n│ Edit App/Big.swift? │\n│ ❯ 1. Yes │\n│   2. No │\n╰────────────╯"
        XCTAssertNotNil(reading(tallBox).match)
        XCTAssertNil(reading(CompanionPromptFixtures.lastLines(tallBox)).match, "the box's top was cut: unmatched")
        // A command longer than the read under a generic question.
        let longCommand = "• Building the app.\n\nWould you like to run the following command?\n\n  $ ./build.sh \\\n"
            + CompanionPromptFixtures.lines(45) { "      --flag-\($0) \\" }
            + "\n      --last\n\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel"
        XCTAssertNotNil(reading(longCommand).match)
        XCTAssertNil(reading(CompanionPromptFixtures.lastLines(longCommand)).match, "the question and the command's start were cut")
    }

    @MainActor
    func testRunningStatusBelowAnOldMenuIsUnmatched() async throws {
        let shown = try XCTUnwrap(reading(CompanionPromptFixtures.claudeEdit).match)
        let moved = CompanionPromptFixtures.claudeEdit + "\n✻ Running tests… (1m 12s · esc to interrupt)\n"
        XCTAssertNil(reading(moved).match, "the agent moved on")
        XCTAssertNil(reading(CompanionPromptFixtures.claudeBash + "\n✻ Running… (3s · esc to interrupt)").match)
        let pane = CompanionScriptedPane(moved)
        _ = await CompanionPromptAnswerer(io: pane.io).answer(shown.options[0], to: shown)
        let sent = pane.sent
        XCTAssertTrue(sent.isEmpty)
    }

    func testTrailingNumberedPlanIsUnmatched() {
        XCTAssertNil(reading("Here is the plan:\n1. Read the source\n2. Run the suite").match)
        XCTAssertNil(reading("Which should I do first?\n1. Read the source\n2. Run the suite").match)
        let menuThenPlan = CompanionPromptFixtures.claudeBash.replacingOccurrences(of: "\n Esc to cancel", with: "")
            + "\n● Plan:\n1. Push the branch\n2. Open the pull request\n3. Ask for review"
        XCTAssertNil(reading(menuThenPlan).match)
    }

    func testMenuWithOnlyOptionsOneAndTwoDrawnIsUnmatched() {
        XCTAssertNil(reading("Do you want to proceed?\n1. Yes\n2. Yes, allow all edits this session").match)
        let boxedPartial = CompanionPromptFixtures.claudeEdit
            .components(separatedBy: "\n").prefix(15).joined(separator: "\n")
        XCTAssertTrue(boxedPartial.contains("2. Yes, allow all edits"), boxedPartial)
        XCTAssertNil(reading(boxedPartial).match, "the box has not finished drawing")
        let codexPartial = CompanionPromptFixtures.codexCommand
            .components(separatedBy: "\n").prefix(8).joined(separator: "\n")
        XCTAssertNil(reading(codexPartial).match)
    }

    // MARK: the frame as drawn

    @MainActor
    func testQuotedArgumentWhoseInnerSpacingChangesChangesTheFingerprint() async throws {
        let command = "xcodebuild test -scheme Quartz -destination 'platform=iOS Simulator'"
        let twoSpaces = CompanionPromptFixtures.codexCommand.replacingOccurrences(of: command, with: "printf 'a  b'")
        let oneSpace = twoSpaces.replacingOccurrences(of: "'a  b'", with: "'a b'")
        let shown = try XCTUnwrap(reading(twoSpaces).match)
        XCTAssertNotEqual(shown.fingerprint, try XCTUnwrap(reading(oneSpace).match).fingerprint,
                          "the spaces inside the quotes are the command")
        XCTAssertEqual(shown.context, .command("printf 'a  b'"), "the card shows the command as the Mac draws it")
        let pane = CompanionScriptedPane(oneSpace)
        let outcome = await CompanionPromptAnswerer(io: pane.io).answer(shown.options[0], to: shown)
        XCTAssertEqual(pane.sent, [], "nothing reaches printf 'a b': \(outcome)")
        // The same in a [y/N] line prompt and in Claude's Bash command.
        let yesNo = CompanionPromptFixtures.codexYesNo.replacingOccurrences(of: command, with: "printf 'a  b'")
        XCTAssertNotEqual(
            try XCTUnwrap(reading(yesNo).match).fingerprint,
            try XCTUnwrap(reading(yesNo.replacingOccurrences(of: "'a  b'", with: "'a b'")).match).fingerprint)
        let bash = CompanionPromptFixtures.claudeBash.replacingOccurrences(
            of: "git push origin fix/relay-timeout", with: "git commit -m 'a  b'")
        XCTAssertNotEqual(
            try XCTUnwrap(reading(bash).match).fingerprint,
            try XCTUnwrap(reading(bash.replacingOccurrences(of: "'a  b'", with: "'a b'")).match).fingerprint)
    }

    @MainActor
    func testDiffLineWhoseIndentationChangesChangesTheFingerprint() async throws {
        // Claude's edit with its diff above the box.
        let edit = CompanionPromptFixtures.claudeEdit
        let editShifted = edit.replacingOccurrences(of: "89 +  let clock", with: "89 +    let clock")
        XCTAssertNotEqual(try XCTUnwrap(reading(edit).match).fingerprint,
                          try XCTUnwrap(reading(editShifted).match).fingerprint)
        // Claude's edit in its box (the design's pairing prompt): two cells
        // move from the indentation to the padding, the box keeps its width.
        let boxed = CompanionLaunchFixture.pairingPrompt
        let boxedShifted = boxed.replacingOccurrences(
            of: "42 +        let clock = TestClock()  ", with: "42 +      let clock = TestClock()    ")
        XCTAssertNotEqual(boxed, boxedShifted)
        let shown = try XCTUnwrap(reading(boxed).match)
        XCTAssertNotEqual(shown.fingerprint, try XCTUnwrap(reading(boxedShifted).match).fingerprint)
        // Grok's diff.
        let grok = CompanionPromptFixtures.grokMenu
        XCTAssertNotEqual(
            try XCTUnwrap(reading(grok).match).fingerprint,
            try XCTUnwrap(reading(grok.replacingOccurrences(of: "  + ## Sweep", with: "  +   ## Sweep")).match).fingerprint)
        let pane = CompanionScriptedPane(boxedShifted)
        _ = await CompanionPromptAnswerer(io: pane.io).answer(shown.options[0], to: shown)
        XCTAssertEqual(pane.sent, [])
    }

    func testRowThatMayBeWrappedIsUnmatched() throws {
        // A command that fills the widest row and goes on below: the break
        // may be the terminal's, and a wrap does not show the spaces at it.
        let long = "printf '" + String(repeating: "a", count: 72)
        let codex = { (command: String) in
            CompanionPromptFixtures.codexCommand.replacingOccurrences(
                of: "$ xcodebuild test -scheme Quartz -destination 'platform=iOS Simulator'", with: command)
        }
        // Codex's frame (its footer) reads a wrapped body whole: the first
        // row and …. Under any other footer the same rows stay unmatched.
        let wrapped = codex("$ \(long)\n  b'")
        XCTAssertEqual(reading(wrapped).match?.context, .command(long + " …"), "Codex's frame")
        let other = wrapped.replacingOccurrences(of: "Press enter to confirm or esc to cancel", with: "Esc to cancel")
        XCTAssertNil(reading(other).match, "a row as wide as the read, then more")
        XCTAssertNotNil(reading(codex("$ \(long)' \\\n      'b'")).match, "a shell continuation is the command's own break")
        // In Claude's box the cells left before its edge tell: none left, so
        // the next word may have been wrapped there.
        let full = CompanionPromptFixtures.box([
            "Bash command", "", "  swift test --filter PairingTests", "  --parallel", "  Run the pairing tests", "",
            "Do you want to proceed?", "❯ 1. Yes", "  2. No",
        ], width: 34)
        XCTAssertNil(reading(full).match, "the command reaches the box's edge and goes on")
        let roomy = CompanionPromptFixtures.box([
            "Bash command", "", "  swift test --filter PairingTests", "  --parallel", "  Run the pairing tests", "",
            "Do you want to proceed?", "❯ 1. Yes", "  2. No",
        ], width: 50)
        XCTAssertNotNil(reading(roomy).match, "--parallel would have fitted: a row of its own")
    }

    @MainActor
    func testFirstThreeOfGroksFourOptionsIsUnmatched() async throws {
        let rows = CompanionPromptFixtures.grokMenu.split(separator: "\n", omittingEmptySubsequences: false)
        let firstThree = rows.dropLast().joined(separator: "\n")
        XCTAssertTrue(firstThree.hasSuffix("3. No"), firstThree)
        XCTAssertNil(reading(firstThree).match, "No before No, with feedback: still drawing")
        XCTAssertNil(reading(rows.dropLast(2).joined(separator: "\n")).match)
        XCTAssertNil(reading("Do you want to proceed?\n❯ 1. Yes\n  2. No").match, "a bare menu nobody recorded")
        let whole = try XCTUnwrap(reading(CompanionPromptFixtures.grokMenu).match)
        let pane = CompanionScriptedPane(firstThree)
        let outcome = await CompanionPromptAnswerer(io: pane.io).answer(whole.options[0], to: whole)
        XCTAssertEqual(pane.sent, [], "\(outcome)")
    }

    @MainActor
    func testEveryRecordedPromptStillMatchesAndSendsItsKeys() async throws {
        let recorded: [(name: String, text: String, keys: [String], defaults: [String])] = [
            ("Claude boxed", CompanionPromptFixtures.claudeEdit, ["1"], ["1"]),
            ("Claude unboxed", CompanionPromptFixtures.claudeBash, ["1"], ["1"]),
            ("Codex", CompanionPromptFixtures.codexCommand, ["1"], ["1"]),
            ("Grok four", CompanionPromptFixtures.grokMenu, ["1"], ["1"]),
            ("Y/n", CompanionPromptFixtures.defaultYes, ["y", "Enter"], ["y"]),
            ("y/N", CompanionPromptFixtures.codexYesNo, ["y", "Enter"], ["n"]),
            ("bracket alone", CompanionPromptFixtures.bracketAlone, ["y", "Enter"], ["n"]),
            ("design pairing", CompanionLaunchFixture.pairingPrompt, ["1"], ["1"]),
            ("design pairing changed", CompanionLaunchFixture.pairingChangedPrompt, ["1"], ["1"]),
            ("design paywall", CompanionLaunchFixture.paywallPrompt, ["y", "Enter"], ["n"]),
            ("design strings", CompanionLaunchFixture.stringsPrompt, ["y", "Enter"], ["n"]),
            ("design relay", CompanionLaunchFixture.relayPrompt, ["y", "Enter"], ["n"]),
            ("design reviewer", CompanionLaunchFixture.reviewerPrompt, ["1"], ["1"]),
        ]
        for prompt in recorded {
            let m = try XCTUnwrap(reading(prompt.text).match, prompt.name)
            let pane = CompanionScriptedPane(prompt.text)
            let outcome = await CompanionPromptAnswerer(io: pane.io).answer(m.primary ?? m.options[0], to: m)
            XCTAssertEqual(outcome, .sent, prompt.name)
            XCTAssertEqual(pane.sent, [prompt.keys], prompt.name)
            XCTAssertEqual(m.options.filter(\.isReturnDefault).map(\.key), prompt.defaults, prompt.name)
        }
    }
}

/// Each supported agent kind's own empty text field, the
/// proof the text after "No, tell…" waits for; anything else proves nothing.
final class CompanionInputPromptTests: XCTestCase {
    typealias F = CompanionPromptFixtures

    func testEachKindsRecordedFieldIsRead() {
        let recorded: [(kind: String, text: String)] = [
            ("claude", F.claudeInput), ("claude", F.claudeInputRuled), ("codex", F.codexInput),
            ("grok", F.grokInput), ("claude", CompanionLaunchFixture.pairingFeedbackField),
            ("codex", CompanionLaunchFixture.reviewerFeedbackField),
        ]
        for field in recorded {
            XCTAssertTrue(CompanionPromptMatcher.showsInputPrompt(field.text, kind: field.kind), field.text)
            XCTAssertTrue(
                CompanionPromptMatcher.showsInputPrompt(field.text, kind: field.kind.capitalized), "kinds compare lowercased")
            XCTAssertNil(CompanionPromptMatcher.match(field.text, paneID: "pane-1").match, "a field is no approval")
        }
        // Escapes and \r\n as a pane read may carry them.
        let drawn = "\u{1b}[2m" + F.claudeInput.replacingOccurrences(of: "\n", with: "\r\n") + "\u{1b}[0m\r\n\r\n"
        XCTAssertTrue(CompanionPromptMatcher.showsInputPrompt(drawn, kind: "claude"))
    }

    func testEmptyPartialTypedAndUnknownFramesProveNothing() {
        let unproved: [(name: String, text: String)] = [
            ("empty", ""),
            ("blank rows", "\n\n  \n"),
            ("partial approval", String(F.claudeEdit.prefix(100))),
            ("whole approval", F.claudeEdit),
            ("unsupported approval", F.unsupportedApproval),
            ("field still drawing", F.claudeInputPartial),
            ("text in the field", F.claudeInputTyped),
            ("output under the field", F.claudeInput + "\n● Read Sources/Helper/Pairing.swift"),
            ("unrecorded footer", F.grokInput + "\n  ≋ some hint"),
            ("still working", F.claudeInput.replacingOccurrences(
                of: "  ⎿  Interrupted · What should Claude do instead?",
                with: "✻ Thinking… (4s · esc to interrupt)")),
        ]
        XCTAssertNotEqual(F.claudeInputTyped, F.claudeInput, "the typed row replaced the empty one")
        for frame in unproved {
            for kind in ["claude", "codex", "grok"] {
                XCTAssertFalse(CompanionPromptMatcher.showsInputPrompt(frame.text, kind: kind), "\(frame.name) (\(kind))")
            }
        }
        // Codex's bare › under a running status is the composer of an agent at work.
        XCTAssertFalse(CompanionPromptMatcher.showsInputPrompt(F.working, kind: "codex"))
    }

    func testAFieldCountsOnlyForItsOwnKind() {
        XCTAssertFalse(CompanionPromptMatcher.showsInputPrompt(F.claudeInput, kind: "codex"))
        XCTAssertFalse(CompanionPromptMatcher.showsInputPrompt(F.claudeInput, kind: "grok"), "> is not ❯")
        XCTAssertFalse(CompanionPromptMatcher.showsInputPrompt(F.grokInput, kind: "claude"), "❯ is not >")
        XCTAssertFalse(CompanionPromptMatcher.showsInputPrompt(F.codexInput, kind: "claude"))
        // A kind with no recorded field is never proved ready.
        for kind in ["gemini", "cursor", ""] {
            XCTAssertNil(CompanionPromptMatcher.inputPrompts[kind])
            XCTAssertFalse(CompanionPromptMatcher.showsInputPrompt(F.claudeInput, kind: kind), kind)
        }
        XCTAssertFalse(CompanionPromptMatcher.showsInputPrompt(F.claudeInput, kind: nil))
        XCTAssertEqual(Set(CompanionPromptMatcher.inputPrompts.keys), ["claude", "codex", "grok"])
    }
}

/// A pane whose screen the test controls, recording every key it receives.
@MainActor
final class CompanionScriptedPane {
    var screens: [String]
    var readError: Error?
    var sendError: Error?
    private(set) var reads = 0
    private(set) var sent: [[String]] = []

    init(_ screens: String...) { self.screens = screens }

    var io: CompanionPaneIO {
        CompanionPaneIO(
            read: { [self] _ in
                reads += 1
                if let readError { throw readError }
                return screens.count > 1 ? screens.removeFirst() : screens[0]
            },
            sendKeys: { [self] keys, _ in
                if let sendError { throw sendError }
                sent.append(keys)
            })
    }
}

struct CompanionScriptedFailure: LocalizedError {
    let errorDescription: String?
}

@MainActor
final class CompanionPromptAnswererTests: XCTestCase {
    func testSendsTheOptionKeyOnceWhenThePromptIsUnchanged() async throws {
        let shown = try XCTUnwrap(CompanionPromptMatcher.match(CompanionPromptFixtures.claudeEdit, paneID: "p").match)
        let pane = CompanionScriptedPane(CompanionPromptFixtures.claudeEditCursorOnTwo())
        let outcome = await CompanionPromptAnswerer(io: pane.io).answer(shown.options[0], to: shown)
        XCTAssertEqual(outcome, .sent)
        XCTAssertEqual(pane.reads, 1, "re-read before sending")
        XCTAssertEqual(pane.sent, [["1"]])
    }

    func testYesNoSendsLetterAndReturn() async throws {
        let shown = try XCTUnwrap(CompanionPromptMatcher.match(CompanionPromptFixtures.codexYesNo, paneID: "p").match)
        let pane = CompanionScriptedPane(CompanionPromptFixtures.codexYesNo)
        let outcome = await CompanionPromptAnswerer(io: pane.io).answer(shown.options[1], to: shown)
        XCTAssertEqual(outcome, .sent)
        XCTAssertEqual(pane.sent, [["n", "Enter"]])
    }

    func testChangedPromptSendsNothingAndReturnsWhatIsShowing() async throws {
        let shown = try XCTUnwrap(CompanionPromptMatcher.match(CompanionPromptFixtures.claudeEdit, paneID: "p").match)
        let pane = CompanionScriptedPane(CompanionPromptFixtures.claudeBash)
        let outcome = await CompanionPromptAnswerer(io: pane.io).answer(shown.options[0], to: shown)
        guard case .changed(let now) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(now.match?.question, "Do you want to proceed?")
        XCTAssertTrue(pane.sent.isEmpty, "nothing sent to a prompt the user did not see")

        let gone = CompanionScriptedPane(CompanionPromptFixtures.working)
        let goneOutcome = await CompanionPromptAnswerer(io: gone.io).answer(shown.options[0], to: shown)
        guard case .changed(.unmatched) = goneOutcome else { return XCTFail("\(goneOutcome)") }
        XCTAssertTrue(gone.sent.isEmpty)
    }

    func testUnreadablePaneSendsNothing() async throws {
        let shown = try XCTUnwrap(CompanionPromptMatcher.match(CompanionPromptFixtures.claudeEdit, paneID: "p").match)
        let pane = CompanionScriptedPane(CompanionPromptFixtures.claudeEdit)
        pane.readError = CompanionScriptedFailure(errorDescription: "offline")
        let outcome = await CompanionPromptAnswerer(io: pane.io).answer(shown.options[0], to: shown)
        XCTAssertEqual(outcome, .unread("offline"))
        XCTAssertTrue(pane.sent.isEmpty)
    }
}

/// A Mac route and agent for the outbox tests that are not about binding.
enum CompanionOutboxFixture {
    static func host(_ id: UUID) -> CompanionHostBinding {
        CompanionHostBinding(SavedHost(
            id: id, host: "mac.example.ts.net", username: "fixture", nickname: nil, authKind: .key, session: "default"))
    }

    static func agent(_ pane: String) -> CompanionAgentBinding {
        CompanionAgentBinding(paneID: pane, terminalID: "term-\(pane)", agentSession: nil, episode: "blocked|10|1")
    }
}

@MainActor
extension CompanionAnswerOutbox {
    /// Queues for the fixture route of `hostID` and the pane's fixture agent.
    @discardableResult
    func enqueue(
        _ option: CompanionPromptOption, for match: CompanionPromptMatch, hostID: UUID, hostLabel: String
    ) -> CompanionQueuedAnswer? {
        enqueue(option, for: match, host: CompanionOutboxFixture.host(hostID), hostLabel: hostLabel,
                agent: CompanionOutboxFixture.agent(match.fingerprint.paneID))
    }

    /// Drains on the fixture route of `hostID`, every fixture agent still there.
    @discardableResult
    func drain(hostID: UUID, using answerer: CompanionPromptAnswerer) async -> CompanionDrainReport {
        await drain(host: CompanionOutboxFixture.host(hostID), current: { CompanionOutboxFixture.agent($0) },
                    using: answerer)
    }
}

@MainActor
final class CompanionAnswerOutboxTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "adari.tests.outbox"
    private let mac = UUID(uuidString: "11111111-1111-1111-1111-111111111111")!
    private let other = UUID(uuidString: "22222222-2222-2222-2222-222222222222")!

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    private func edit(pane: String = "p") throws -> CompanionPromptMatch {
        try XCTUnwrap(CompanionPromptMatcher.match(CompanionPromptFixtures.claudeEdit, paneID: pane).match)
    }

    /// A notice off its card names the agent in the pane
    /// only when it is the one the answer was for; a new agent in a reused
    /// pane never lends it its name: the saved question, else the pane.
    func testANoticeOffItsCardNeverCarriesANewAgentsName() throws {
        let topology = try CompanionInboxTestMac.topology(CompanionInboxTestMac.json())
        let pairing = try XCTUnwrap(topology.agents.first { $0.paneID == "pane-pairing" }
            .map { CompanionInboxAgent(info: $0, topology: topology) })
        let earlier = CompanionAgentBinding(
            paneID: "pane-pairing", terminalID: "term-pane-pairing-earlier", agentSession: nil, episode: "1")
        func notice(_ agent: CompanionAgentBinding?, question: String?) -> CompanionOutboxNotice {
            CompanionOutboxNotice(
                hostID: mac, paneID: "pane-pairing", text: "Not sent", at: Date(), question: question, agent: agent)
        }
        XCTAssertEqual(notice(pairing.binding, question: "Edit?").label(current: pairing), "pairing-helper",
                       "the same agent, its card not on screen")
        XCTAssertEqual(notice(earlier, question: "Run the migration?").label(current: pairing), "Run the migration?")
        XCTAssertEqual(notice(earlier, question: nil).label(current: pairing), "Earlier agent in pane pane-pairing")
        XCTAssertEqual(notice(nil, question: nil).label(current: pairing), "Earlier agent in pane pane-pairing",
                       "one saved without its agent")
        XCTAssertEqual(notice(earlier, question: "Run the migration?").label(current: nil), "Run the migration?",
                       "the agent gone")
    }

    func testQueuedAnswerPersistsAndCancels() throws {
        let outbox = CompanionAnswerOutbox(defaults: defaults)
        let match = try edit()
        let queued = try XCTUnwrap(outbox.enqueue(match.options[0], for: match, hostID: mac, hostLabel: "Studio Mac"))
        XCTAssertEqual(CompanionAnswerOutbox(defaults: defaults).queued, [queued], "kept across launches")
        XCTAssertEqual(outbox.queued(hostID: mac, paneID: "p")?.option.label, "Yes")
        XCTAssertNil(outbox.queued(hostID: other, paneID: "p"), "per Mac")
        let replaced = try XCTUnwrap(outbox.enqueue(match.options[2], for: match, hostID: mac, hostLabel: "Studio Mac"))
        XCTAssertEqual(outbox.queued, [replaced], "one answer per pane")
        outbox.cancel(replaced.id)
        XCTAssertTrue(outbox.queued.isEmpty)
        XCTAssertTrue(CompanionAnswerOutbox(defaults: defaults).queued.isEmpty)
    }

    func testReconnectSendsOnlyWhenTheSamePromptIsStillShowing() async throws {
        let outbox = CompanionAnswerOutbox(defaults: defaults)
        let match = try edit()
        outbox.enqueue(match.options[0], for: match, hostID: mac, hostLabel: "Studio Mac")
        let elsewhere = try edit(pane: "q")
        outbox.enqueue(elsewhere.options[0], for: elsewhere, hostID: other, hostLabel: "Build Box")
        let pane = CompanionScriptedPane(CompanionPromptFixtures.claudeEdit)
        await outbox.drain(hostID: mac, using: CompanionPromptAnswerer(io: pane.io))
        XCTAssertEqual(pane.sent, [["1"]])
        XCTAssertNil(outbox.queued(hostID: mac, paneID: "p"))
        XCTAssertNotNil(outbox.queued(hostID: other, paneID: "q"), "another Mac's answer waits for that Mac")
        XCTAssertNil(outbox.notice(hostID: mac, paneID: "p"))
    }

    func testChangedPromptOnReconnectDropsTheAnswerWithANotice() async throws {
        let outbox = CompanionAnswerOutbox(defaults: defaults)
        let match = try edit()
        outbox.enqueue(match.options[0], for: match, hostID: mac, hostLabel: "Studio Mac")
        let pane = CompanionScriptedPane(CompanionPromptFixtures.claudeBash)
        await outbox.drain(hostID: mac, using: CompanionPromptAnswerer(io: pane.io))
        XCTAssertTrue(pane.sent.isEmpty)
        XCTAssertTrue(outbox.queued.isEmpty)
        XCTAssertEqual(outbox.notice(hostID: mac, paneID: "p")?.text, "Not sent: the question changed")
        XCTAssertEqual(CompanionAnswerOutbox(defaults: defaults).notice(hostID: mac, paneID: "p")?.text,
                       "Not sent: the question changed")
        outbox.dismissNotice(hostID: mac, paneID: "p")
        XCTAssertNil(outbox.notice(hostID: mac, paneID: "p"))
    }

    func testUnreadablePaneKeepsTheAnswerForTheNextReconnect() async throws {
        let outbox = CompanionAnswerOutbox(defaults: defaults)
        let match = try edit()
        outbox.enqueue(match.options[0], for: match, hostID: mac, hostLabel: "Studio Mac")
        let pane = CompanionScriptedPane(CompanionPromptFixtures.claudeEdit)
        pane.readError = CompanionScriptedFailure(errorDescription: "still offline")
        await outbox.drain(hostID: mac, using: CompanionPromptAnswerer(io: pane.io))
        XCTAssertNotNil(outbox.queued(hostID: mac, paneID: "p"))
        XCTAssertTrue(pane.sent.isEmpty)
    }

    // MARK: cancel, replace and dispatch

    private func editMatch() throws -> CompanionPromptMatch {
        try XCTUnwrap(CompanionPromptMatcher.match(CompanionPromptFixtures.claudeEdit, paneID: "p").match)
    }

    private func beforeDefaults(_ name: String) -> UserDefaults {
        let suite = "adari.tests.outbox.case.\(name)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    func testCancelWhileTheReadIsSuspendedSendsNothing() async throws {
        let outbox = CompanionAnswerOutbox(defaults: beforeDefaults("cancel"))
        let match = try editMatch()
        let queued = try XCTUnwrap(outbox.enqueue(match.options[0], for: match, hostID: mac, hostLabel: "Studio Mac"))
        var pending: CheckedContinuation<String, Never>?
        var sent: [[String]] = []
        let io = CompanionPaneIO(
            read: { _ in await withCheckedContinuation { pending = $0 } },
            sendKeys: { keys, _ in sent.append(keys) })
        let drain = Task { await outbox.drain(hostID: mac, using: CompanionPromptAnswerer(io: io)) }
        await CompanionInboxTestMac.waitUntil("the re-read starts") { pending != nil }
        outbox.cancel(queued.id)
        pending?.resume(returning: CompanionPromptFixtures.claudeEdit)
        _ = await drain.value
        XCTAssertEqual(sent, [], "the × is authoritative until the bytes go")
        XCTAssertTrue(outbox.queued.isEmpty)
    }

    func testReplaceWhileTheReadIsSuspendedSendsOnlyTheNewKey() async throws {
        let outbox = CompanionAnswerOutbox(defaults: beforeDefaults("replace"))
        let match = try editMatch()
        outbox.enqueue(match.options[0], for: match, hostID: mac, hostLabel: "Studio Mac")
        var pending: CheckedContinuation<String, Never>?
        var reads = 0
        var sent: [[String]] = []
        let io = CompanionPaneIO(
            read: { _ in
                reads += 1
                if reads == 1 { return await withCheckedContinuation { pending = $0 } }
                return CompanionPromptFixtures.claudeEdit
            },
            sendKeys: { keys, _ in sent.append(keys) })
        let drain = Task { await outbox.drain(hostID: mac, using: CompanionPromptAnswerer(io: io)) }
        await CompanionInboxTestMac.waitUntil("the re-read starts") { pending != nil }
        outbox.enqueue(match.options[2], for: match, hostID: mac, hostLabel: "Studio Mac")
        pending?.resume(returning: CompanionPromptFixtures.claudeEdit)
        _ = await drain.value
        if outbox.queued.isEmpty == false {
            _ = await outbox.drain(hostID: mac, using: CompanionPromptAnswerer(io: io))
        }
        XCTAssertEqual(sent, [["3"]], "only the replacement is sent")
        XCTAssertTrue(outbox.queued.isEmpty)
    }

    func testInterruptedDispatchIsNeverReplayed() async throws {
        let defaults = beforeDefaults("interrupted")
        let outbox = CompanionAnswerOutbox(defaults: defaults)
        let match = try editMatch()
        outbox.enqueue(match.options[0], for: match, hostID: mac, hostLabel: "Studio Mac")
        var sending: CheckedContinuation<Void, Never>?
        let stuck = CompanionPaneIO(
            read: { _ in CompanionPromptFixtures.claudeEdit },
            sendKeys: { _, _ in await withCheckedContinuation { sending = $0 } })
        let drain = Task { await outbox.drain(hostID: mac, using: CompanionPromptAnswerer(io: stuck)) }
        await CompanionInboxTestMac.waitUntil("the send starts") { sending != nil }

        // The process dies here: a new launch reads the same defaults.
        let relaunched = CompanionAnswerOutbox(defaults: defaults)
        XCTAssertTrue(relaunched.queued.isEmpty, "an answer that may have gone is not queued again")
        let notice = relaunched.notice(hostID: mac, paneID: "p")?.text ?? ""
        XCTAssertTrue(notice.hasPrefix("May have been sent"), notice)
        var replayed: [[String]] = []
        let fresh = CompanionPaneIO(
            read: { _ in CompanionPromptFixtures.claudeEdit }, sendKeys: { keys, _ in replayed.append(keys) })
        _ = await relaunched.drain(hostID: mac, using: CompanionPromptAnswerer(io: fresh))
        XCTAssertEqual(replayed, [], "never replayed automatically")
        sending?.resume()
        _ = await drain.value
    }

    func testCancelGivesWayToSendingOnceTheKeysGo() async throws {
        let outbox = CompanionAnswerOutbox(defaults: beforeDefaults("sending"))
        let match = try editMatch()
        let queued = try XCTUnwrap(outbox.enqueue(match.options[0], for: match, hostID: mac, hostLabel: "Studio Mac"))
        var sending: CheckedContinuation<Void, Never>?
        var sent: [[String]] = []
        let io = CompanionPaneIO(
            read: { _ in CompanionPromptFixtures.claudeEdit },
            sendKeys: { keys, _ in
                sent.append(keys)
                await withCheckedContinuation { sending = $0 }
            })
        let drain = Task { await outbox.drain(hostID: mac, using: CompanionPromptAnswerer(io: io)) }
        await CompanionInboxTestMac.waitUntil("the send starts") { sending != nil }
        XCTAssertEqual(outbox.queued(hostID: mac, paneID: "p")?.isSending, true, "the card shows Sending, without ×")
        XCTAssertFalse(outbox.cancel(queued.id), "once the keys go, × no longer cancels")
        XCTAssertNil(outbox.enqueue(match.options[2], for: match, hostID: mac, hostLabel: "Studio Mac"), "nor replaces")
        sending?.resume()
        _ = await drain.value
        XCTAssertEqual(sent, [["1"]])
        XCTAssertTrue(outbox.queued.isEmpty)
        XCTAssertNil(outbox.enqueue(match.options[2], for: match, hostID: mac, hostLabel: "Studio Mac"),
                     "the prompt is answered until the pane moves on")
    }

    func testNoticesAreBoundedInNumberAndAge() async throws {
        let defaults = beforeDefaults("notices")
        let outbox = CompanionAnswerOutbox(defaults: defaults)
        for index in 0..<35 {
            let match = try XCTUnwrap(
                CompanionPromptMatcher.match(CompanionPromptFixtures.claudeEdit, paneID: "p\(index)").match)
            outbox.enqueue(match.options[0], for: match, hostID: mac, hostLabel: "Studio Mac")
        }
        let weekAgo = Date().addingTimeInterval(-CompanionAnswerOutbox.noticeLifetime - 60)
        let changed = CompanionScriptedPane(CompanionPromptFixtures.claudeBash)
        await outbox.drain(
            host: CompanionOutboxFixture.host(mac), current: { CompanionOutboxFixture.agent($0) },
            using: CompanionPromptAnswerer(io: changed.io), now: { weekAgo })
        XCTAssertEqual(outbox.notices.count, CompanionAnswerOutbox.noticeLimit, "at most 30")
        XCTAssertEqual(outbox.notices.last?.paneID, "p34", "the newest kept")
        XCTAssertEqual(outbox.notices.last?.question, "Edit Tests/HelperTests/PairingTests.swift?",
                       "with the question, for a notice whose card is gone")
        XCTAssertTrue(CompanionAnswerOutbox(defaults: defaults).notices.isEmpty, "and none older than a week")
    }

    // MARK: targets

    func testTwoSavedRoutesToOneMacKeepSeparateQueues() async throws {
        let outbox = CompanionAnswerOutbox(defaults: beforeDefaults("routes"))
        let match = try editMatch()
        let tailnet = SavedHost(
            id: mac, host: "mac.example.ts.net", username: "fixture", nickname: "Studio Mac", authKind: .key,
            session: "default")
        let lan = SavedHost(
            id: other, host: "studio.local", username: "fixture", nickname: "Studio (LAN)", authKind: .key,
            session: "default")
        let agent = CompanionOutboxFixture.agent("p")
        let viaTailnet = try XCTUnwrap(outbox.enqueue(
            match.options[0], for: match, host: CompanionHostBinding(tailnet), hostLabel: tailnet.label, agent: agent))
        let viaLAN = try XCTUnwrap(outbox.enqueue(
            match.options[2], for: match, host: CompanionHostBinding(lan), hostLabel: lan.label, agent: agent))
        XCTAssertEqual(outbox.queued, [viaTailnet, viaLAN], "one queue per saved route")
        let pane = CompanionScriptedPane(CompanionPromptFixtures.claudeEdit)
        await outbox.drain(
            host: CompanionHostBinding(lan), current: { CompanionOutboxFixture.agent($0) },
            using: CompanionPromptAnswerer(io: pane.io))
        XCTAssertEqual(pane.sent, [["3"]], "the LAN route sends only its own answer")
        XCTAssertEqual(outbox.queued, [viaTailnet])
    }

    func testQueuedAnswerWithoutAnAgentIdentityIsNotSent() async throws {
        let outbox = CompanionAnswerOutbox(defaults: beforeDefaults("unverifiable"))
        let match = try editMatch()
        let anonymous = CompanionAgentBinding(paneID: "p", terminalID: nil, agentSession: nil, episode: nil)
        outbox.enqueue(
            match.options[0], for: match, host: CompanionOutboxFixture.host(mac), hostLabel: "Studio Mac",
            agent: anonymous)
        let pane = CompanionScriptedPane(CompanionPromptFixtures.claudeEdit)
        await outbox.drain(
            host: CompanionOutboxFixture.host(mac), current: { _ in anonymous }, using: CompanionPromptAnswerer(io: pane.io))
        XCTAssertTrue(pane.sent.isEmpty, "the pane is not even read")
        XCTAssertTrue(outbox.queued.isEmpty)
        XCTAssertEqual(outbox.notice(hostID: mac, paneID: "p")?.text, "Not sent: Herdr did not say which agent this is")
    }

    // MARK: the agent at the last gate

    func testAgentThatChangesWhileTheReadIsSuspendedGetsNothing() async throws {
        let cases: [(name: String, after: CompanionAgentBinding?, notice: String)] = [
            ("replacement terminal",
             CompanionAgentBinding(paneID: "p", terminalID: "term-p-2", agentSession: nil, episode: "blocked|10|1"),
             "Not sent: another agent is in this pane now"),
            ("gone agent", nil, "Not sent: the agent is gone"),
            ("new episode",
             CompanionAgentBinding(paneID: "p", terminalID: "term-p", agentSession: nil, episode: "blocked|11|2"),
             "Not sent: the question changed"),
        ]
        for change in cases {
            let outbox = CompanionAnswerOutbox(defaults: beforeDefaults("gate-" + change.name.replacingOccurrences(of: " ", with: "-")))
            let match = try editMatch()
            outbox.enqueue(match.options[0], for: match, hostID: mac, hostLabel: "Studio Mac")
            var current: CompanionAgentBinding? = CompanionOutboxFixture.agent("p")
            var pending: CheckedContinuation<String, Never>?
            var sent: [[String]] = []
            let io = CompanionPaneIO(
                read: { _ in await withCheckedContinuation { pending = $0 } },
                sendKeys: { keys, _ in sent.append(keys) })
            let drain = Task {
                await outbox.drain(
                    host: CompanionOutboxFixture.host(mac), current: { _ in current },
                    using: CompanionPromptAnswerer(io: io))
            }
            await CompanionInboxTestMac.waitUntil("the re-read starts (\(change.name))") { pending != nil }
            // A snapshot lands during the read; the pane still shows the prompt.
            current = change.after
            pending?.resume(returning: CompanionPromptFixtures.claudeEdit)
            _ = await drain.value
            XCTAssertEqual(sent, [], change.name)
            XCTAssertTrue(outbox.queued.isEmpty, change.name)
            XCTAssertEqual(outbox.notice(hostID: mac, paneID: "p")?.text, change.notice, change.name)
        }
    }

    // MARK: what frees a sent answer's claim

    func testSentClaimOutlivesAnUnmatchedReadOfTheSamePrompt() async throws {
        let outbox = CompanionAnswerOutbox(defaults: beforeDefaults("transient"))
        let text = CompanionPromptFixtures.codexCommand
        let shown = try XCTUnwrap(CompanionPromptMatcher.match(text, paneID: "p").match)
        let agent = CompanionOutboxFixture.agent("p")
        let pane = CompanionScriptedPane(text)
        func answer() async -> CompanionAnswerOutcome? {
            guard let claim = outbox.claim(shown.options[0], for: shown, hostID: mac, agent: agent) else { return nil }
            let outcome = await CompanionPromptAnswerer(io: pane.io).answer(shown.options[0], to: shown) {
                outbox.beginSending(claim: claim)
            }
            outbox.finish(claim: claim, outcome: outcome, label: shown.options[0].label)
            return outcome
        }
        let first = await answer()
        XCTAssertEqual(first, .sent)
        // A partly drawn render of the same prompt, then the whole of it again.
        outbox.observe(.unmatched(lines: ["Would you like to run the following command?"]), hostID: mac, paneID: "p")
        XCTAssertFalse(outbox.isFree(hostID: mac, paneID: "p"), "an unmatched read proves nothing")
        outbox.observe(CompanionPromptMatcher.match(text, paneID: "p"), hostID: mac, paneID: "p")
        let second = await answer()
        XCTAssertNil(second, "this prompt is answered")
        XCTAssertEqual(pane.sent, [["1"]], "sent once")
    }

    func testSentClaimEndsOnANewPromptOrAConfirmedChange() throws {
        let text = CompanionPromptFixtures.codexCommand
        let shown = try XCTUnwrap(CompanionPromptMatcher.match(text, paneID: "p").match)
        let agent = CompanionOutboxFixture.agent("p")
        func sentClaim(_ name: String) throws -> CompanionAnswerOutbox {
            let outbox = CompanionAnswerOutbox(defaults: beforeDefaults("release-" + name.replacingOccurrences(of: " ", with: "-")))
            let claim = try XCTUnwrap(outbox.claim(shown.options[0], for: shown, hostID: mac, agent: agent))
            XCTAssertTrue(outbox.beginSending(claim: claim))
            outbox.finish(claim: claim, outcome: .sent, label: "Yes")
            return outbox
        }
        let pushed = text.replacingOccurrences(
            of: "xcodebuild test -scheme Quartz -destination 'platform=iOS Simulator'", with: "git push origin main")
        let newPrompt = try sentClaim("prompt")
        newPrompt.observe(CompanionPromptMatcher.match(pushed, paneID: "p"), hostID: mac, paneID: "p")
        XCTAssertTrue(newPrompt.isFree(hostID: mac, paneID: "p"), "another prompt is showing")
        let same = try sentClaim("same")
        same.observe(CompanionPromptMatcher.match(text, paneID: "p"), hostID: mac, paneID: "p")
        XCTAssertFalse(same.isFree(hostID: mac, paneID: "p"), "the answered prompt is still showing")
        let changes: [(name: String, agents: [String: CompanionAgentBinding], needing: Set<String>)] = [
            ("new episode",
             ["p": CompanionAgentBinding(paneID: "p", terminalID: "term-p", agentSession: nil, episode: "blocked|11|2")],
             ["p"]),
            ("another terminal",
             ["p": CompanionAgentBinding(paneID: "p", terminalID: "term-p-2", agentSession: nil, episode: "blocked|10|1")],
             ["p"]),
            ("gone", [:], []),
            ("no longer needs you", ["p": agent], []),
        ]
        for change in changes {
            let outbox = try sentClaim(change.name)
            outbox.release(hostID: mac, agents: change.agents, needing: change.needing)
            XCTAssertTrue(outbox.isFree(hostID: mac, paneID: "p"), change.name)
        }
        let unchanged = try sentClaim("unchanged")
        unchanged.release(hostID: mac, agents: ["p": agent], needing: ["p"])
        XCTAssertFalse(unchanged.isFree(hostID: mac, paneID: "p"), "the same agent and episode still need you")
    }
}
