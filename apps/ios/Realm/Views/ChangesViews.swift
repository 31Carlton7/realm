import RealmKit
import SwiftUI
import UIKit

/// One turn's changed files, in a sheet: each with what happened to it and its lines added and taken
/// away, opening onto its diff.
struct ChangesSheet: View {
    let checkpointId: String
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if let changes = model.turnChanges[checkpointId] {
                    List {
                        Section {
                            ForEach(changes.files, id: \.path) { file in
                                NavigationLink(value: file) {
                                    ChangedFileRow(file: file)
                                }
                                .listRowBackground(Fill.card)
                            }
                        } footer: {
                            if changes.totalFiles > changes.files.count {
                                Text("\(changes.totalFiles - changes.files.count) more on your Mac.")
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                    .scrollContentBackground(.hidden)
                    .modifier(LineTotals(changes: changes))
                } else if model.isConnected {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .task { await model.loadChanges(checkpointId, in: sessionId) }
                } else {
                    ContentUnavailableView("The changes are on your Mac", systemImage: "laptopcomputer",
                                           description: Text("This iPhone shows them while your Mac is connected."))
                }
            }
            .background(Ground.grouped)
            .navigationTitle(model.turnChanges[checkpointId].map(ChangesWords.files) ?? "Changes")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: ChangedFile.self) { file in
                DiffView(file: file, checkpointId: checkpointId, sessionId: sessionId)
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

/// The lines a turn added and took away, under the sheet's title: said only where there are lines to
/// count, since a turn that changed only pictures has none.
private struct LineTotals: ViewModifier {
    let changes: TurnChanges

    func body(content: Content) -> some View {
        if changes.countsLines {
            content.navigationSubtitle(Text("\(Text("+\(changes.additions)").foregroundStyle(Palette.green))  \(Text("−\(changes.deletions)").foregroundStyle(Palette.red))"))
        } else {
            content
        }
    }
}

/// A changed file: what happened to it as a glyph and a word, its name over its folder, its counts.
struct ChangedFileRow: View {
    let file: ChangedFile

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: Self.symbol(file.status))
                .font(.body)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(Self.tone(file.status).color)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(ChangesWords.name(file.path))
                    .mono(.subheadline, medium: true)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let folder = ChangesWords.folder(file.path) {
                    Text(folder)
                        .mono(.caption)
                        .foregroundStyle(Palette.ink2)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }
            Spacer(minLength: 8)
            LineCounts(additions: file.additions, deletions: file.deletions, binary: file.additions == nil)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityValue(Self.word(file.status))
    }

    static func symbol(_ status: String) -> String {
        switch status {
        case "added": "plus.square.fill"
        case "deleted": "minus.square.fill"
        case "renamed": "arrow.right.square.fill"
        default: "pencil.and.outline"
        }
    }

    static func tone(_ status: String) -> Tone {
        switch status {
        case "added": .done
        case "deleted": .failed
        default: .quiet
        }
    }

    static func word(_ status: String) -> String {
        switch status {
        case "added": "Added"
        case "deleted": "Deleted"
        case "renamed": "Renamed"
        case "type-changed": "Type changed"
        default: "Modified"
        }
    }
}

/// A line of a unified diff with the numbers it has in the old file and the new one.
struct NumberedLine: Identifiable, Equatable {
    let id: Int
    let text: String
    let kind: DiffPage.LineKind
    let old: Int?
    let new: Int?
}

/// Numbers a page of a unified diff by its hunk headers, carrying on from the page before.
struct DiffNumbering: Equatable {
    var old = 0
    var new = 0

    mutating func number(_ lines: [String], from start: Int) -> [NumberedLine] {
        lines.enumerated().map { offset, line in
            let kind = DiffPage.kind(of: line)
            var oldNumber: Int?, newNumber: Int?
            switch kind {
            case .hunkHeader:
                if let (oldStart, newStart) = Self.starts(line) {
                    old = oldStart
                    new = newStart
                }
            case .context:
                oldNumber = old; newNumber = new
                old += 1; new += 1
            case .added:
                newNumber = new
                new += 1
            case .removed:
                oldNumber = old
                old += 1
            case .fileHeader, .note:
                break
            }
            return NumberedLine(id: start + offset, text: line, kind: kind, old: oldNumber, new: newNumber)
        }
    }

    /// `@@ -12,7 +12,9 @@` → (12, 12).
    static func starts(_ header: String) -> (Int, Int)? {
        let parts = header.split(separator: " ")
        guard parts.count >= 3, parts[1].hasPrefix("-"), parts[2].hasPrefix("+") else { return nil }
        let start = { (part: Substring) in Int(part.dropFirst().split(separator: ",").first ?? "") }
        guard let old = start(parts[1]), let new = start(parts[2]) else { return nil }
        return (old, new)
    }
}

/// One file's diff, paged in from the Mac as it is read: added and removed lines in their colours and
/// with their signs, each with its line number, the hunks' heads between them.
struct DiffView: View {
    let file: ChangedFile
    let checkpointId: String
    let sessionId: String
    @Environment(AppModel.self) private var model
    @State private var lines: [NumberedLine] = []
    @State private var numbering = DiffNumbering()
    @State private var page: DiffPage?
    @State private var problem: String?
    @State private var loading = false

    var body: some View {
        Group {
            if let page, page.binary {
                ContentUnavailableView("A binary file", systemImage: "doc.badge.gearshape",
                                       description: Text("It can only be compared on your Mac."))
            } else if let problem, lines.isEmpty {
                ContentUnavailableView("The diff did not load", systemImage: "exclamationmark.triangle", description: Text(problem))
            } else if lines.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView([.vertical, .horizontal]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        DiffLines(lines: lines)
                        if page?.next != nil {
                            ProgressView()
                                .padding(16)
                                .onAppear { Task { await loadMore() } }
                        } else if page?.truncated == true {
                            Label(page?.truncatedReason ?? "The rest of this diff is on your Mac.", systemImage: "scissors")
                                .font(.footnote)
                                .foregroundStyle(Palette.ink2)
                                .padding(16)
                        }
                    }
                    .padding(.vertical, 8)
                }
            }
        }
        .background(Ground.transcript)
        .navigationTitle(ChangesWords.name(file.path))
        .navigationSubtitle(ChangesWords.folder(file.path) ?? ChangedFileRow.word(file.status))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                LineCounts(additions: file.additions, deletions: file.deletions, binary: file.additions == nil)
                    .padding(.horizontal, 8)
            }
        }
        .task { if lines.isEmpty { await loadMore() } }
    }

    private func loadMore() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let next = try await model.diff(file.path, at: checkpointId, in: sessionId, from: page?.next ?? 0)
            lines += numbering.number(next.lines, from: next.from)
            page = next
        } catch {
            problem = AppModel.describe(error)
        }
    }
}

/// The lines of a diff, each a row: the line's number, its sign and its text in mono, on its colour's
/// wash. Long lines run on to the right rather than wrap: code is read as written.
struct DiffLines: View {
    let lines: [NumberedLine]
    @ScaledMetric(relativeTo: .caption) private var gutter: CGFloat = 38

    var body: some View {
        ForEach(lines) { line in
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Text((line.new ?? line.old).map(String.init) ?? "")
                    .mono(.caption)
                    .foregroundStyle(Palette.ink3)
                    .frame(width: gutter, alignment: .trailing)
                    .padding(.trailing, 10)
                Text(Self.body(line))
                    .mono(.caption, medium: line.kind == .hunkHeader)
                    .foregroundStyle(Self.ink(line.kind))
                    .fixedSize()
                    .padding(.trailing, 16)
            }
            .padding(.vertical, line.kind == .hunkHeader ? 6 : 1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Self.wash(line.kind))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Self.spoken(line))
        }
    }

    /// The line as shown: a hunk's head as it is, every other line with its sign kept.
    static func body(_ line: NumberedLine) -> String {
        line.text.isEmpty ? " " : line.text
    }

    static func ink(_ kind: DiffPage.LineKind) -> Color {
        switch kind {
        case .added, .removed, .context: Palette.ink
        case .hunkHeader, .fileHeader, .note: Palette.ink2
        }
    }

    static func wash(_ kind: DiffPage.LineKind) -> Color {
        switch kind {
        case .added: Palette.greenTint
        case .removed: Palette.redTint
        case .hunkHeader: Palette.accentTint
        case .context, .fileHeader, .note: .clear
        }
    }

    static func spoken(_ line: NumberedLine) -> String {
        let text = line.text.dropFirst()
        switch line.kind {
        case .added: return "Added, line \(line.new ?? 0): \(text)"
        case .removed: return "Removed, line \(line.old ?? 0): \(text)"
        case .context: return "Line \(line.new ?? 0): \(text)"
        case .hunkHeader: return "From line \(line.new ?? 0)"
        case .fileHeader, .note: return line.text
        }
    }
}

/// A tool's change, opened in its line: the start of its file's diff, and the rest a press away.
struct InlineDiff: View {
    let path: String
    let checkpointId: String
    let sessionId: String
    @Environment(AppModel.self) private var model
    @State private var lines: [NumberedLine] = []
    @State private var problem: String?
    @State private var opening = false

    /// How much of a diff a tool's line shows before it opens on its own page.
    static let shown = 14

    var body: some View {
        let file = model.turnChanges[checkpointId].flatMap { Edits.file(named: path, in: $0) }
        VStack(alignment: .leading, spacing: 8) {
            if let file {
                if file.additions == nil {
                    Text("A binary file: it can only be compared on your Mac.")
                        .font(.footnote)
                        .foregroundStyle(Palette.ink2)
                } else if lines.isEmpty {
                    if let problem {
                        Text(problem).font(.footnote).foregroundStyle(Palette.ink2)
                    } else {
                        ProgressView().controlSize(.small)
                    }
                } else {
                    ScrollView(.horizontal) {
                        VStack(alignment: .leading, spacing: 0) {
                            DiffLines(lines: Array(lines.filter { $0.kind != .fileHeader }.prefix(Self.shown)))
                        }
                        .padding(.vertical, 6)
                    }
                    .scrollIndicators(.hidden)
                    .background(Fill.card, in: RoundedRectangle(cornerRadius: Radius.well, style: .continuous))
                    .clipShape(RoundedRectangle(cornerRadius: Radius.well, style: .continuous))
                    Button {
                        opening = true
                    } label: {
                        HStack(spacing: 6) {
                            Text("Open the diff")
                            LineCounts(additions: file.additions, deletions: file.deletions)
                        }
                    }
                    .font(.footnote.weight(.medium))
                    .padding(.leading, 4)
                }
            } else if model.turnChanges[checkpointId] != nil {
                Text("This turn's changes do not list this file.")
                    .font(.footnote)
                    .foregroundStyle(Palette.ink2)
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .task(id: file?.path) {
            await model.loadChanges(checkpointId, in: sessionId)
            guard let file, file.additions != nil, lines.isEmpty else { return }
            do {
                var numbering = DiffNumbering()
                let page = try await model.diff(file.path, at: checkpointId, in: sessionId)
                lines = numbering.number(page.lines, from: page.from)
            } catch {
                problem = AppModel.describe(error)
            }
        }
        .sheet(isPresented: $opening) {
            if let file {
                NavigationStack {
                    DiffView(file: file, checkpointId: checkpointId, sessionId: sessionId)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button("Done") { opening = false }
                            }
                        }
                }
            }
        }
    }
}

/// A file a turn made, as the Mac lets the phone see it: a picture, the head of a text, or what it is
/// and why it cannot be shown here.
struct FilePreviewSheet: View {
    let file: MadeFile
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.displayScale) private var displayScale
    @Environment(\.colorScheme) private var colorScheme
    @State private var preview: FilePreview?
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Group {
                if let preview {
                    switch preview.preview {
                    case .image(_, let data):
                        if let image = UIImage(data: data) {
                            ScrollView {
                                Image(uiImage: image)
                                    .resizable()
                                    .scaledToFit()
                                    .overlay {
                                        // A picture's edge: one device pixel, inset, in the ink that shows on the ground.
                                        Rectangle()
                                            .strokeBorder(colorScheme == .dark ? Color.white.opacity(0.1) : Color.black.opacity(0.1),
                                                          lineWidth: 1 / displayScale)
                                    }
                                    .padding(16)
                                    .accessibilityLabel(file.name)
                            }
                        } else {
                            unavailable("The picture did not arrive whole.")
                        }
                    case .text(let text, let truncated):
                        ScrollView([.vertical, .horizontal]) {
                            VStack(alignment: .leading, spacing: 12) {
                                Text(text)
                                    .mono(.caption)
                                    .foregroundStyle(Palette.ink)
                                    .textSelection(.enabled)
                                    .fixedSize()
                                if truncated {
                                    Text("The rest of this file is on your Mac.")
                                        .font(.footnote)
                                        .foregroundStyle(Palette.ink2)
                                }
                            }
                            .padding(16)
                        }
                    case .none(let reason):
                        unavailable(reason.isEmpty ? "This kind of file opens on your Mac." : reason)
                    case .unknown:
                        unavailable("This iPhone cannot show this kind of preview yet.")
                    }
                } else if let problem {
                    unavailable(problem)
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(Ground.transcript)
            .navigationTitle(file.name)
            .navigationSubtitle(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                do {
                    preview = try await model.preview(file.path, in: sessionId)
                } catch {
                    problem = AppModel.describe(error)
                }
            }
        }
    }

    private func unavailable(_ reason: String) -> some View {
        ContentUnavailableView(file.name, systemImage: FileKind.symbol(file.path), description: Text(reason))
    }
}
