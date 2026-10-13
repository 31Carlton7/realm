import RealmKit
import SwiftUI
import UIKit

/// One row of a transcript, by its kind, each in a shape of its own: what was said, the work done, a
/// decision to make, a notice. A kind this version cannot draw says so, never blank.
struct TranscriptRowView: View {
    let row: TranscriptRow
    let sessionId: String

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
                        .symbolEffect(.variableColor.iterative, options: .repeat(.continuous))
                }
            }
        case .thinking, .tool:
            WorkCard(rows: [row])
        case .request(let request):
            RequestCard(request: request, sessionId: sessionId)
        case .plan(let text, let steps):
            PlanCard(text: text, steps: steps ?? [])
        case .notice(let text):
            NoticeLine(text: text)
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
                    Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
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
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
            }
            .sensoryFeedback(.error, trigger: reason)
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

/// A run of tool calls and thinking: one ledger of the work done between two things said. Each line
/// is its state, its name and what it acted on, and opens to its detail.
struct WorkCard: View {
    let rows: [TranscriptRow]
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.key) { index, row in
                if index > 0 {
                    Rectangle()
                        .fill(Palette.divider)
                        .frame(height: 1 / displayScale)
                        .padding(.leading, 44)
                }
                switch row.content {
                case .tool(let name, let summary, let state, let detail):
                    ToolLine(name: name, summary: summary, state: state, detail: detail)
                case .thinking(let text):
                    ThinkingLine(text: text)
                default:
                    EmptyView()
                }
            }
        }
        .background(Fill.card)
        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
    }
}

/// A line of the ledger that opens: the press is a fill, arriving at once, never a size.
private struct LineButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Palette.hover : .clear)
    }
}

private struct ToolLine: View {
    let name: String
    let summary: String
    let state: ToolState
    let detail: String?
    @State private var open = false
    @State private var showingAll = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// A tool's output shows this many lines in place; the rest opens in a sheet of its own.
    static let previewLines = 16

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(Motion.animation(reduceMotion)) { open.toggle() }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    ToolStateGlyph(state: state)
                        .frame(width: 22)
                    Text(name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                        .fixedSize()
                    if !summary.isEmpty, summary != name {
                        Text(summary)
                            .mono(.footnote)
                            .foregroundStyle(Palette.ink2)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.ink3)
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 12)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(LineButtonStyle())
            .accessibilityLabel("\(name), \(Self.word(state))\(summary.isEmpty ? "" : ": \(summary)")")
            .accessibilityValue(open ? "Open" : "Folded")
            if open {
                let output = detail ?? (state == .running ? "Still running." : "No output.")
                let lines = output.split(separator: "\n", omittingEmptySubsequences: false)
                VStack(alignment: .leading, spacing: 8) {
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
                    .background(Fill.well, in: RoundedRectangle(cornerRadius: Radius.well, style: .continuous))
                    if lines.count > Self.previewLines {
                        Button("Show all \(lines.count) lines") { showingAll = true }
                            .font(.footnote.weight(.medium))
                            .padding(.leading, 4)
                    }
                }
                .padding(.horizontal, Radius.cardPadding - 4)
                .padding(.bottom, Radius.cardPadding - 4)
                .sheet(isPresented: $showingAll) {
                    OutputSheet(title: name, summary: summary, output: output)
                }
            }
        }
    }

    static func word(_ state: ToolState) -> String {
        switch state {
        case .running: "Running"
        case .done: "Done"
        case .error: "Failed"
        }
    }
}

/// A tool's state by the shape of its glyph: a run's indicator, a check, a cross.
private struct ToolStateGlyph: View {
    let state: ToolState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let (symbol, tone): (String, Tone) = switch state {
        case .running: ("progress.indicator", .working)
        case .done: ("checkmark.circle", .quiet)
        case .error: ("xmark.circle.fill", .failed)
        }
        Image(systemName: symbol)
            .symbolRenderingMode(.hierarchical)
            .foregroundStyle(tone.color)
            .symbolEffect(.variableColor.iterative.dimInactiveLayers.nonReversing, options: .repeat(.continuous),
                          isActive: state == .running && !reduceMotion)
            .contentTransition(.symbolEffect(.replace))
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

/// Thinking is folded: a line that opens to the words.
private struct ThinkingLine: View {
    let text: String
    @State private var open = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(Motion.animation(reduceMotion)) { open.toggle() }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: "ellipsis.circle")
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(Palette.ink2)
                        .frame(width: 22)
                    Text("Thinking")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Palette.ink2)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.ink3)
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 12)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(LineButtonStyle())
            .accessibilityValue(open ? "Open" : "Folded")
            if open {
                Text(text)
                    .font(.subheadline)
                    .italic()
                    .foregroundStyle(Palette.ink2)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 44)
                    .padding(.trailing, 14)
                    .padding(.bottom, 12)
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
                    Text("\(steps.filter { $0.status == "completed" }.count) of \(steps.count) done")
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
                .symbolRenderingMode(.hierarchical)
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
