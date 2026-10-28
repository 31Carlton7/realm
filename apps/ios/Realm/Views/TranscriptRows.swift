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
            VStack(alignment: .trailing, spacing: 6) {
                if !text.isEmpty { UserBubble(text: text) }
                if let files = row.sentFiles, !files.isEmpty { SentFiles(files: files, sessionId: sessionId) }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        case .assistant(let text, let streaming):
            VStack(alignment: .leading, spacing: 8) {
                MarkdownView(text)
                if streaming {
                    LiveLine(word: "Writing")
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

/// A message on its way: Sending… until the Mac has it, and what is in the way when it cannot go. The
/// files it takes show under it from this phone's own copies.
struct OutgoingMessageView: View {
    let item: OutgoingItem
    @Environment(AppModel.self) private var model

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
                    if !text.isEmpty { UserBubble(text: text) }
                }
            }
            if !item.attachments.isEmpty {
                OutgoingFiles(attachments: item.attachments, files: model.store.files)
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
        case .delivered where item.delivery == .queue:
            // The Mac holds it for the turn's end; a turn that is stopped leaves it there, for the next.
            label("Queued on your Mac", symbol: "list.number", tone: .quiet)
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
        // Each pill's touch is taller than the pill, so the run overlaps its touches to keep Manus's
        // small gap between them.
        VStack(alignment: .leading, spacing: -PillButtonStyle.reach) {
            ForEach(Self.segments(rows), id: \.first?.key) { segment in
                if segment.count > 1 {
                    ToolGroupLine(rows: segment, sessionId: sessionId, checkpointAfter: checkpointAfter)
                } else if let row = segment.first {
                    WorkLine(row: row, sessionId: sessionId, checkpointAfter: checkpointAfter)
                }
            }
        }
        .padding(.vertical, -PillButtonStyle.reach)
    }

    /// The run in the lines it is drawn as: calls of one kind in a row, where the kind can be said as
    /// a count, together — "Read 4 files" — and everything else on its own.
    static func segments(_ rows: [TranscriptRow]) -> [[TranscriptRow]] {
        var segments: [[TranscriptRow]] = []
        var kind: ToolWords.Kind?
        for row in rows {
            let rowKind = row.groupableKind
            if let rowKind, rowKind == kind, var last = segments.popLast() {
                last.append(row)
                segments.append(last)
            } else {
                segments.append([row])
            }
            kind = rowKind
        }
        return segments
    }
}

private extension TranscriptRow {
    /// A tool call's kind when its calls can be counted under one line.
    var groupableKind: ToolWords.Kind? {
        guard case .tool(let name, _, _, _) = content else { return nil }
        let kind = ToolWords.kind(name)
        return ToolWords.group(kind, count: 2, running: false) == nil ? nil : kind
    }
}

/// One line of the work: a tool call or the thinking.
private struct WorkLine: View {
    let row: TranscriptRow
    let sessionId: String
    var checkpointAfter: String?

    var body: some View {
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

/// Calls of one kind in a row under one pill — "Ran 3 commands" — that opens to each of them, as
/// ChatGPT folds a run of commands. It says the newest's state: running, or failed if any did.
private struct ToolGroupLine: View {
    let rows: [TranscriptRow]
    let sessionId: String
    var checkpointAfter: String?
    @State private var open = false
    @Environment(\.holdPlace) private var holdPlace
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let states = rows.compactMap { row -> ToolState? in
            if case .tool(_, _, let state, _) = row.content { state } else { nil }
        }
        let running = states.last == .running
        let state: ToolState = running ? .running : states.contains(.error) ? .error : .done
        let kind = rows.first?.groupableKind ?? .other
        let words = ToolWords.group(kind, count: rows.count, running: running) ?? ""
        VStack(alignment: .leading, spacing: 0) {
            Button {
                holdPlace()
                withAnimation(Motion.animation(reduceMotion)) { open.toggle() }
            } label: {
                WorkPill(running: running) {
                    ToolStateGlyph(state: state, kind: kind)
                } label: {
                    Text(words)
                    Image(systemName: open ? "chevron.up" : "chevron.down")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Palette.ink3)
                }
            }
            .buttonStyle(PillButtonStyle())
            .sensoryFeedback(.selection, trigger: open)
            .accessibilityLabel("\(words)\(state == .error ? ", one failed" : "")")
            .accessibilityValue(open ? "Open" : "Folded")
            if open {
                VStack(alignment: .leading, spacing: -PillButtonStyle.reach) {
                    ForEach(rows) { row in
                        WorkLine(row: row, sessionId: sessionId, checkpointAfter: checkpointAfter)
                    }
                }
                .padding(.leading, 16)
                .transition(.opacity)
            }
        }
    }
}

/// A finished turn's work, folded under one quiet line — "Worked · 6 steps" — so a long session reads
/// prompt, answer, prompt, answer. It opens to the work as it happened.
struct FoldedWork: View {
    let rows: [TranscriptRow]
    let sessionId: String
    var checkpointAfter: String?
    @State private var open = false
    @Environment(\.holdPlace) private var holdPlace
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                holdPlace()
                withAnimation(Motion.animation(reduceMotion)) { open.toggle() }
            } label: {
                StepHead(title: Self.summary(rows), done: true, open: open)
            }
            .buttonStyle(.plain)
            .sensoryFeedback(.selection, trigger: open)
            .accessibilityLabel(Self.summary(rows))
            .accessibilityValue(open ? "Open" : "Folded")
            if open {
                // Under the step's words, as Manus sets a step's work under its title.
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(TranscriptLayout.items(rows, settled: false)) { item in
                        TranscriptItemView(item: item, sessionId: sessionId, checkpointAfter: checkpointAfter)
                    }
                }
                .padding(.leading, StepHead.indent)
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

/// What a running turn is doing at the transcript's foot — thinking, or writing the words above it —
/// as Manus says it: a small dot of the accent beside the word, which shimmers a few times and rests.
struct LiveLine: View {
    /// What the turn is doing, in the present tense: "Thinking", "Writing".
    let word: String
    @ScaledMetric(relativeTo: .subheadline) private var dot: CGFloat = 9

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(Palette.accent)
                .frame(width: dot, height: dot)
                .restingPulse(when: true)
                .accessibilityHidden(true)
            Text(word)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Palette.ink2)
                .shimmer(when: true)
        }
        .frame(minHeight: 32)
        .accessibilityElement(children: .combine)
    }
}

/// A step's head, as Manus draws one: a round check when it is done (an empty ring while it is not),
/// its words in the strong weight, and the chevron that says it opens.
struct StepHead: View {
    let title: String
    let done: Bool
    let open: Bool

    /// How far a step's work sits in: under its words, past the check.
    static let indent: CGFloat = 28

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .font(.subheadline)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(Palette.ink3)
                .glyphColumn(20, relativeTo: .subheadline)
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Palette.ink)
                .multilineTextAlignment(.leading)
            Image(systemName: open ? "chevron.up" : "chevron.down")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Palette.ink3)
            Spacer(minLength: 0)
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
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
        if let called = connectorTool(tool) {
            return Line(verb: called, object: acted)
        }
        return Line(verb: running ? "Calling \(tool)" : "Called \(tool)", object: acted)
    }

    /// A connector's tool as the desktop says it: the tool's own name in words, without the servers it
    /// came through. `mcp__realm__realm-agent__agent_start` is "Agent start", `mcp__linear__save_issue`
    /// is "Save issue"; nil for a tool that came through no connector.
    static func connectorTool(_ tool: String) -> String? {
        guard let range = tool.range(of: "__", options: .backwards) else { return nil }
        let words = tool[range.upperBound...].replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ").trimmingCharacters(in: .whitespaces)
        guard let first = words.first else { return nil }
        return first.uppercased() + words.dropFirst()
    }

    /// What kind of work a tool does, the same for every agent: its glyph at rest, and which calls in
    /// a row gather under one line.
    enum Kind: Equatable {
        case run, read, edit, write, search, list, fetch, web, delegate, plan, browser, simulator, computer, connector, other

        /// The glyph a settled line leads with, so a column of them is read by shape, never thirty
        /// identical ticks (desktop: `toolGlyph`).
        var glyph: String {
            switch self {
            case .run: "terminal"
            case .read: "doc.text"
            case .edit, .write: "pencil"
            case .search: "magnifyingglass"
            case .list: "folder"
            case .fetch, .web: "globe"
            case .delegate: "person.2"
            case .plan: "checklist"
            case .browser: "safari"
            case .simulator: "iphone"
            case .computer: "macbook"
            case .connector: "puzzlepiece.extension"
            case .other: "wrench.and.screwdriver"
            }
        }

        /// Whether its object is a file, which its line names by the file's own name.
        var actsOnFile: Bool { self == .read || self == .edit || self == .write }

        /// Whether its object is code, a path or a pattern, set in mono; a sub-agent's task, a search's
        /// words or a connector's argument is prose, and reads in the system's face.
        var objectIsCode: Bool {
            switch self {
            case .run, .read, .edit, .write, .search, .list, .fetch: true
            default: false
            }
        }
    }

    static func kind(_ tool: String) -> Kind {
        if let kind = kinds[tool] { return kind }
        if planTools.contains(tool) { return .plan }
        guard tool.contains("__") else { return .other }
        // Realm's own servers come through its gateway under their own names: `mcp__realm__realm-browser__…`.
        let parts = tool.components(separatedBy: "__")
        switch parts.count >= 2 ? parts[parts.count - 2] : "" {
        case "realm-browser": return .browser
        case "realm-simulator": return .simulator
        case "realm-computer": return .computer
        case "realm-agent": return .delegate
        default: return .connector
        }
    }

    /// What a line shows of what a tool acted on: a file by its own name — the folders it is in are
    /// the line's accessible name, and its detail — anything else as the Mac summarised it.
    static func shown(_ object: String, kind: Kind) -> String {
        guard kind.actsOnFile, object.contains("/"), !object.hasSuffix("/") else { return object }
        return ChangesWords.name(object)
    }

    /// A run of calls of one kind, said once: "Read 4 files", "Running 3 commands". Nil for a kind
    /// whose calls each say something of their own — a sub-agent, a connector, a step in the Simulator.
    static func group(_ kind: Kind, count: Int, running: Bool) -> String? {
        let (present, past, one, many): (String, String, String, String)
        switch kind {
        case .run: (present, past, one, many) = ("Running", "Ran", "command", "commands")
        case .read: (present, past, one, many) = ("Reading", "Read", "file", "files")
        case .edit: (present, past, one, many) = ("Editing", "Edited", "file", "files")
        case .write: (present, past, one, many) = ("Writing", "Wrote", "file", "files")
        case .search: (present, past, one, many) = ("Searching", "Searched", "time", "times")
        case .list: (present, past, one, many) = ("Listing", "Listed", "folder", "folders")
        case .fetch: (present, past, one, many) = ("Fetching", "Fetched", "page", "pages")
        default: return nil
        }
        return "\(running ? present : past) \(count) \(count == 1 ? one : many)"
    }

    private static let kinds: [String: Kind] = {
        var table: [String: Kind] = [:]
        let groups: [([String], Kind)] = [
            (["Bash", "Shell", "shell", "exec_command", "local_shell", "run_command"], .run),
            (["Read", "read_file", "view", "ReadFile", "view_image"], .read),
            (["Edit", "MultiEdit", "NotebookEdit", "str_replace", "str_replace_based_edit_tool", "apply_patch", "edit_file"], .edit),
            (["Write", "write_file", "create_file"], .write),
            (["Grep", "Glob", "grep", "glob", "find", "search", "codebase_search", "file_search"], .search),
            (["LS", "ls", "list_dir"], .list),
            (["WebFetch", "fetch", "web_fetch"], .fetch),
            (["WebSearch", "web_search"], .web),
            (["Task", "Agent", "spawn_agent"], .delegate),
        ]
        for (tools, kind) in groups { for tool in tools { table[tool] = kind } }
        return table
    }()

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

/// A pill of the work that opens: the press is a deeper fill, arriving at once, never a size. Its touch
/// reaches past the pill above and below, to 44 points.
struct PillButtonStyle: ButtonStyle {
    /// How far the touch reaches past the pill, top and bottom.
    static let reach: CGFloat = 6

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .environment(\.pillPressed, configuration.isPressed)
            .padding(.vertical, Self.reach)
            .contentShape(Rectangle())
    }
}

extension EnvironmentValues {
    @Entry var pillPressed = false
}

/// One step of the work as Manus draws it: a grey pill, as wide as its words, with the glyph of its
/// kind, the verb in the medium weight and what it acted on quieter beside it. A long one is cut in
/// the middle of what it acted on, never past the screen.
struct WorkPill<Glyph: View, Label: View>: View {
    var running = false
    @ViewBuilder let glyph: Glyph
    @ViewBuilder let label: Label
    @Environment(\.pillPressed) private var pressed

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            glyph
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                label
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Palette.ink2)
            .lineLimit(1)
            .shimmer(when: running)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(pressed ? Palette.hover2 : Fill.pill, in: RoundedRectangle(cornerRadius: Radius.well + 2, style: .continuous))
        .frame(maxWidth: .infinity, alignment: .leading)
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
    @Environment(\.holdPlace) private var holdPlace
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// A tool's output shows this many lines in place; the rest opens in a sheet of its own.
    static let previewLines = 16

    var body: some View {
        let words = ToolWords.line(tool: name, summary: summary, running: state == .running)
        let kind = ToolWords.kind(name)
        VStack(alignment: .leading, spacing: 0) {
            Button {
                holdPlace()
                withAnimation(Motion.animation(reduceMotion)) { open.toggle() }
            } label: {
                WorkPill(running: state == .running) {
                    ToolStateGlyph(state: state, kind: kind)
                } label: {
                    // The verb is whole before the object gets any room, but it can still be cut:
                    // set at its own width, a long name pushed every row of the transcript off screen.
                    Text(words.verb)
                        .layoutPriority(1)
                    if let object = words.object {
                        ToolObject(text: ToolWords.shown(object, kind: kind), code: kind.objectIsCode)
                    }
                }
            }
            .buttonStyle(PillButtonStyle())
            .sensoryFeedback(.selection, trigger: open)
            .accessibilityLabel("\([words.verb, words.object].compactMap { $0 }.joined(separator: " "))\(state == .error ? ", failed" : "")")
            .accessibilityValue(open ? "Open" : "Folded")
            .accessibilityHint(checkpointId == nil ? "Shows what it printed" : "Shows the change")
            if open {
                Group {
                    if let checkpointId {
                        InlineDiff(path: summary, checkpointId: checkpointId, sessionId: sessionId)
                    } else {
                        output
                    }
                }
                .padding(.leading, 16)
                .padding(.vertical, 6)
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

/// What a tool acted on, quiet beside its verb, cut in the middle when it does not fit, since a path's
/// end and a command's start are both what tell one from another.
private struct ToolObject: View {
    let text: String
    let code: Bool

    var body: some View {
        Group {
            if code {
                Text(text).mono(.footnote)
            } else {
                Text(text).font(.subheadline.weight(.regular))
            }
        }
        .foregroundStyle(Palette.ink3)
        .lineLimit(1)
        .truncationMode(.middle)
    }
}

/// A tool's state by the shape of its glyph: a run's indicator while it works, a cross when it failed,
/// and at rest the glyph of its kind, in the quiet ink.
private struct ToolStateGlyph: View {
    let state: ToolState
    let kind: ToolWords.Kind

    var body: some View {
        let (symbol, color): (String, Color) = switch state {
        case .running: ("progress.indicator", Tone.working.color)
        case .done: (kind.glyph, Palette.ink3)
        case .error: ("xmark.circle.fill", Tone.failed.color)
        }
        Image(systemName: symbol)
            .font(.footnote.weight(.semibold))
            .symbolRenderingMode(.hierarchical)
            .foregroundStyle(color)
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
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
        }
    }
}

/// Thinking is folded: a quiet line that opens to the words.
private struct ThinkingLine: View {
    let text: String
    @State private var open = false
    @Environment(\.holdPlace) private var holdPlace
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                holdPlace()
                withAnimation(Motion.animation(reduceMotion)) { open.toggle() }
            } label: {
                WorkPill {
                    Image(systemName: "brain")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.ink3)
                } label: {
                    Text("Thinking")
                }
            }
            .buttonStyle(PillButtonStyle())
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
                    .padding(.leading, 16)
                    .padding(.vertical, 6)
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
                        .glyphColumn(22, relativeTo: .body)
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
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var reviewing = false

    static let listed = 3

    var body: some View {
        let changes = model.turnChanges[checkpointId]
        // A turn that changed nothing has no card: the Mac measured it, and found nothing to review.
        if changes?.totalFiles != 0 {
            card(changes)
        }
    }

    private func card(_ changes: TurnChanges?) -> some View {
        // At the accessibility sizes each count goes under what it counts: beside it, the title and the
        // names were cut to a few letters.
        let ax = dynamicTypeSize.isAccessibilitySize
        return Button {
            reviewing = true
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "plusminus")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.ink2)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(changes.map(ChangesWords.files) ?? summary)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Palette.ink)
                            .lineLimit(ax ? 4 : 2)
                        if ax, let changes, changes.countsLines {
                            LineCounts(additions: changes.additions, deletions: changes.deletions)
                        }
                    }
                    Spacer(minLength: 8)
                    if !ax, let changes, changes.countsLines {
                        LineCounts(additions: changes.additions, deletions: changes.deletions)
                    }
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Palette.ink3)
                }
                if let changes {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(changes.files.prefix(Self.listed), id: \.path) { file in
                            let line = ax ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2)) : AnyLayout(HStackLayout(spacing: 8))
                            line {
                                Text(ChangesWords.name(file.path))
                                    .mono(.footnote)
                                    .foregroundStyle(Palette.ink2)
                                    .lineLimit(ax ? 3 : 1)
                                    .truncationMode(.middle)
                                if !ax { Spacer(minLength: 8) }
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
        // Counts are never broken over lines, wherever they are squeezed.
        if binary {
            Text("Binary")
                .font(.footnote)
                .foregroundStyle(Palette.ink2)
                .fixedSize()
        } else {
            HStack(spacing: 6) {
                Text("+\(additions ?? 0)").foregroundStyle(Palette.green)
                Text("−\(deletions ?? 0)").foregroundStyle(Palette.red)
            }
            .font(.footnote.weight(.medium))
            .monospacedDigit()
            .fixedSize()
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
                            FileTile(file: file, sessionId: sessionId)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .scrollIndicators(.hidden)
        }
        .sheet(item: $previewing) { file in
            FilePreviewSheet(path: file.path, name: file.name, sessionId: sessionId, size: file.size)
        }
    }
}

extension MadeFile: @retroactive Identifiable {
    public var id: String { path }
}

/// A file as a square tile with its name under it, as Files shows one: a picture as itself, once the
/// Mac has sent a small copy, anything else as its kind's glyph.
private struct FileTile: View {
    let file: MadeFile
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.displayScale) private var displayScale
    @ScaledMetric(relativeTo: .footnote) private var side: CGFloat = 92

    var body: some View {
        let thumbnail = model.thumbnail(file.path, in: sessionId)
        VStack(spacing: 6) {
            ZStack {
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                    .fill(Fill.card)
                if let thumbnail {
                    Image(uiImage: thumbnail)
                        .resizable()
                        .scaledToFill()
                        .frame(width: side, height: side)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                        .overlay {
                            // A picture's edge, so a dark one does not bleed into the ground.
                            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                                .strokeBorder(Palette.line, lineWidth: 1 / displayScale)
                        }
                        .transition(.opacity)
                } else {
                    Image(systemName: FileKind.symbol(file.path))
                        .font(.title2)
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(Palette.ink2)
                }
            }
            .frame(width: side, height: side)
            Text(file.name)
                .font(.caption)
                .foregroundStyle(Palette.ink)
                .lineLimit(2)
                .truncationMode(.middle)
                .multilineTextAlignment(.center)
                .frame(width: side)
        }
        .animation(.easeOut(duration: 0.2), value: thumbnail != nil)
        .task(id: file.path) {
            guard FileKind.isPicture(file.path) else { return }
            await model.loadThumbnail(file.path, in: sessionId, side: side * displayScale)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(file.name)
        .accessibilityHint("Opens a preview")
    }
}

/// A file's kind by its extension, as the glyph that says it.
enum FileKind {
    /// A picture the Mac can make a small copy of.
    static func isPicture(_ path: String) -> Bool {
        ["png", "jpg", "jpeg", "gif", "heic", "webp", "tiff"].contains((path as NSString).pathExtension.lowercased())
    }

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
