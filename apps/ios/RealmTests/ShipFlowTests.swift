import Foundation
import RealmKit
import Testing
@testable import Realm

/// The phone's diff pane: a checkout file's diff numbered for its gutter, the words a diff too big to
/// show and a ship's outcome say, and the stage → commit → push flow's state.
@MainActor
@Suite("The Changes screen and its ship")
struct ShipFlowTests {
    static func file(_ path: String, _ staged: Bool, _ unstaged: Bool) -> CheckoutFile {
        CheckoutFile(path: path, status: "modified", staged: staged, unstaged: unstaged, additions: 3, deletions: 1)
    }
    static let tree = WorkingTree(branch: "theme-column", ahead: 1, behind: 0,
                                  files: [file("src/theme.ts", true, true), file("README.md", false, true)], totalFiles: 2, truncated: false)

    @Test func aNewFilesDiffNumbersFromOneAndKeepsItsHeadersOutOfTheGutter() {
        var numbering = DiffNumbering()
        let lines = numbering.number(["--- /dev/null", "+++ b/new.md", "@@ -0,0 +1,2 @@", "+# new", "+line"], from: 0)
        #expect(lines.map(\.kind) == [.fileHeader, .fileHeader, .hunkHeader, .added, .added])
        #expect(lines.map(\.new) == [nil, nil, nil, 1, 2])
        #expect(lines.allSatisfy { $0.old == nil })
        // A second page carries on from the first.
        let more = numbering.number(["+third"], from: 5)
        #expect(more.first?.new == 3)
        #expect(more.first?.id == 5)
    }

    @Test func aDiffPastTheMacsCeilingSaysSoInItsWords() throws {
        let json = #"{"path":"pnpm-lock.yaml","oldPath":null,"status":"modified","staged":false,"binary":false,"additions":6120,"deletions":4210,"lines":[],"from":0,"next":null,"total":0,"truncated":true,"truncatedReason":"over 512 KB of diff"}"#
        let page = try JSONDecoder().decode(DiffPage.self, from: Data(json.utf8))
        #expect(DiffWords.tooBig(page) == "The diff is over 512 KB, more than Realm shows of one file. All of it is on your Mac.")
    }

    @Test func aCheckoutFileWearsTheTurnsRowWithNoCountsWhereGitHasNone() {
        #expect(CheckoutWords.row(Self.file("a", true, false)).additions == 3)
        #expect(CheckoutWords.row(CheckoutFile(path: "new.md", status: "untracked", staged: false, unstaged: true, additions: 0, deletions: 0)).additions == nil)
        #expect(CheckoutWords.row(CheckoutFile(path: "a.png", status: "added", staged: true, unstaged: false, binary: true, additions: 0, deletions: 0)).deletions == nil)
        #expect(ChangedFileRow.word("untracked") == "New")
        #expect(!ChangedFileRow.counts(CheckoutWords.row(CheckoutFile(path: "n", status: "untracked", staged: false, unstaged: true, additions: 0, deletions: 0))))
        #expect(ChangedFileRow.counts(CheckoutWords.row(CheckoutFile(path: "p", status: "added", staged: true, unstaged: false, binary: true, additions: 0, deletions: 0))))
        #expect(ChangedFileRow.word("conflicted") == "Conflict to resolve")
    }

    @Test func theTitleAndTheLineUnderItAreTheDiffPanes() {
        #expect(CheckoutWords.title(Self.tree) == "Changed 2 files")
        #expect(CheckoutWords.meta(Self.tree) == "theme-column · 1 commit to push")
        #expect(CheckoutWords.staged(Self.tree) == "1 staged")
        let empty = WorkingTree(branch: nil, ahead: 0, behind: 2, files: [], totalFiles: 0, truncated: false)
        #expect(CheckoutWords.title(empty) == nil)
        #expect(CheckoutWords.meta(empty) == "detached · 2 commits to pull")
        #expect(CheckoutWords.staged(empty) == "Nothing staged")
    }

    @Test func eachStepSendsWhatTheDesktopsButtonsSend() {
        #expect(ShipStep.commit.call == .init(commit: true, push: false, setUpstream: false, openPr: false))
        // THE MUTANT: setUpstream false here stops a new branch after its commit and asks a second time.
        #expect(ShipStep.commitAndPublish.call == .init(commit: true, push: true, setUpstream: true, openPr: true))
        #expect(ShipStep.push.call == .init(commit: false, push: true, setUpstream: false, openPr: false))
        #expect(ShipStep.setUpstream(openPr: true).call == .init(commit: false, push: true, setUpstream: true, openPr: true))
        #expect(ShipStep.openPullRequest.call == .init(commit: false, push: true, setUpstream: false, openPr: true))
        // Only a commit goes without asking.
        #expect(ShipConfirmation(.commit, branch: "x", ahead: 0, message: "m") == nil)
        #expect([ShipStep.commitAndPublish, .push, .setUpstream(openPr: false), .openPullRequest].allSatisfy { ShipConfirmation($0, branch: "x", ahead: 1, message: "m") != nil })
    }

    @Test func anOutwardStepSaysWhereItGoesAndThePullRequestItOpens() throws {
        #expect(ShipConfirmation(.commit, branch: "x", ahead: 0, message: "m") == nil)
        let publish = try #require(ShipConfirmation(.commitAndPublish, branch: "theme-column", ahead: 0, message: "Add the column\n\nIt reads the mode once."))
        #expect(publish.title == "Commit, push and open a pull request?")
        #expect(publish.message.contains("pushes theme-column to its remote"))
        #expect(publish.message.contains("titled “Add the column”, with the rest of the message as its description."))
        #expect(publish.button == "Commit, push & PR")
        let push = try #require(ShipConfirmation(.push, branch: "theme-column", ahead: 2, message: ""))
        #expect(push.title == "Push theme-column?")
        #expect(push.message == "This sends 2 commits to its remote.")
    }

    @Test func aPullRequestIsTitledByTheMessagesFirstLineAsGhIsAsked() {
        let draft = PullRequestDraft(message: "  Add the column  \n\nIt reads the mode once.\n", branch: "theme-column")
        #expect(draft.title == "Add the column")
        #expect(draft.body == "It reads the mode once.")
        // With no message, the Mac titles it by the branch.
        #expect(PullRequestDraft(message: "", branch: "theme-column").title == "theme-column")
    }

    @Test func aShipsOutcomeIsTheDesktopsSentencesWithTheOneRetryItOffers() {
        let stopped = ShipResult(commit: .init(state: "committed", sha: "4f1c2a9e0b7d", subject: "Add the column"),
                                 push: .init(state: "no-upstream", remote: "origin", branch: "theme-column", reason: "theme-column has never been pushed; origin does not know about it yet"),
                                 pr: .init(state: "skipped", reason: "the branch is not on the remote yet"))
        let lines = ShipWords.lines(stopped, openPr: true)
        #expect(lines.map(\.text) == ["Committed 4f1c2a9 — Add the column", "theme-column has never been pushed; origin does not know about it yet."])
        #expect(lines.map(\.bad) == [false, true])
        #expect(lines[1].retry == .setUpstream(openPr: true))

        let shipped = ShipResult(commit: .init(state: "skipped"), push: .init(state: "pushed", remote: "origin", branch: "theme-column"),
                                 pr: .init(state: "created", url: "https://github.com/acme/realm/pull/42"))
        let done = ShipWords.lines(shipped, openPr: true)
        #expect(done.map(\.text) == ["Pushed to origin/theme-column.", "Opened a pull request."])
        #expect(done[1].link == URL(string: "https://github.com/acme/realm/pull/42"))

        let refused = ShipResult(commit: .init(state: "nothing-to-commit"), push: .init(state: "rejected", remote: "origin", branch: "x", reason: "origin has commits x does not — pull or rebase, then ship again"),
                                 pr: .init(state: "skipped"))
        // THE MUTANT: offer a retry on a rejected push — its only fix is a force-push, which Realm has not.
        #expect(ShipWords.lines(refused, openPr: false).allSatisfy { $0.retry == nil })
        #expect(ShipWords.lines(refused, openPr: false).map(\.text) == ["Nothing was staged, so no commit was made.", "origin has commits x does not — pull or rebase, then ship again."])
        // git's own prose takes a capital; a name it starts with is left as written.
        #expect(ShipWords.sentence("nothing is staged") == "Nothing is staged.")
        #expect(ShipWords.sentence("main has never been pushed", names: ["main"]) == "main has never been pushed.")
    }

    @Test func commitWaitsForSomethingStagedAndAMessage() {
        var flow = ShipFlow()
        #expect(!flow.canCommit(Self.tree))
        flow.message = "  "
        #expect(!flow.canCommit(Self.tree))
        flow.message = "Add the column"
        #expect(flow.canCommit(Self.tree))
        let nothingStaged = WorkingTree(branch: "x", ahead: 0, behind: 0, files: [Self.file("a", false, true)], totalFiles: 1, truncated: false)
        #expect(!flow.canCommit(nothingStaged))
        #expect(!flow.canCommit(nil))
    }

    @Test func aNewBranchIsCommittedPushedAndOpenedInOneConfirmedStep() throws {
        var flow = ShipFlow()
        flow.message = "Add the column"
        flow.begin(.commitAndPublish)
        let call = try #require(flow.working?.call)
        #expect(call == .init(commit: true, push: true, setUpstream: true, openPr: true))
        flow.finish(ShipResult(commit: .init(state: "committed", sha: "abc1234", subject: "Add the column"),
                               push: .init(state: "pushed", remote: "origin", branch: "theme-column"),
                               pr: .init(state: "created", url: "https://github.com/acme/realm/pull/42")))
        #expect(flow.report.map(\.text) == ["Committed abc1234 — Add the column", "Pushed to origin/theme-column.", "Opened a pull request."])
        // Nothing is left to confirm: no line offers a second step.
        #expect(flow.report.allSatisfy { $0.retry == nil && !$0.bad })
    }

    @Test func aCommitEmptiesTheBoxAndItsRetryIsSentTheSameMessage() {
        var flow = ShipFlow()
        flow.message = "Add the column\n\nBody"
        flow.begin(.commitAndPublish)
        #expect(flow.working == .commitAndPublish)
        #expect(!flow.canCommit(Self.tree), "nothing is taken twice while a step is under way")
        flow.finish(ShipResult(commit: .init(state: "committed", sha: "abc1234", subject: "Add the column"),
                               push: .init(state: "no-upstream", remote: "origin", branch: "theme-column", reason: "theme-column has never been pushed"),
                               pr: .init(state: "skipped")))
        #expect(flow.working == nil)
        #expect(flow.message == "")
        // The retry's pull request is titled from the commit it pushes, as the desktop's box still holds it.
        #expect(flow.report.last?.retry == .setUpstream(openPr: true))
        #expect(flow.message(for: .setUpstream(openPr: true)) == "Add the column\n\nBody")
        #expect(flow.message(for: .commit) == "")
    }

    @Test func aFailedCommitKeepsTheMessageAndARefusalIsTheReport() {
        var flow = ShipFlow()
        flow.message = "m"
        flow.begin(.commit)
        flow.finish(ShipResult(commit: .init(state: "failed", reason: "pre-commit hook failed"), push: .init(state: "skipped"), pr: .init(state: "skipped")))
        #expect(flow.message == "m")
        #expect(flow.report.map(\.text) == ["Commit failed: Pre-commit hook failed."])
        flow.begin(.commit)
        flow.fail("A commit needs a message.")
        #expect(flow.working == nil)
        #expect(flow.report == [ShipLine(id: "refused", text: "A commit needs a message.", bad: true)])
    }

    @Test func thePullRequestsFactsAreTheCodeReviewPagesWords() throws {
        let json = #"""
        {"owner":"acme","repo":"realm","number":42,"title":"t","url":"https://github.com/acme/realm/pull/42","state":"open","draft":false,"author":"me","createdAt":0,"body":"",
         "base":"main","head":"x","headOwner":null,"additions":1,"deletions":0,"changedFiles":1,"mergeable":"mergeable","mergeState":"blocked","decision":"review_required",
         "reviewers":[],"comments":{"total":0,"recent":[]},"checks":[],"files":[],"filesTruncated":false}
        """#
        let pr = try JSONDecoder().decode(PullRequest.self, from: Data(json.utf8))
        #expect(PullRequestWords.merge(pr) == .init(tone: .wait, text: "Blocked until it has an approving review"))
        #expect(PullRequestWords.checks([]) == .init(tone: .quiet, text: "No checks"))
        let checks = [PullRequest.Check(name: "ios", state: "failure"), .init(name: "site", state: "pending"), .init(name: "server", state: "success"), .init(name: "lint", state: "skipped")]
        #expect(PullRequestWords.checks(checks) == .init(tone: .bad, text: "1 failed · 1 running · 1 passed · 1 skipped"))
        #expect(PullRequestWords.state(pr).word == "Open")
        let now = Date(timeIntervalSince1970: 1_000_000)
        #expect(PullRequestWords.ago(1_000_000_000 - 3 * 3_600_000, now: now) == "3h ago")
        #expect(PullRequestWords.ago(1_000_000_000, now: now) == "just now")
    }
}
