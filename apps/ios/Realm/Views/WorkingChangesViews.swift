import RealmKit
import SwiftUI

/// The Changes screen, pushed from a turn's changes.
struct CheckoutRoute: Hashable {
    let sessionId: String
}

/// One side of one checkout file's diff.
struct CheckoutDiffRoute: Hashable {
    let file: CheckoutFile
    let staged: Bool
}

/// A session's pull request, pushed from its Changes.
struct PullRequestRoute: Hashable {
    let sessionId: String
}

/// The session's checkout in a sheet, from its menu.
struct CheckoutSheet: View {
    let sessionId: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            WorkingChangesView(sessionId: sessionId)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Close", systemImage: "xmark") { dismiss() }
                    }
                    .sharedBackgroundVisibility(.hidden)
                }
        }
    }
}

/// The desktop's diff pane on the phone: the session's checkout as it is now, staged files over the
/// rest, each opening its diff; staging per file, as the desktop stages; and at the foot the commit bar,
/// whose Commit opens the message and whose outward steps are asked about first.
struct WorkingChangesView: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @State private var tree: WorkingTree?
    /// The checkout was read and is no repository.
    @State private var noRepository = false
    @State private var problem: String?
    @State private var flow = ShipFlow()
    @State private var committing = false
    @State private var confirming: ShipStep?

    var body: some View {
        Group {
            if let tree {
                list(tree)
            } else if noRepository {
                ContentUnavailableView("No git repository", systemImage: "folder",
                                       description: Text("There is no git repository here, so there is nothing to diff."))
            } else if let problem {
                ContentUnavailableView("The changes did not load", systemImage: "exclamationmark.triangle", description: Text(problem))
            } else if model.isConnected {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView("The changes are on your Mac", systemImage: "laptopcomputer",
                                       description: Text("This iPhone shows them while your Mac is connected."))
            }
        }
        .background(Ground.grouped)
        .navigationTitle(tree.flatMap(CheckoutWords.title) ?? "Changes")
        .navigationSubtitle(tree.map(CheckoutWords.meta) ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: PullRequestRoute(sessionId: sessionId)) {
                    Label("Pull request", systemImage: "arrow.triangle.pull")
                }
                .accessibilityIdentifier("changes-pull-request")
            }
            .sharedBackgroundVisibility(.hidden)
        }
        .navigationDestination(for: CheckoutDiffRoute.self) { route in
            DiffView(file: CheckoutWords.row(route.file), source: .checkout(staged: route.staged), sessionId: sessionId)
                .navigationSubtitle([ChangesWords.folder(route.file.path), route.staged ? "Staged" : "Not staged"].compactMap { $0 }.joined(separator: " · "))
                .backOnGround()
        }
        .navigationDestination(for: PullRequestRoute.self) { route in
            PullRequestView(sessionId: route.sessionId)
                .backOnGround()
        }
        .sheet(isPresented: $committing) {
            CommitSheet(tree: tree, flow: $flow) { step in
                committing = false
                run(step)
            }
        }
        .shipConfirmation($confirming, tree: tree, message: confirming.map(flow.message(for:)) ?? "") { run($0) }
        .task(id: model.channelGeneration) { await load() }
        .refreshable { await load() }
    }

    private func list(_ tree: WorkingTree) -> some View {
        let staged = tree.files.filter(\.staged)
        let unstaged = tree.files.filter(\.unstaged)
        return List {
            if !flow.report.isEmpty {
                Section {
                    ForEach(flow.report) { line in
                        ShipLineRow(line: line) { confirming = $0 }
                    }
                    .listRowBackground(Fill.card)
                }
            }
            if tree.files.isEmpty {
                Section {
                    Text("Nothing has changed in this checkout since the last commit.")
                        .foregroundStyle(Palette.ink2)
                        .listRowBackground(Fill.card)
                }
            }
            if !staged.isEmpty {
                fileSection("Staged", files: staged, staged: true, all: "Unstage all")
            }
            if !unstaged.isEmpty {
                fileSection(staged.isEmpty ? "Changes" : "Not staged", files: unstaged, staged: false, all: "Stage all")
            }
            if tree.truncated {
                Section {} footer: {
                    Text("Showing \(tree.files.count) of \(tree.totalFiles) changed files — too many to list at once.")
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .softEdges(ground: Ground.grouped)
        .safeAreaBar(edge: .bottom) { commitBar(tree) }
    }

    private func fileSection(_ title: String, files: [CheckoutFile], staged: Bool, all: String) -> some View {
        Section {
            ForEach(files, id: \.path) { file in
                HStack(spacing: 10) {
                    Button {
                        change([file.path], staged: !staged)
                    } label: {
                        Image(systemName: staged ? "checkmark.circle.fill" : "circle")
                            .font(.title3)
                            .foregroundStyle(staged ? Palette.accent : Palette.ink3)
                            .frame(width: 28, height: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .disabled(flow.working != nil)
                    .accessibilityLabel(staged ? "Unstage \(file.path)" : "Stage \(file.path)")
                    NavigationLink(value: CheckoutDiffRoute(file: file, staged: staged)) {
                        ChangedFileRow(file: CheckoutWords.row(file))
                    }
                }
                .listRowBackground(Fill.card)
                .swipeActions(edge: .trailing) {
                    Button(staged ? "Unstage" : "Stage") { change([file.path], staged: !staged) }
                        .tint(Palette.ink2)
                }
            }
        } header: {
            HStack {
                Text(title)
                Spacer()
                Button(all) { change(files.map(\.path), staged: !staged) }
                    .font(.footnote.weight(.medium))
                    .textCase(nil)
                    .foregroundStyle(Palette.ink)
                    .disabled(flow.working != nil)
            }
        }
    }

    /// The commit bar, lifted over the list as the composer is: what is staged and Commit, or with
    /// nothing staged and commits waiting, Push.
    private func commitBar(_ tree: WorkingTree) -> some View {
        let toPush = !tree.files.contains(where: \.staged) && tree.ahead > 0
        return HStack(spacing: 12) {
            if let working = flow.working {
                ProgressView().controlSize(.small)
                Text(working.call.push ? "Pushing…" : "Committing…")
                    .foregroundStyle(Palette.ink2)
            } else {
                Text(toPush ? "\(CheckoutWords.plural(tree.ahead, "commit")) to push" : CheckoutWords.staged(tree))
                    .foregroundStyle(Palette.ink2)
            }
            Spacer(minLength: 8)
            if toPush {
                Button("Push") { confirming = .push }
                    .buttonStyle(InkButtonStyle())
                    .disabled(flow.working != nil)
            } else {
                Button("Commit") { committing = true }
                    .buttonStyle(InkButtonStyle())
                    .disabled(flow.working != nil || !tree.files.contains(where: \.staged))
                    .accessibilityIdentifier("changes-commit")
            }
        }
        .font(.subheadline)
        .padding(.leading, 18)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .background(Fill.card, in: Capsule())
        .floatingLift()
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    private func load() async {
        guard model.isConnected else { return }
        do {
            let read = try await model.checkout(in: sessionId)
            tree = read
            noRepository = read == nil
            problem = nil
        } catch {
            problem = AppModel.describe(error)
        }
    }

    private func change(_ paths: [String], staged: Bool) {
        Task {
            do {
                tree = try await model.stage(paths, staged: staged, in: sessionId)
            } catch {
                flow.fail(AppModel.describe(error))
            }
        }
    }

    private func run(_ step: ShipStep) {
        let message = flow.message(for: step)
        flow.begin(step)
        Task {
            do {
                flow.finish(try await model.ship(step, message: message, in: sessionId))
            } catch {
                flow.fail(AppModel.describe(error))
            }
            await load()
        }
    }
}

/// A line of a ship's report: its sentence, amber where the person has to act, and its link or retry.
struct ShipLineRow: View {
    let line: ShipLine
    let retry: (ShipStep) -> Void

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 6) {
                Text(line.text)
                    .foregroundStyle(line.bad ? Palette.orange : Palette.ink)
                if let url = line.link {
                    // A link takes the accent, as the app keeps it for links.
                    Link(line.linkTitle ?? url.absoluteString, destination: url)
                        .font(.footnote)
                        .foregroundStyle(Palette.accentInk)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if let step = line.retry {
                    Button(step.title) { retry(step) }
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                        .buttonStyle(.borderless)
                }
            }
        } icon: {
            Image(systemName: line.bad ? "exclamationmark.circle" : line.id == "pr" ? "arrow.triangle.pull" : line.id == "push" ? "arrow.up.circle" : "checkmark.circle")
                .foregroundStyle(line.bad ? Palette.orange : Palette.ink2)
        }
        .font(.subheadline)
        .padding(.vertical, 2)
    }
}

/// The commit message, and the two ways the desktop commits: Commit only, and Commit, push & PR, which
/// says the pull request it would open.
struct CommitSheet: View {
    let tree: WorkingTree?
    @Binding var flow: ShipFlow
    let take: (ShipStep) -> Void
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    @State private var confirming: ShipStep?

    var body: some View {
        let draft = PullRequestDraft(message: flow.message, branch: tree?.branch ?? "this branch")
        NavigationStack {
            List {
                Section {
                    // An editor rather than a field: a commit's message is a subject, a blank line and a body,
                    // and Return in a field ends the editing.
                    TextEditor(text: $flow.message)
                        .frame(minHeight: 96)
                        .scrollContentBackground(.hidden)
                        // A message names files and functions, which a correction would rename.
                        .autocorrectionDisabled()
                        .focused($focused)
                        .overlay(alignment: .topLeading) {
                            if flow.message.isEmpty {
                                Text("Describe the change…")
                                    .foregroundStyle(Palette.ink3)
                                    .padding(.top, 8)
                                    .padding(.leading, 5)
                                    .allowsHitTesting(false)
                            }
                        }
                        .listRowBackground(Fill.card)
                        .accessibilityIdentifier("commit-message")
                } footer: {
                    if let tree {
                        Text("\(CheckoutWords.staged(tree)) on \(tree.branch ?? "a detached HEAD").")
                    }
                }
                Section("Pull request") {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(draft.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(flow.message.isEmpty ? Palette.ink3 : Palette.ink)
                        Text(draft.body.isEmpty ? "The first line is its title; what follows it, its description." : draft.body)
                            .font(.footnote)
                            .foregroundStyle(Palette.ink2)
                            .lineLimit(4)
                    }
                    .padding(.vertical, 2)
                    .listRowBackground(Fill.card)
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Ground.grouped)
            .softEdges(ground: Ground.grouped)
            .safeAreaBar(edge: .bottom) {
                HStack(spacing: 10) {
                    Button(ShipStep.commit.title) { take(.commit) }
                        .buttonStyle(GreyButtonStyle())
                    Button(ShipStep.commitAndPublish.title) { confirming = .commitAndPublish }
                        .buttonStyle(InkButtonStyle())
                        .accessibilityIdentifier("commit-push-pr")
                }
                .disabled(!flow.canCommit(tree))
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            }
            .navigationTitle("Commit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel", systemImage: "xmark") { dismiss() }
                }
                .sharedBackgroundVisibility(.hidden)
            }
            .onAppear { focused = true }
            .shipConfirmation($confirming, tree: tree, message: flow.message) { take($0) }
        }
        .presentationDetents([.medium, .large])
    }
}

extension View {
    /// The question an outward step asks before it goes — what it sends where, and the pull request it
    /// would open — on a sheet of Realm's own ground rather than the system's glass, from wherever the
    /// step was pressed.
    func shipConfirmation(_ step: Binding<ShipStep?>, tree: WorkingTree?, message: String, run: @escaping (ShipStep) -> Void) -> some View {
        sheet(item: step) { taken in
            if let asking = ShipConfirmation(taken, branch: tree?.branch, ahead: tree?.ahead ?? 0, message: message) {
                ConfirmSheet(title: asking.title, message: asking.message, button: asking.button) {
                    step.wrappedValue = nil
                    run(taken)
                }
            }
        }
    }
}
