import RealmKit
import SwiftUI

/// The desktop's Code Review page for the session's pull request, read-only as the page is on the
/// phone: its state, title and branches, then whether it can merge, its checks, the files it changes,
/// the conversation's end, who has reviewed, and what its author wrote.
struct PullRequestView: View {
    let sessionId: String
    /// Shown as a sheet, its Close.
    var close: (() -> Void)?
    @Environment(AppModel.self) private var model
    @State private var lookup: PullRequestLookup?
    @State private var problem: String?

    var body: some View {
        Group {
            if let pr = lookup?.pr {
                page(pr)
            } else if let lookup {
                ContentUnavailableView {
                    Label("No pull request", systemImage: "arrow.triangle.pull")
                } description: {
                    Text(lookup.reason ?? "Nobody has opened a pull request for this branch yet. Commit, push & PR in Changes opens one.")
                }
            } else if let problem {
                ContentUnavailableView("The pull request did not load", systemImage: "exclamationmark.triangle", description: Text(problem))
            } else if model.isConnected {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView("The pull request is read on your Mac", systemImage: "laptopcomputer",
                                       description: Text("This iPhone shows it while your Mac is connected."))
            }
        }
        .background(Ground.grouped)
        .navigationTitle(lookup?.pr.map { "#\($0.number)" } ?? "Pull request")
        .navigationSubtitle(lookup?.pr.map { "\($0.owner)/\($0.repo)" } ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let close {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close", systemImage: "xmark", action: close)
                }
                .sharedBackgroundVisibility(.hidden)
            }
            if let url = lookup?.pr.flatMap({ URL(string: $0.url) }) {
                ToolbarItem(placement: .topBarTrailing) {
                    Link(destination: url) { Label("Open on GitHub", systemImage: "safari") }
                }
                .sharedBackgroundVisibility(.hidden)
            }
        }
        .task(id: model.channelGeneration) { await load() }
        .refreshable { await load() }
    }

    private func page(_ pr: PullRequest) -> some View {
        let merge = PullRequestWords.merge(pr)
        let checks = PullRequestWords.checks(pr.checks)
        let body = pr.body.trimmingCharacters(in: .whitespacesAndNewlines)
        return List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    StatePill(pr: pr)
                    Text(pr.title)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                    Text("\(pr.author ?? "ghost") · \(PullRequestWords.ago(pr.createdAt))")
                        .font(.footnote)
                        .foregroundStyle(Palette.ink2)
                    HStack(spacing: 6) {
                        Text("\(pr.headOwner.map { "\($0):" } ?? "")\(pr.head)")
                        Image(systemName: "arrow.right").font(.caption2).accessibilityLabel("into")
                        Text(pr.base)
                    }
                    .mono(.caption)
                    .foregroundStyle(Palette.ink2)
                    .lineLimit(1)
                    .truncationMode(.middle)
                }
                .padding(.vertical, 4)
                .listRowBackground(Fill.card)
            }
            Section("Merge status") {
                FactRow(fact: merge).listRowBackground(Fill.card)
            }
            Section("Checks") {
                FactRow(fact: checks).listRowBackground(Fill.card)
                ForEach(Array(pr.checks.enumerated()), id: \.offset) { _, check in
                    CheckRow(check: check).listRowBackground(Fill.card)
                }
            }
            Section {
                ForEach(pr.files, id: \.path) { file in
                    ChangedFileRow(file: ChangedFile(path: file.path, oldPath: file.oldPath, status: file.status == "changed" ? "type-changed" : file.status,
                                                     additions: file.additions, deletions: file.deletions))
                        .listRowBackground(Fill.card)
                }
            } header: {
                Text("Files changed · \(pr.changedFiles)")
            } footer: {
                if pr.filesTruncated { Text("GitHub lists the first 3,000.") }
            }
            Section(pr.comments.total > 0 ? "Comments · \(pr.comments.total)" : "Comments") {
                if pr.comments.recent.isEmpty {
                    Text("No comments").foregroundStyle(Palette.ink2).listRowBackground(Fill.card)
                }
                ForEach(Array(pr.comments.recent.enumerated()), id: \.offset) { _, comment in
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(comment.author ?? "ghost") · \(PullRequestWords.ago(comment.createdAt))")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(Palette.ink2)
                        Text(comment.body)
                            .font(.subheadline)
                            .foregroundStyle(Palette.ink)
                    }
                    .padding(.vertical, 2)
                    .listRowBackground(Fill.card)
                }
            }
            Section("Reviews") {
                if pr.reviewers.isEmpty {
                    Text("Nobody yet").foregroundStyle(Palette.ink2).listRowBackground(Fill.card)
                }
                ForEach(pr.reviewers, id: \.name) { reviewer in
                    HStack {
                        Text(reviewer.team ? "\(reviewer.name) (team)" : reviewer.name)
                            .foregroundStyle(Palette.ink)
                        Spacer()
                        Text(PullRequestWords.reviewer(reviewer.state))
                            .foregroundStyle(reviewer.state == "changes_requested" ? Palette.orange : Palette.ink2)
                    }
                    .font(.subheadline)
                    .listRowBackground(Fill.card)
                }
            }
            Section("Description") {
                Group {
                    if body.isEmpty {
                        Text("No description provided.").foregroundStyle(Palette.ink2)
                    } else {
                        MarkdownView(body)
                    }
                }
                .listRowBackground(Fill.card)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .softEdges(ground: Ground.grouped)
    }

    private func load() async {
        guard model.isConnected else { return }
        do {
            lookup = try await model.pullRequest(in: sessionId)
            problem = nil
        } catch {
            problem = AppModel.describe(error)
        }
    }
}

/// A request's state, its mark and its word: the one place on the page a status is a pill.
private struct StatePill: View {
    let pr: PullRequest

    var body: some View {
        let state = PullRequestWords.state(pr)
        Label(state.word, systemImage: state.symbol)
            .font(.caption.weight(.semibold))
            .foregroundStyle(Palette.ink)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Palette.mark, in: Capsule())
    }
}

/// One of the page's facts: a glyph and a sentence, amber only for what failed.
private struct FactRow: View {
    let fact: PullRequestWords.Fact

    var body: some View {
        Label {
            Text(fact.text).foregroundStyle(fact.tone == .bad ? Palette.orange : Palette.ink)
        } icon: {
            Image(systemName: Self.symbol(fact.tone))
                .foregroundStyle(fact.tone == .bad ? Palette.orange : Palette.ink2)
        }
        .font(.subheadline)
    }

    static func symbol(_ tone: PullRequestWords.Tone) -> String {
        switch tone {
        case .ok: "checkmark.circle"
        case .bad: "exclamationmark.circle"
        case .wait: "clock"
        case .quiet: "info.circle"
        }
    }
}

/// A check by name: amber where it failed, its run a press away where GitHub gives one.
private struct CheckRow: View {
    let check: PullRequest.Check

    var body: some View {
        let failed = check.state == "failure"
        HStack(spacing: 10) {
            Image(systemName: Self.symbol(check.state))
                .foregroundStyle(failed ? Palette.orange : Palette.ink3)
                .frame(width: 24)
            Text(check.name)
                .foregroundStyle(failed ? Palette.orange : Palette.ink)
            Spacer()
            Text(Self.word(check.state))
                .foregroundStyle(failed ? Palette.orange : Palette.ink2)
            if let url = check.url.flatMap(URL.init(string:)) {
                Link(destination: url) {
                    Image(systemName: "arrow.up.right").font(.caption)
                }
                .accessibilityLabel("Open \(check.name) on GitHub")
            }
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }

    static func symbol(_ state: String) -> String {
        switch state {
        case "success": "checkmark.circle"
        case "failure": "xmark.circle.fill"
        case "pending": "clock"
        default: "minus.circle"
        }
    }

    static func word(_ state: String) -> String {
        switch state {
        case "success": "Passed"
        case "failure": "Failed"
        case "pending": "Running"
        default: "Skipped"
        }
    }
}
