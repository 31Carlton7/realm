import Foundation

/// The session's checkout as the desktop's diff pane lists it (`session.checkout`): the branch, how far
/// it is from its remote, and every changed file.
public struct WorkingTree: Codable, Sendable, Hashable {
    /// Nil when HEAD is detached.
    public let branch: String?
    /// Commits to push, and to pull.
    public let ahead: Int
    public let behind: Int
    public let files: [CheckoutFile]
    /// How many changed, which may be more than `files` lists.
    public let totalFiles: Int
    public let truncated: Bool

    public init(branch: String?, ahead: Int, behind: Int, files: [CheckoutFile], totalFiles: Int, truncated: Bool) {
        self.branch = branch
        self.ahead = ahead
        self.behind = behind
        self.files = files
        self.totalFiles = totalFiles
        self.truncated = truncated
    }
}

/// One changed path in the checkout. `staged` and `unstaged` are both true for a file staged and then
/// edited again: it has a patch on each side of the index.
public struct CheckoutFile: Codable, Sendable, Hashable {
    public let path: String
    public let oldPath: String?
    /// "added", "modified", "deleted", "renamed", "copied", "type-changed", "untracked" or "conflicted".
    public let status: String
    public let staged: Bool
    public let unstaged: Bool
    public let binary: Bool
    /// Staged and unstaged together; zero for an untracked file, which git has not counted.
    public let additions: Int
    public let deletions: Int

    public init(path: String, oldPath: String? = nil, status: String, staged: Bool, unstaged: Bool, binary: Bool = false, additions: Int, deletions: Int) {
        self.path = path
        self.oldPath = oldPath
        self.status = status
        self.staged = staged
        self.unstaged = unstaged
        self.binary = binary
        self.additions = additions
        self.deletions = deletions
    }
}

/// What a ship did (`session.ship`): each of its three steps, with the desktop's word for how it went.
public struct ShipResult: Codable, Sendable, Hashable {
    public struct Commit: Codable, Sendable, Hashable {
        /// "committed", "nothing-to-commit", "skipped", "no-identity" or "failed".
        public let state: String
        public let sha: String?
        public let subject: String?
        public let reason: String?

        public init(state: String, sha: String? = nil, subject: String? = nil, reason: String? = nil) {
            self.state = state
            self.sha = sha
            self.subject = subject
            self.reason = reason
        }
    }

    public struct Push: Codable, Sendable, Hashable {
        /// "pushed", "up-to-date", "no-remote", "no-upstream", "rejected", "detached", "skipped" or "failed".
        public let state: String
        public let remote: String?
        public let branch: String?
        public let reason: String?

        public init(state: String, remote: String? = nil, branch: String? = nil, reason: String? = nil) {
            self.state = state
            self.remote = remote
            self.branch = branch
            self.reason = reason
        }
    }

    public struct PullRequest: Codable, Sendable, Hashable {
        /// "created", "existing", "compare", "unavailable" or "skipped".
        public let state: String
        public let url: String?
        public let reason: String?

        public init(state: String, url: String? = nil, reason: String? = nil) {
            self.state = state
            self.url = url
            self.reason = reason
        }
    }

    public let commit: Commit
    public let push: Push
    public let pr: PullRequest

    public init(commit: Commit, push: Push, pr: PullRequest) {
        self.commit = commit
        self.push = push
        self.pr = pr
    }
}

/// A session's pull request as the desktop's Code Review page shows it (`session.pr`).
public struct PullRequest: Codable, Sendable, Hashable {
    public struct Reviewer: Codable, Sendable, Hashable {
        public let name: String
        public let team: Bool
        /// "approved", "changes_requested", "commented", "dismissed" or "pending".
        public let state: String
    }

    public struct Comment: Codable, Sendable, Hashable {
        public let author: String?
        public let body: String
        public let createdAt: Double
        public let url: String?
    }

    public struct Comments: Codable, Sendable, Hashable {
        public let total: Int
        /// The newest few, oldest first.
        public let recent: [Comment]
    }

    public struct Check: Codable, Sendable, Hashable {
        public let name: String
        /// "success", "failure", "pending", "skipped" or "neutral".
        public let state: String
        public let url: String?

        public init(name: String, state: String, url: String? = nil) {
            self.name = name
            self.state = state
            self.url = url
        }
    }

    public struct File: Codable, Sendable, Hashable {
        public let path: String
        public let oldPath: String?
        /// "added", "modified", "deleted", "renamed", "copied" or "changed".
        public let status: String
        public let additions: Int
        public let deletions: Int
    }

    public let owner: String
    public let repo: String
    public let number: Int
    public let title: String
    public let url: String
    /// "open", "closed" or "merged".
    public let state: String
    public let draft: Bool
    public let author: String?
    public let createdAt: Double
    public let body: String
    public let base: String
    public let head: String
    public let headOwner: String?
    public let additions: Int
    public let deletions: Int
    public let changedFiles: Int
    /// GitHub's `mergeable`: "mergeable", "conflicting" or "unknown".
    public let mergeable: String
    /// GitHub's `mergeStateStatus`, lowered.
    public let mergeState: String
    /// "approved", "changes_requested" or "review_required".
    public let decision: String?
    public let reviewers: [Reviewer]
    public let comments: Comments
    public let checks: [Check]
    public let files: [File]
    public let filesTruncated: Bool
}

/// `session.pr`'s answer: the request, or none and why where there is a why.
public struct PullRequestLookup: Codable, Sendable, Hashable {
    public let pr: PullRequest?
    public let reason: String?
}
