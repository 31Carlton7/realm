import RealmKit
import SwiftUI

/// Where a session could run instead, from the composer's place chip: its Mac's other checkouts and a
/// new worktree, what goes with it and what stays, and Move — or, during a turn, Move after this turn
/// and Stop and move. A move under way is shown in the transcript, so the sheet goes once the Mac has
/// taken it; a refusal is said here, in the Mac's words.
struct MoveSheet: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var target: MoveTarget?

    /// How long the sheet waits on the Mac's answer before leaving the move to the transcript: a
    /// refusal comes back at once, and a move takes as long as starting the agent in its new place.
    static let refusalWait: Duration = .milliseconds(900)

    var body: some View {
        let options = model.moveOptions[sessionId]
        let transcript = model.store.transcript(sessionId)
        let status = transcript.status ?? transcript.session?.status
        let agent = transcript.session?.agentDisplayName ?? "The agent"
        NavigationStack {
            Form {
                if let options {
                    content(options, agent: agent)
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Fill.card)
                }
            }
            .scrollContentBackground(.hidden)
            .navigationTitle("Move this session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Ground.grouped, for: .navigationBar)
            .toolbarBackgroundVisibility(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
            // On a ground of their own, so the list ends above the buttons rather than running under them.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if let options, options.blocked == nil {
                    buttons(options, working: status == .running || status == .waiting || (status == nil && options.busy))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Ground.grouped)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Ground.grouped)
        .task { await model.loadMoveOptions(sessionId) }
        .onAppear {
            model.moveSheets.insert(sessionId)
            model.moveRefusals[sessionId] = nil
        }
        .onDisappear { model.moveSheets.remove(sessionId) }
        .onChange(of: options?.checkouts, initial: true) {
            if target == nil, let options { target = Self.firstTarget(options) }
        }
    }

    @ViewBuilder
    private func content(_ options: MoveOptions, agent: String) -> some View {
        Section {
            LabeledContent {
                Text(MoveWords.detail(options.from))
                    .mono(.footnote)
                    .foregroundStyle(Palette.ink2)
                    .lineLimit(1)
                    .truncationMode(.middle)
            } label: {
                Label(options.mac, systemImage: "laptopcomputer")
                    .foregroundStyle(Palette.ink)
            }
            .listRowBackground(Fill.card)
        } header: {
            Text("Runs on")
        }
        if let refusal = model.moveRefusals[sessionId] ?? options.blocked.map(MoveWords.blocked) {
            Section {
                Label {
                    Text(refusal)
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Palette.orange)
                }
                .listRowBackground(Fill.card)
                .accessibilityIdentifier("move-refusal")
            }
        }
        if options.blocked == nil {
            Section("Move to") {
                destination(.worktree, title: "New worktree",
                            line: options.worktree.available ? "A new branch off \(options.from.branch ?? "this checkout"), with your changes" : options.worktree.reason.map(MoveWords.sentence),
                            symbol: "arrow.triangle.branch", enabled: options.worktree.available)
                ForEach(options.checkouts) { checkout in
                    destination(.checkout(environmentId: checkout.environmentId), title: checkout.name, line: MoveWords.detail(checkout),
                                symbol: checkout.kind == .worktree ? "arrow.triangle.branch" : "folder", enabled: true, mono: true)
                }
            }
            Section("Goes with it") {
                Group {
                    Text(MoveWords.conversation(options.conversation, agent: agent))
                    if let changes = MoveWords.changes(options.changedFiles) { Text(changes) }
                }
                .foregroundStyle(Palette.ink)
                .listRowBackground(Fill.card)
            }
            if let stops = options.stops, !stops.isEmpty {
                Section {
                    ForEach(stops, id: \.self) { work in
                        Text(MoveWords.leftBehind(work))
                            .foregroundStyle(Palette.ink)
                    }
                    .listRowBackground(Fill.card)
                } header: {
                    Text("Stops")
                } footer: {
                    Text("\(agent) is still running this. Stop and move stops it; it does not go with the session.")
                }
            }
            if !options.leftBehind.isEmpty {
                Section {
                    ForEach(options.leftBehind, id: \.self) { thing in
                        Text(MoveWords.leftBehind(thing))
                            .foregroundStyle(Palette.ink)
                    }
                    .listRowBackground(Fill.card)
                } header: {
                    Text("Stays here")
                } footer: {
                    Text("Your checkout is left as it is.")
                }
            }
        }
    }

    /// A place it could go: its name, a line under it, and a check on the one chosen.
    private func destination(_ place: MoveTarget, title: String, line: String?, symbol: String, enabled: Bool, mono: Bool = false) -> some View {
        Button {
            target = place
        } label: {
            HStack(spacing: 12) {
                Image(systemName: symbol)
                    .font(.body)
                    .foregroundStyle(Palette.ink2)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.body)
                        .foregroundStyle(Palette.ink)
                    if let line {
                        Group {
                            if mono { Text(line).mono(.footnote) } else { Text(line).font(.subheadline) }
                        }
                        .foregroundStyle(Palette.ink2)
                        .lineLimit(2)
                        .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: "checkmark")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Palette.accent)
                    .opacity(target == place ? 1 : 0)
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
        .listRowBackground(Fill.card)
        .accessibilityAddTraits(target == place ? .isSelected : [])
    }

    /// Move, or during a turn Move after this turn and Stop and move; Cancel the move once one is queued
    /// or under way.
    @ViewBuilder
    private func buttons(_ options: MoveOptions, working: Bool) -> some View {
        let asked = model.movesAsked[sessionId]
        if options.pending && asked == nil {
            Button {
                Task { await model.cancelMove(sessionId) }
            } label: {
                Text("Cancel the move")
                    .lineLimit(1)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(GreyButtonStyle())
            .controlSize(.large)
            .buttonBorderShape(.capsule)
            .font(.body.weight(.semibold))
        } else {
            let whens = MoveWords.whens(working: working, stopping: !(options.stops ?? []).isEmpty)
            VStack(spacing: 10) {
                ForEach(Array(whens.enumerated()), id: \.element) { index, when in
                    let button = Button {
                        move(when)
                    } label: {
                        HStack(spacing: 8) {
                            if asked == when { ProgressView().controlSize(.small) }
                            Text(when.title).lineLimit(1)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .disabled(target == nil || asked != nil)
                    if index == 0 { button.buttonStyle(InkButtonStyle()) } else { button.buttonStyle(GreyButtonStyle()) }
                }
            }
            .controlSize(.large)
            .buttonBorderShape(.capsule)
            .font(.body.weight(.semibold))
        }
    }

    private func move(_ when: MoveWhen) {
        guard let target else { return }
        let call = Task { await model.move(sessionId, to: target, when: when) }
        Task {
            try? await Task.sleep(for: Self.refusalWait)
            // Still going: the transcript's progress row says how far it has got.
            if model.movesAsked[sessionId] != nil { dismiss() }
        }
        Task {
            if await call.value { dismiss() }
        }
    }

    /// What the sheet starts on: a new worktree where one can be made, else the first other checkout.
    static func firstTarget(_ options: MoveOptions) -> MoveTarget? {
        if options.worktree.available { return .worktree }
        return options.checkouts.first.map { .checkout(environmentId: $0.environmentId) }
    }
}
