import RealmKit
import SwiftUI

/// A session's info, opened from its title: who answers it and in which space, where it runs, how it
/// stands, what it has cost and when it began, then the files it made or was sent and its sub-agents.
/// What the row already holds is drawn at once; the rest comes with `session.info`, and a Mac that does
/// not answer it gets a sheet without those parts rather than a sheet of blanks.
struct SessionInfoSheet: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var previewing: SessionFile?
    @State private var moveShown = false
    @State private var expandedSubagents: Set<String> = []

    var body: some View {
        let transcript = model.store.transcript(sessionId)
        let row = transcript.session.map { model.rowEdits.applied(to: $0) ?? $0 }
        let info = model.work.info[sessionId]
        let subagents = model.work.subagents[sessionId] ?? []
        NavigationStack {
            List {
                if let row {
                    Section {
                        LabeledContent("Agent") {
                            HStack(spacing: 6) {
                                AgentMark(kind: row.agent, mark: row.agentMark, size: 14, relativeTo: .body)
                                Text(row.agentDisplayName)
                            }
                        }
                        if let modelName = row.modelDisplayName, !modelName.isEmpty {
                            LabeledContent("Model", value: modelName)
                        }
                        if !row.spaceName.isEmpty {
                            LabeledContent("Space", value: row.spaceName)
                        }
                        LabeledContent("Status") {
                            Text(SessionInfoWords.status(transcript.status ?? row.status))
                        }
                    }
                    .listRowBackground(Fill.card)
                }
                if let runsOn = info?.runsOn {
                    // A Mac before moves gives no options, and the section only says where it runs.
                    RunsOnSection(runsOn: runsOn, move: model.moveOptions[sessionId] == nil ? nil : { moveShown = true })
                }
                if let usage = info?.usage {
                    Section("Usage") {
                        LabeledContent("Cost", value: SessionInfoWords.cost(usage))
                            .monospacedDigit()
                        LabeledContent("Tokens", value: SessionInfoWords.tokens(usage))
                            .monospacedDigit()
                        if usage.turns > 0 {
                            LabeledContent("Turns", value: "\(usage.turns)")
                                .monospacedDigit()
                        }
                    }
                    .listRowBackground(Fill.card)
                }
                if let row {
                    Section {
                        if let createdAt = row.createdAt {
                            LabeledContent("Started", value: Date(timeIntervalSince1970: createdAt / 1000).formatted(date: .abbreviated, time: .shortened))
                        }
                        LabeledContent("Last active", value: Ago.text(row.lastActivity))
                    }
                    .listRowBackground(Fill.card)
                }
                if let files = info?.files, !files.isEmpty {
                    Section("Files") {
                        ForEach(files) { file in
                            Button {
                                previewing = file
                            } label: {
                                SessionFileRow(file: file)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .listRowBackground(Fill.card)
                }
                if !subagents.isEmpty {
                    let prefix = SubagentWords.sharedPrefix(subagents)
                    Section("Sub-agents") {
                        // The sheet's order without its heads: the failed first, the done last.
                        ForEach(SubagentGroup.ordered(subagents)) { subagent in
                            SubagentRow(subagent: subagent, title: SubagentWords.title(subagent, dropping: prefix),
                                        expanded: $expandedSubagents.holds(subagent.id)) {
                                dismiss()
                                model.path.append(.session(subagent.id))
                            }
                        }
                    }
                    .listRowBackground(Fill.card)
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Ground.grouped)
            .navigationTitle(row?.displayTitle ?? "Session")
            .navigationBarTitleDisplayMode(.inline)
            // The scroll edge only fades the rows: pulled up and scrolled, they read through the title.
            .toolbarBackground(Ground.grouped, for: .navigationBar)
            .toolbarBackgroundVisibility(.visible, for: .navigationBar)
            .toolbar {
                // At the trailing corner, as every sheet whose only control is its close has it.
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .close) { dismiss() }
                        .accessibilityLabel("Close")
                }
            }
        }
        // At the accessibility sizes half the screen holds less than the first section.
        .presentationDetents(dynamicTypeSize.isAccessibilitySize ? [.large] : [.medium, .large])
        // Pulled up to full height the system's sheet turns opaque white, and the cards go with it.
        .presentationBackground(Ground.grouped)
        .sheet(item: $previewing) { file in
            FilePreviewSheet(path: file.path, name: file.name, sessionId: sessionId, size: file.size)
        }
        .sheet(isPresented: $moveShown) {
            MoveSheet(sessionId: sessionId)
        }
        // Moved, it runs somewhere else.
        .onChange(of: moveShown) { _, shown in
            if !shown { Task { await model.work.loadInfo(sessionId) } }
        }
        .task {
            async let info: Void = model.work.loadInfo(sessionId)
            async let subagents: Void = model.work.loadSubagents(sessionId)
            async let moves: Void = model.loadMoveOptions(sessionId)
            _ = await (info, subagents, moves)
        }
    }
}

/// Where the session runs: the Mac, the kind of checkout, its folder and its branch. A section of its
/// own, as one place to say it, which opens the Move sheet where the Mac can move the session.
struct RunsOnSection: View {
    let runsOn: RunsOn
    /// Opens where the session could be moved to; nil where its Mac cannot move it.
    var move: (() -> Void)?

    var body: some View {
        Section("Runs on") {
            LabeledContent("Mac") {
                Label(runsOn.machine, systemImage: "laptopcomputer")
                    .labelStyle(.titleAndIcon)
            }
            LabeledContent(SessionInfoWords.checkout(runsOn.checkout)) {
                Text(runsOn.folder)
                    .mono(.subheadline)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            if let branch = runsOn.branch {
                LabeledContent("Branch") {
                    Text(branch)
                        .mono(.subheadline)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            if let move {
                Button("Move this session", systemImage: "arrow.triangle.branch", action: move)
                    .foregroundStyle(Palette.accent)
            }
        }
        .listRowBackground(Fill.card)
    }
}

/// A file of the session's: its kind's glyph, its name, and whether it was made or sent and when.
private struct SessionFileRow: View {
    let file: SessionFile
    @ScaledMetric(relativeTo: .body) private var glyph: CGFloat = 22

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: FileKind.symbol(file.path))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(Palette.ink2)
                .frame(width: glyph)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.name)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(SessionInfoWords.fileLine(file))
                    .font(.footnote)
                    .foregroundStyle(Palette.ink2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Palette.ink3)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(file.name), \(SessionInfoWords.fileLine(file))")
        .accessibilityHint("Opens a preview")
    }
}

/// What the info sheet says in words.
enum SessionInfoWords {
    /// The status as the session's bar says it, a turn under way as Working.
    static func status(_ status: SessionStatus) -> String {
        status == .running ? "Working" : status.word
    }

    static func checkout(_ kind: String) -> String {
        switch kind {
        case "primary": "Space folder"
        case "worktree": "Worktree"
        default: "Checkout"
        }
    }

    /// "$3.50"; "About $3.50" where some of it is the catalog's price for tokens rather than dollars the
    /// agent stated.
    static func cost(_ usage: SessionUsage, locale: Locale = .current) -> String {
        let dollars = Money.text(usage.costUsd, locale: locale)
        return usage.estimated ? "About \(dollars)" : dollars
    }

    /// "21.3K in · 4K out".
    static func tokens(_ usage: SessionUsage, locale: Locale = .current) -> String {
        let count = { (n: Double) in n.formatted(.number.notation(.compactName).precision(.fractionLength(0...1)).locale(locale)) }
        return "\(count(usage.inputTokens)) in · \(count(usage.outputTokens)) out"
    }

    /// "Made 2m ago · 4 kB", "Sent 3h ago".
    static func fileLine(_ file: SessionFile, now: Date = Date()) -> String {
        let made = "\(file.sent ? "Sent" : "Made") \(Ago.text(file.at, now: now))"
        guard let size = file.size else { return made }
        return "\(made) · \(Int64(size).formatted(.byteCount(style: .file)))"
    }
}
