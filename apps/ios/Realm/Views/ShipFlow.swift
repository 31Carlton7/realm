import Foundation
import RealmKit

/// A step of the desktop's diff pane, as the phone offers it: its Commit only and Commit, push & PR, and
/// the retries a push leads to.
enum ShipStep: Hashable, Identifiable {
    case commit
    case commitAndPublish
    case push
    /// The branch has never been pushed and the person said to push it anyway; `openPr` carries on what
    /// the step that stopped there was asked to do.
    case setUpstream(openPr: Bool)
    case openPullRequest

    var id: Self { self }

    /// What `session.ship` is sent for it.
    struct Call: Equatable {
        let commit: Bool
        let push: Bool
        let setUpstream: Bool
        let openPr: Bool
    }

    var call: Call {
        switch self {
        case .commit: Call(commit: true, push: false, setUpstream: false, openPr: false)
        case .commitAndPublish: Call(commit: true, push: true, setUpstream: false, openPr: true)
        case .push: Call(commit: false, push: true, setUpstream: false, openPr: false)
        case .setUpstream(let openPr): Call(commit: false, push: true, setUpstream: true, openPr: openPr)
        case .openPullRequest: Call(commit: false, push: true, setUpstream: false, openPr: true)
        }
    }

    /// The button that takes the step, in the desktop's words.
    var title: String {
        switch self {
        case .commit: "Commit only"
        case .commitAndPublish: "Commit, push & PR"
        case .push: "Push"
        case .setUpstream: "Push and set upstream"
        case .openPullRequest: "Open pull request"
        }
    }
}

/// The confirmation an outward step asks for: what it sends where, and the pull request it would open.
struct ShipConfirmation: Equatable {
    let title: String
    let message: String
    let button: String

    init?(_ step: ShipStep, branch: String?, ahead: Int, message: String) {
        let branch = branch ?? "this branch"
        let pr = PullRequestDraft(message: message, branch: branch)
        let opens = "It opens a pull request on GitHub titled “\(pr.title)”\(pr.body.isEmpty ? "." : ", with the rest of the message as its description.")"
        switch step {
        case .commit:
            return nil
        case .commitAndPublish:
            title = "Commit, push and open a pull request?"
            self.message = "This commits the staged files and pushes \(branch) to its remote. \(opens)"
        case .push:
            title = "Push \(branch)?"
            self.message = ahead > 0
                ? "This sends \(ahead == 1 ? "1 commit" : "\(ahead) commits") to its remote."
                : "This sends \(branch) to its remote."
        case .setUpstream(let openPr):
            title = "Push \(branch) and set its upstream?"
            self.message = "\(branch) has never been pushed. This pushes it and has git remember where it goes.\(openPr ? " \(opens)" : "")"
        case .openPullRequest:
            title = "Open a pull request?"
            self.message = "This pushes \(branch) if it needs it. \(opens)"
        }
        button = step.title
    }
}

/// The pull request a ship opens, as the Mac's `gh pr create` titles it: the message's first line, the
/// branch's name where there is none, and the rest of the message as its description.
struct PullRequestDraft: Equatable {
    let title: String
    let body: String

    init(message: String, branch: String) {
        let lines = message.components(separatedBy: "\n")
        let first = lines.map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
        title = first.isEmpty ? branch : first
        body = lines.dropFirst().joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// One line of a ship's report: a sentence, whether it is one the person has to act on, and where it
/// leads — a link to open, or the one retry the desktop offers.
struct ShipLine: Equatable, Identifiable {
    let id: String
    let text: String
    var bad = false
    var link: URL?
    var linkTitle: String?
    var retry: ShipStep?
}

enum ShipWords {
    /// The ship's outcome as the desktop's pane says it, step by step: every state has its sentence, and
    /// a skipped step says nothing. `openPr` is whether the step asked for a pull request, which the
    /// "no upstream" retry carries on.
    static func lines(_ result: ShipResult, openPr: Bool) -> [ShipLine] {
        var out: [ShipLine] = []
        let commit = result.commit
        switch commit.state {
        case "committed":
            out.append(ShipLine(id: "commit", text: "Committed \(commit.sha.map { String($0.prefix(7)) } ?? "") — \(commit.subject ?? "")"))
        case "nothing-to-commit":
            out.append(ShipLine(id: "commit", text: "Nothing was staged, so no commit was made."))
        case "no-identity":
            out.append(ShipLine(id: "commit", text: sentence(commit.reason ?? "git has no name and email for this repository"), bad: true))
        case "failed":
            out.append(ShipLine(id: "commit", text: "Commit failed: \(sentence(commit.reason ?? "git said nothing"))", bad: true))
        default:
            break
        }
        let push = result.push
        let target = [push.remote, push.branch].compactMap { $0 }.joined(separator: "/")
        switch push.state {
        case "pushed":
            out.append(ShipLine(id: "push", text: "Pushed to \(target)."))
        case "up-to-date":
            out.append(ShipLine(id: "push", text: "\(target) was already up to date."))
        case "no-remote":
            out.append(ShipLine(id: "push", text: "This checkout has no remote, so there is nowhere to push. Add one with git remote add origin …", bad: true))
        case "no-upstream":
            out.append(ShipLine(id: "push", text: sentence(push.reason ?? "This branch has never been pushed", names: [push.branch, push.remote]), bad: true,
                                retry: .setUpstream(openPr: openPr)))
        case "rejected", "detached":
            out.append(ShipLine(id: "push", text: sentence(push.reason ?? "The push was refused", names: [push.branch, push.remote]), bad: true))
        case "failed":
            out.append(ShipLine(id: "push", text: "Push failed: \(sentence(push.reason ?? "git said nothing", names: [push.branch, push.remote]))", bad: true))
        default:
            break
        }
        let pr = result.pr
        let url = pr.url.flatMap(URL.init(string:))
        switch pr.state {
        case "created", "existing":
            if let url {
                out.append(ShipLine(id: "pr", text: pr.state == "created" ? "Opened a pull request." : "A pull request is already open.", link: url, linkTitle: pr.url))
            }
        case "compare":
            out.append(ShipLine(id: "pr", text: sentence(pr.reason ?? "GitHub can take it from here"), link: url, linkTitle: "Open a pull request"))
        case "unavailable":
            out.append(ShipLine(id: "pr", text: sentence(pr.reason ?? "No pull request could be opened"), bad: true))
        default:
            break
        }
        return out
    }

    /// git's and gh's words as a sentence: a capital to start and a stop to end. One that starts with a
    /// branch's or a remote's name keeps it as it is written.
    static func sentence(_ text: String, names: [String?] = []) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return trimmed }
        let named = names.compactMap { $0 }.contains { !$0.isEmpty && trimmed.hasPrefix($0) }
        let capital = named ? trimmed : first.uppercased() + trimmed.dropFirst()
        return capital.last.map { ".!?…".contains($0) } == true ? capital : capital + "."
    }
}

/// The diff pane's state on the phone, apart from the checkout itself: the message being written, the
/// step under way and the report of the last one.
struct ShipFlow: Equatable {
    var message = ""
    /// The message the last commit went with: a retry's pull request is titled from it, as the desktop's
    /// commit box still holds it.
    private(set) var lastMessage = ""
    private(set) var working: ShipStep?
    private(set) var report: [ShipLine] = []

    /// Commit needs something staged and a message, as the desktop's Commit button does.
    func canCommit(_ tree: WorkingTree?) -> Bool {
        guard working == nil, let tree else { return false }
        return tree.files.contains(where: \.staged) && !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The message a step is sent with: the one being written for a commit, the last commit's for a retry.
    func message(for step: ShipStep) -> String {
        step.call.commit ? message : lastMessage
    }

    mutating func begin(_ step: ShipStep) {
        working = step
        if step.call.commit { lastMessage = message }
    }

    /// The ship came back: its report replaces the last, and a commit that landed empties the box.
    mutating func finish(_ result: ShipResult) {
        let step = working
        working = nil
        report = ShipWords.lines(result, openPr: step?.call.openPr ?? false)
        if result.commit.state == "committed" { message = "" }
    }

    /// The Mac refused the step outright, or never answered: its words are the report.
    mutating func fail(_ reason: String) {
        working = nil
        report = [ShipLine(id: "refused", text: reason, bad: true)]
    }
}

/// The Changes screen's words, as the desktop's diff pane says them.
enum CheckoutWords {
    /// "Changed 3 files", as a turn's changes are titled, or nil for none.
    static func title(_ tree: WorkingTree) -> String? {
        guard tree.totalFiles > 0 else { return nil }
        return "Changed \(plural(tree.totalFiles, "file"))"
    }

    /// The line under the title: where the work is kept and how it stands against the remote.
    static func meta(_ tree: WorkingTree) -> String {
        let conflicts = tree.files.filter { $0.status == "conflicted" }.count
        var parts = [tree.branch ?? "detached"]
        if conflicts > 0 { parts.append("\(plural(conflicts, "conflict")) to resolve") }
        if tree.ahead > 0 { parts.append("\(plural(tree.ahead, "commit")) to push") }
        if tree.behind > 0 { parts.append("\(plural(tree.behind, "commit")) to pull") }
        return parts.joined(separator: " · ")
    }

    /// "Nothing staged" or "2 staged", as the commit bar counts.
    static func staged(_ tree: WorkingTree) -> String {
        let n = tree.files.filter(\.staged).count
        return n == 0 ? "Nothing staged" : "\(n) staged"
    }

    /// The row a checkout file wears, on one side of the index: lines are nil where git does not count
    /// them, a binary file's and an untracked one's.
    static func row(_ file: CheckoutFile) -> ChangedFile {
        let counted = !file.binary && file.status != "untracked"
        return ChangedFile(path: file.path, oldPath: file.oldPath, status: file.status,
                           additions: counted ? file.additions : nil, deletions: counted ? file.deletions : nil)
    }

    static func plural(_ n: Int, _ one: String) -> String {
        "\(n) \(n == 1 ? one : one + "s")"
    }
}

/// The Code Review page's facts about a request, in its words.
enum PullRequestWords {
    enum Tone: Equatable { case ok, bad, wait, quiet }

    struct Fact: Equatable {
        let tone: Tone
        let text: String
    }

    /// Whether it can merge, in a sentence (`mergeFact`).
    static func merge(_ pr: PullRequest) -> Fact {
        if pr.state == "merged" { return Fact(tone: .quiet, text: "Merged") }
        if pr.state == "closed" { return Fact(tone: .quiet, text: "Closed without merging") }
        if pr.mergeable == "conflicting" || pr.mergeState == "dirty" { return Fact(tone: .bad, text: "Has conflicts that must be resolved") }
        if pr.mergeable == "unknown" || pr.mergeState == "unknown" { return Fact(tone: .wait, text: "GitHub is still checking whether it can merge") }
        if pr.draft || pr.mergeState == "draft" { return Fact(tone: .quiet, text: "A draft — not ready to merge yet") }
        if pr.mergeState == "behind" { return Fact(tone: .wait, text: "Behind \(pr.base); needs updating before it can merge") }
        if pr.mergeState == "blocked" {
            let why = pr.decision == "changes_requested" ? "Blocked: changes were requested"
                : pr.decision == "review_required" ? "Blocked until it has an approving review" : "Blocked by a branch rule"
            return Fact(tone: .wait, text: why)
        }
        if pr.mergeState == "unstable" { return Fact(tone: .wait, text: "Can merge, but some checks are failing") }
        return Fact(tone: .ok, text: "Can merge without conflicts")
    }

    /// The checks in one line: what failed, is still running and passed, by count (`checksFact`).
    static func checks(_ checks: [PullRequest.Check]) -> Fact {
        guard !checks.isEmpty else { return Fact(tone: .quiet, text: "No checks") }
        let n = { (state: String) in checks.filter { $0.state == state }.count }
        let failed = n("failure"), pending = n("pending"), passed = n("success"), skipped = n("skipped") + n("neutral")
        let parts = [failed > 0 ? "\(failed) failed" : nil, pending > 0 ? "\(pending) running" : nil,
                     passed > 0 ? "\(passed) passed" : nil, skipped > 0 ? "\(skipped) skipped" : nil].compactMap { $0 }
        return Fact(tone: failed > 0 ? .bad : pending > 0 ? .wait : .ok, text: parts.joined(separator: " · "))
    }

    /// A request's state as its pill says it.
    static func state(_ pr: PullRequest) -> (word: String, symbol: String) {
        switch pr.state {
        case "merged": ("Merged", "arrow.triangle.merge")
        case "closed": ("Closed", "xmark.circle")
        default: pr.draft ? ("Draft", "circle.dashed") : ("Open", "arrow.triangle.pull")
        }
    }

    static func reviewer(_ state: String) -> String {
        switch state {
        case "approved": "Approved"
        case "changes_requested": "Requested changes"
        case "commented": "Commented"
        case "dismissed": "Dismissed"
        default: "Waiting"
        }
    }

    /// How long ago, as the page says it: "just now", "12m ago", "3h ago", "2d ago".
    static func ago(_ ms: Double, now: Date = .now) -> String {
        let minutes = Int((now.timeIntervalSince1970 * 1000 - ms) / 60_000)
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h ago" }
        let days = hours / 24
        if days < 30 { return "\(days)d ago" }
        let months = days / 30
        return months < 12 ? "\(months)mo ago" : "\(days / 365)y ago"
    }
}
