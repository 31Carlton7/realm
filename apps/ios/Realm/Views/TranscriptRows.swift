import RealmKit
import SwiftUI
import UIKit

/// One row of a transcript, by its kind, each in a shape of its own: what was said, the work done, a
/// decision, what a turn changed or made, a notice. A kind this version cannot draw says so, never
/// blank.
struct TranscriptRowView: View {
    let row: TranscriptRow
    let sessionId: String
    /// The changes of this row's turn, which a tool line's diff is read from.
    var checkpointAfter: String?

    var body: some View {
        switch row.content {
        case .user(let text):
            UserBubble(text: text)
        case .assistant(let text, let streaming):
            VStack(alignment: .leading, spacing: 8) {
                MarkdownView(text)
                if streaming {
                    Label("Writing…", systemImage: "ellipsis")
                        .font(.footnote)
                        .foregroundStyle(Palette.ink2)
                        .restingPulse(when: true)
                }
            }
        case .thinking, .tool:
            WorkRun(rows: [row], sessionId: sessionId, checkpointAfter: checkpointAfter)
        case .request(let request):
            RequestCard(request: request, sessionId: sessionId)
        case .plan(let text, let steps):
            PlanCard(text: text, steps: steps ?? [])
        case .notice(let text):
            if let checkpointId = row.checkpointId {
                ChangesCard(checkpointId: checkpointId, sessionId: sessionId, summary: text)
            } else if let files = row.madeFiles, !files.isEmpty {
                MadeFilesRow(files: files, sessionId: sessionId, summary: text)
            } else {
                NoticeLine(text: text)
            }
        case .error(let text, let hint):
            ErrorCard(text: text, hint: hint)
        case .unknown(let kind, let type):
            OpenOnMacView(kind: type ?? kind)
        }
    }
}

/// What the person sent: right of the column, in a bubble a step off the transcript. Held, it copies.
struct UserBubble: View {
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 56)
            Text(text)
                .font(.body)
                .foregroundStyle(Palette.ink)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Fill.bubble, in: RoundedRectangle(cornerRadius: Radius.bubble, style: .continuous))
                .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: Radius.bubble, style: .continuous))
                .contextMenu {
                    Button("Copy", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = text
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    }
                }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You: \(text)")
    }
}

/// A message on its way: Sending… until the Mac has it, and what is in the way when it cannot go.
struct OutgoingMessageView: View {
    let item: OutgoingItem

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if case .message(let text) = item.payload {
                HStack(alignment: .center, spacing: 8) {
                    if item.isFailed {
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.title3)
                            .foregroundStyle(Palette.red)
                            .accessibilityHidden(true)
                    }
                    UserBubble(text: text)
                }
            }
            OutgoingStatusView(item: item)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/// Where an outgoing message or answer is, in words: Sending…, waiting for the Mac and why, Sent, or
/// the Mac's refusal with what can be done about it.
struct OutgoingStatusView: View {
    let item: OutgoingItem
    var alignment: HorizontalAlignment = .trailing
    @Environment(AppModel.self) private var model

    var body: some View {
        switch item.state {
        case .sending, .unconfirmed:
            label("Sending…", symbol: nil, tone: .quiet)
        case .waiting:
            let status = model.linkStatus
            label(status.kind == .connected ? "Sending…" : status.waitingNote,
                  symbol: status.kind == .connected ? nil : status.symbol, tone: .quiet)
        case .delivered:
            label(item.isMessage ? "Sent" : "Sent to your Mac", symbol: "checkmark", tone: .quiet)
        case .failed(let reason):
            VStack(alignment: alignment, spacing: 8) {
                label(reason, symbol: "exclamationmark.triangle.fill", tone: .failed)
                HStack(spacing: 10) {
                    Button("Delete", role: .destructive) { model.discard(item) }
                    Button("Try again") { model.retry(item) }
                        .tint(Palette.ink)
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
            }
        }
    }

    private func label(_ text: String, symbol: String?, tone: Tone) -> some View {
        HStack(spacing: 5) {
            if let symbol {
                Image(systemName: symbol)
            } else {
                ProgressView()
                    .controlSize(.mini)
            }
            Text(text)
                .multilineTextAlignment(alignment == .trailing ? .trailing : .leading)
        }
        .font(.footnote)
        .foregroundStyle(tone.color)
        .accessibilityElement(children: .combine)
    }
}

/// A run of tool calls and thinking: the work done between two things said, each as one quiet line
/// that opens to its detail. The work is there to be looked into, not read past the result.
struct WorkRun: View {
    let rows: [TranscriptRow]
    let sessionId: String
    var checkpointAfter: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(rows) { row in
                switch row.content {
                case .tool(let name, let summary, let state, let detail):
                    ToolLine(name: name, summary: summary, state: state, detail: detail, sessionId: sessionId,
                             checkpointId: Edits.changes(name) ? checkpointAfter : nil)
                case .thinking(let text):
                    ThinkingLine(text: text)
                default:
                    EmptyView()
                }
            }
        }
        .padding(.vertical, -4)
    }
}

/// A finished turn's work, folded under one quiet line — "Worked · 6 steps" — so a long session reads
/// prompt, answer, prompt, answer. It opens to the work as it happened.
struct FoldedWork: View {
    let rows: [TranscriptRow]
    let sessionId: String
    var checkpointAfter: String?
    @State private var open = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(Motion.animation(reduceMotion)) { open.toggle() }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "checklist.checked")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.ink3)
                        .frame(width: 20)
                    Text(Self.summary(rows))
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Palette.ink2)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Palette.ink3)
                        .rotationEffect(.degrees(open ? 90 : 0))
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 4)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(LineButtonStyle())
            .sensoryFeedback(.selection, trigger: open)
            .accessibilityLabel(Self.summary(rows))
            .accessibilityValue(open ? "Open" : "Folded")
            if open {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(TranscriptLayout.items(rows, settled: false)) { item in
                        TranscriptItemView(item: item, sessionId: sessionId, checkpointAfter: checkpointAfter)
                    }
                }
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    Capsule().fill(Palette.mark).frame(width: 2)
                }
                .transition(.opacity)
            }
        }
    }

    /// "Worked · 6 steps": the tool calls and the thinking the turn did before its answer.
    static func summary(_ rows: [TranscriptRow]) -> String {
        let steps = rows.filter {
            switch $0.content {
            case .tool, .thinking: true
            default: false
            }
        }.count
        return "Worked · \(steps) \(steps == 1 ? "step" : "steps")"
    }
}

/// While a turn runs and nothing else on screen says what it is doing: the one live line, in present
/// tense, that rests after a few sweeps.
struct LiveLine: View {
    let thinking: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "progress.indicator")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Palette.accentInk)
                .restingPulse(when: true)
                .frame(width: 20)
            Text(thinking ? "Thinking" : "Working")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Palette.ink2)
                .shimmer(when: true)
        }
        .padding(.horizontal, 4)
        .frame(minHeight: 32)
        .accessibilityElement(children: .combine)
    }
}

/// What a tool's line says it did, in the tense of its state — "Running pnpm test" while it runs,
/// "Ran pnpm test" once done — with what it acted on, which is shown in mono.
enum ToolWords {
    struct Line: Equatable {
        let verb: String
        let object: String?
    }

    static func line(tool: String, summary: String, running: Bool) -> Line {
        let acted = summary.isEmpty || summary == tool ? nil : summary
        if let (present, past) = verbs[tool] {
            return Line(verb: running ? present : past, object: acted)
        }
        if planTools.contains(tool) {
            return Line(verb: running ? "Updating the plan" : "Updated the plan", object: nil)
        }
        return Line(verb: running ? "Calling \(tool)" : "Called \(tool)", object: acted)
    }

    private static let planTools: Set<String> = ["TodoWrite", "update_plan", "todo_write"]

    private static let verbs: [String: (String, String)] = {
        var table: [String: (String, String)] = [:]
        let groups: [([String], (String, String))] = [
            (["Bash", "Shell", "shell", "exec_command", "local_shell", "run_command"], ("Running", "Ran")),
            (["Read", "read_file", "view", "ReadFile"], ("Reading", "Read")),
            (["Edit", "MultiEdit", "NotebookEdit", "str_replace", "str_replace_based_edit_tool", "apply_patch", "edit_file"], ("Editing", "Edited")),
            (["Write", "write_file", "create_file"], ("Writing", "Wrote")),
            (["Grep", "Glob", "grep", "glob", "find", "search", "codebase_search", "file_search"], ("Searching", "Searched")),
            (["LS", "ls", "list_dir"], ("Listing", "Listed")),
            (["WebFetch", "fetch", "web_fetch"], ("Fetching", "Fetched")),
            (["WebSearch", "web_search"], ("Searching the web for", "Searched the web for")),
            (["Task", "Agent", "spawn_agent"], ("Handing off", "Handed off")),
        ]
        for (tools, words) in groups { for tool in tools { table[tool] = words } }
        return table
    }()
}

/// The tools whose work is a file changed, so their line opens onto the change itself.
enum Edits {
    static func changes(_ tool: String) -> Bool {
        ["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch"].contains(tool)
    }

    /// The changed file a tool's summary names: the one whose path ends the summary, or that the
    /// summary ends, however either was shortened.
    static func file(named summary: String, in changes: TurnChanges) -> ChangedFile? {
        let named = summary.trimmingCharacters(in: .whitespaces)
        guard !named.isEmpty else { return nil }
        return changes.files.first { named.hasSuffix($0.path) || $0.path.hasSuffix(named) }
    }
}

/// A line of the work that opens: the press is a fill, arriving at once, never a size.
private struct LineButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Palette.hover : .clear, in: RoundedRectangle(cornerRadius: Radius.well, style: .continuous))
    }
}

private struct ToolLine: View {
    let name: String
    let summary: String
    let state: ToolState
    let detail: String?
    let sessionId: String
    /// The turn's changes, when this tool changed a file and its turn has settled.
    let checkpointId: String?
    @State private var open = false
    @State private var showingAll = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// A tool's output shows this many lines in place; the rest opens in a sheet of its own.
    static let previewLines = 16

    var body: some View {
        let words = ToolWords.line(tool: name, summary: summary, running: state == .running)
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(Motion.animation(reduceMotion)) { open.toggle() }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    ToolStateGlyph(state: state)
                        .frame(width: 20)
                    Text(words.verb)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Palette.ink2)
                        .fixedSize()
                        .shimmer(when: state == .running)
                    if let object = words.object {
                        Text(object)
                            .mono(.footnote)
                            .foregroundStyle(Palette.ink2)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Palette.ink3)
                        .rotationEffect(.degrees(open ? 90 : 0))
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 4)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(LineButtonStyle())
            .sensoryFeedback(.selection, trigger: open)
            .accessibilityLabel("\([words.verb, words.object].compactMap { $0 }.joined(separator: " "))\(state == .error ? ", failed" : "")")
            .accessibilityValue(open ? "Open" : "Folded")
            if open {
                Group {
                    if let checkpointId {
                        InlineDiff(path: summary, checkpointId: checkpointId, sessionId: sessionId)
                    } else {
                        output
                    }
                }
                .padding(.leading, 32)
                .padding(.bottom, 6)
                .transition(.opacity)
            }
        }
    }

    private var output: some View {
        let text = detail ?? (state == .running ? "Still running." : "No output.")
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        return VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal) {
                Text(lines.prefix(Self.previewLines).joined(separator: "\n"))
                    .mono(.caption)
                    .foregroundStyle(detail == nil ? Palette.ink2 : Palette.ink)
                    .textSelection(.enabled)
                    .fixedSize()
                    .padding(12)
            }
            .scrollIndicators(.hidden)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Fill.card, in: RoundedRectangle(cornerRadius: Radius.well, style: .continuous))
            if lines.count > Self.previewLines {
                Button("Show all \(lines.count) lines") { showingAll = true }
                    .font(.footnote.weight(.medium))
                    .padding(.leading, 4)
            }
        }
        .sheet(isPresented: $showingAll) {
            OutputSheet(title: name, summary: summary, output: text)
        }
    }
}

/// A tool's state by the shape of its glyph: a run's indicator, a check, a cross.
private struct ToolStateGlyph: View {
    let state: ToolState

    var body: some View {
        let (symbol, tone): (String, Tone) = switch state {
        case .running: ("progress.indicator", .working)
        case .done: ("checkmark", .quiet)
        case .error: ("xmark.circle.fill", .failed)
        }
        Image(systemName: symbol)
            .font(.footnote.weight(.semibold))
            .symbolRenderingMode(.hierarchical)
            .foregroundStyle(tone.color)
            .restingPulse(when: state == .running)
            .contentTransition(.symbolEffect(.replace))
            .accessibilityHidden(true)
    }
}

/// The whole of a long output, read to its last character in both directions.
private struct OutputSheet: View {
    let title: String
    let summary: String
    let output: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView([.horizontal, .vertical]) {
                Text(output)
                    .mono(.caption)
                    .foregroundStyle(Palette.ink)
                    .textSelection(.enabled)
                    .fixedSize()
                    .padding(16)
            }
            .background(Ground.transcript)
            .navigationTitle(title)
            .navigationSubtitle(summary)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

/// Thinking is folded: a quiet line that opens to the words.
private struct ThinkingLine: View {
    let text: String
    @State private var open = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(Motion.animation(reduceMotion)) { open.toggle() }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "ellipsis")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.ink3)
                        .frame(width: 20)
                    Text("Thinking")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Palette.ink2)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Palette.ink3)
                        .rotationEffect(.degrees(open ? 90 : 0))
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 4)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(LineButtonStyle())
            .sensoryFeedback(.selection, trigger: open)
            .accessibilityLabel("Thinking")
            .accessibilityValue(open ? "Open" : "Folded")
            if open {
                Text(text)
                    .font(.subheadline)
                    .italic()
                    .foregroundStyle(Palette.ink2)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 32)
                    .padding(.bottom, 8)
            }
        }
    }
}

/// The agent's plan, and its steps with where each one is.
struct PlanCard: View {
    let text: String?
    let steps: [PlanStep]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Label("Plan", systemImage: "checklist")
                    .font(.headline)
                    .foregroundStyle(Palette.ink)
                Spacer(minLength: 8)
                if !steps.isEmpty {
                    Text(PlanSteps.progress(steps))
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(Palette.ink2)
                }
            }
            if !steps.isEmpty {
                PlanSteps(steps: steps)
            }
            if let text, !text.isEmpty {
                MarkdownView(text)
                    .environment(\.proseGround, .card)
            }
        }
        .padding(Radius.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .surface()
    }
}

/// A plan's steps, each with the glyph and the word for where it is.
struct PlanSteps: View {
    let steps: [PlanStep]

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: Self.symbol(step.status))
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(Self.tone(step.status).color)
                        .frame(width: 22)
                    Text(step.text)
                        .font(.body)
                        .foregroundStyle(step.status == "completed" ? Palette.ink2 : Palette.ink)
                        .strikethrough(step.status == "completed", color: Palette.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
                .accessibilityValue(Self.word(step.status))
            }
        }
    }

    /// "1 of 3 done".
    static func progress(_ steps: [PlanStep]) -> String {
        "\(steps.filter { $0.status == "completed" }.count) of \(steps.count) done"
    }

    static func symbol(_ status: String) -> String {
        switch status {
        case "completed": "checkmark.circle.fill"
        case "in_progress": "circle.dotted.circle"
        default: "circle"
        }
    }

    static func tone(_ status: String) -> Tone {
        switch status {
        case "completed": .done
        case "in_progress": .working
        default: .quiet
        }
    }

    static func word(_ status: String) -> String {
        switch status {
        case "completed": "Done"
        case "in_progress": "In progress"
        case "pending": "Not started"
        default: status
        }
    }
}

/// What one turn changed, as a card that opens the files and their diffs: the count and the lines
/// added and taken away, each in its colour and with its sign, then the first few files.
struct ChangesCard: View {
    let checkpointId: String
    let sessionId: String
    /// The Mac's own line for it, said until the files arrive or where they cannot.
    let summary: String
    @Environment(AppModel.self) private var model
    @State private var reviewing = false

    static let listed = 3

    var body: some View {
        let changes = model.turnChanges[checkpointId]
        Button {
            reviewing = true
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "plusminus")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.ink2)
                    Text(changes.map(ChangesWords.files) ?? summary)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(2)
                    Spacer(minLength: 8)
                    if let changes, changes.countsLines {
                        LineCounts(additions: changes.additions, deletions: changes.deletions)
                    }
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Palette.ink3)
                }
                if let changes {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(changes.files.prefix(Self.listed), id: \.path) { file in
                            HStack(spacing: 8) {
                                Text(ChangesWords.name(file.path))
                                    .mono(.footnote)
                                    .foregroundStyle(Palette.ink2)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                Spacer(minLength: 8)
                                LineCounts(additions: file.additions, deletions: file.deletions, binary: file.additions == nil)
                            }
                        }
                        if changes.totalFiles > Self.listed {
                            Text("\(changes.totalFiles - Self.listed) more")
                                .font(.footnote)
                                .foregroundStyle(Palette.ink2)
                        }
                    }
                    .padding(.leading, 24)
                }
            }
            .padding(Radius.cardPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        }
        .buttonStyle(CardButtonStyle())
        .accessibilityLabel(changes?.spoken ?? summary)
        .task(id: checkpointId) { await model.loadChanges(checkpointId, in: sessionId) }
        .sheet(isPresented: $reviewing) {
            ChangesSheet(checkpointId: checkpointId, sessionId: sessionId)
        }
        .accessibilityHint("Opens the changed files and their diffs")
    }
}

/// A card that opens: a surface a step off the ground, its press one rung up, arriving at once.
struct CardButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Palette.hover : Fill.card,
                        in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
    }
}

/// Lines added and taken away, each with its sign and in its colour, never colour alone.
struct LineCounts: View {
    let additions: Int?
    let deletions: Int?
    var binary = false

    var body: some View {
        if binary {
            Text("Binary")
                .font(.footnote)
                .foregroundStyle(Palette.ink2)
        } else {
            HStack(spacing: 6) {
                Text("+\(additions ?? 0)").foregroundStyle(Palette.green)
                Text("−\(deletions ?? 0)").foregroundStyle(Palette.red)
            }
            .font(.footnote.weight(.medium))
            .monospacedDigit()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(additions ?? 0) lines added, \(deletions ?? 0) taken away")
        }
    }
}

/// How a turn's changes are said.
enum ChangesWords {
    /// "Changed 3 files".
    static func files(_ changes: TurnChanges) -> String {
        "Changed \(changes.totalFiles) \(changes.totalFiles == 1 ? "file" : "files")"
    }

    /// A path's own name, its last part.
    static func name(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    /// The folder a path is in, or nil at the top.
    static func folder(_ path: String) -> String? {
        let parts = path.split(separator: "/")
        return parts.count > 1 ? parts.dropLast().joined(separator: "/") : nil
    }
}

extension TurnChanges {
    var additions: Int { files.compactMap(\.additions).reduce(0, +) }
    var deletions: Int { files.compactMap(\.deletions).reduce(0, +) }
    /// Whether any of it has lines to count: a turn that changed only pictures has none, and "+0 −0"
    /// beside it would say it changed nothing.
    var countsLines: Bool { files.contains { $0.additions != nil } }
    /// What it comes to, said: "Changed 2 files, 20 lines added, 3 taken away".
    var spoken: String {
        countsLines ? "\(ChangesWords.files(self)), \(additions) lines added, \(deletions) taken away" : ChangesWords.files(self)
    }
}

/// The files a turn made — a picture rendered, a file written for the person — as tiles that open a
/// preview the Mac makes of each.
struct MadeFilesRow: View {
    let files: [MadeFile]
    let sessionId: String
    let summary: String
    @State private var previewing: MadeFile?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(summary)
                .font(.footnote)
                .foregroundStyle(Palette.ink2)
            ScrollView(.horizontal) {
                HStack(spacing: 10) {
                    ForEach(files, id: \.path) { file in
                        Button {
                            previewing = file
                        } label: {
                            FileTile(file: file)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .scrollIndicators(.hidden)
        }
        .sheet(item: $previewing) { file in
            FilePreviewSheet(file: file, sessionId: sessionId)
        }
    }
}

extension MadeFile: @retroactive Identifiable {
    public var id: String { path }
}

/// A file as one square tile: its kind's glyph in the middle, its name at the foot.
private struct FileTile: View {
    let file: MadeFile
    @ScaledMetric(relativeTo: .footnote) private var side: CGFloat = 92

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: FileKind.symbol(file.path))
                .font(.title2)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(Palette.ink2)
                .frame(maxHeight: .infinity)
            Text(file.name)
                .font(.caption)
                .foregroundStyle(Palette.ink)
                .lineLimit(2)
                .multilineTextAlignment(.center)
        }
        .padding(10)
        .frame(width: side, height: side)
        .background(Fill.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(file.name)
        .accessibilityHint("Opens a preview")
    }
}

/// A file's kind by its extension, as the glyph that says it.
enum FileKind {
    static func symbol(_ path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "png", "jpg", "jpeg", "gif", "heic", "webp", "svg", "tiff": "photo"
        case "mov", "mp4", "m4v", "webm": "film"
        case "pdf": "doc.richtext"
        case "md", "txt", "rtf": "doc.text"
        case "zip", "gz", "tar": "doc.zipper"
        default: "doc"
        }
    }
}

/// Something the session reports about itself — a compaction, a restart — said in the middle, as
/// Messages says what happened to a conversation.
private struct NoticeLine: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "info.circle")
            .font(.footnote)
            .foregroundStyle(Palette.ink2)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
    }
}

/// An error, with the fix the Mac knows for it.
private struct ErrorCard: View {
    let text: String
    let hint: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Palette.red)
            VStack(alignment: .leading, spacing: 4) {
                Text(text)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Palette.ink)
                if let hint, !hint.isEmpty {
                    Text(hint)
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink2)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Radius.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .surface()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Error: \(text)\(hint.map { ". \($0)" } ?? "")")
    }
}

/// A row this version of the app cannot draw. Nothing is ever blank.
struct OpenOnMacView: View {
    static let words = "Open this on your Mac"
    let kind: String

    var body: some View {
        Label(Self.words, systemImage: "laptopcomputer")
            .font(.footnote)
            .foregroundStyle(Palette.ink2)
            .frame(maxWidth: .infinity)
            .accessibilityLabel("\(Self.words). This iPhone cannot show it yet.")
            .accessibilityIdentifier("open-on-mac-\(kind)")
    }
}
