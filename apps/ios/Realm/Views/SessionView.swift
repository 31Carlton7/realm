import RealmKit
import SwiftUI

/// A session: its transcript, and the composer pinned below it.
struct SessionView: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var atBottom = true
    /// The height the transcript is seen through, between the bars: a short transcript fills it from
    /// the bottom, so there is never less content than window to place.
    @State private var viewport: CGFloat = 0

    var body: some View {
        let transcript = model.store.transcript(sessionId)
        let outgoing = model.store.outbox.items(for: sessionId).filter(\.isMessage)
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if let savedAt = transcript.savedAt, !transcript.rows.isEmpty {
                        LastUpdated(savedAt: savedAt)
                    }
                    if transcript.hasMore {
                        Text("Earlier rows are on your Mac.")
                            .inter(.footnote)
                            .foregroundStyle(Palette.ink2)
                    }
                    if transcript.rows.isEmpty && outgoing.isEmpty {
                        EmptyTranscript(isLoaded: transcript.session != nil)
                    }
                    ForEach(transcript.rows) { row in
                        TranscriptRowView(row: row, sessionId: sessionId)
                            .id(row.key)
                    }
                    ForEach(outgoing) { item in
                        OutgoingMessageView(item: item)
                            .id(item.id.uuidString)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottom)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .frame(minHeight: viewport, alignment: .bottom)
            }
            .defaultScrollAnchor(.bottom)
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.containerSize.height - geometry.contentInsets.top - geometry.contentInsets.bottom
            } action: { _, height in
                viewport = max(0, height)
            }
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.visibleRect.maxY >= geometry.contentSize.height - 32
            } action: { _, isAtBottom in
                atBottom = isAtBottom
                if isAtBottom { model.markSeen(sessionId) }
            }
            .onChange(of: transcript.rows.last) { previous, _ in
                // The first rows land at the bottom at once; later ones follow a reader who is there.
                if previous == nil {
                    proxy.scrollTo(Self.bottom, anchor: .bottom)
                } else {
                    follow(proxy)
                }
            }
            .onChange(of: outgoing.count) { old, new in
                // What the person just sent is always brought into view.
                if new > old { scrollToBottom(proxy) }
            }
            .onChange(of: transcript.isLive) { _, live in
                if live && atBottom { model.markSeen(sessionId) }
            }
        }
        .background(Palette.canvas)
        .safeAreaBar(edge: .bottom) {
            ComposerView(sessionId: sessionId)
        }
        .navigationTitle(transcript.session.map { $0.title.isEmpty ? "Untitled session" : $0.title } ?? "Session")
        .navigationBarTitleDisplayMode(.inline)
        .navigationSubtitle(subtitle(transcript))
        .task(id: model.channelGeneration) { await model.open(sessionId) }
        .onDisappear {
            Task { await model.close(sessionId) }
        }
    }

    private static let bottom = "bottom"

    /// The session's status and space while the Mac is there; the Mac's state when it is not, since
    /// a status from before the connection went is not news.
    private func subtitle(_ transcript: Transcript) -> String {
        guard model.isConnected, let status = transcript.status ?? transcript.session?.status else { return model.macLine }
        return [status.word, transcript.session?.spaceName].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// New rows keep the bottom in view only for someone already reading there.
    private func follow(_ proxy: ScrollViewProxy) {
        guard atBottom else { return }
        scrollToBottom(proxy)
        model.markSeen(sessionId)
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        if reduceMotion {
            proxy.scrollTo(Self.bottom, anchor: .bottom)
        } else {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(Self.bottom, anchor: .bottom) }
        }
    }
}

/// Before any row: loading, or why nothing can load.
private struct EmptyTranscript: View {
    let isLoaded: Bool
    @Environment(AppModel.self) private var model

    var body: some View {
        let status = model.linkStatus
        HStack(spacing: 10) {
            if !isLoaded && (status.kind == .connecting || status.kind == .connected) {
                ProgressView()
                Text(status.kind == .connected ? "Opening…" : status.words)
            } else if isLoaded {
                Text("Nothing here yet. Send the first message.")
            } else {
                Image(systemName: status.symbol)
                Text(status.kind == .connected ? "Opening…" : "\(status.words). This session shows here once your Mac is there.")
            }
        }
        .inter(.body)
        .foregroundStyle(Palette.ink2)
        .padding(.vertical, 24)
    }
}

/// One row of a transcript, by its kind. A kind this version cannot draw says so, never blank.
struct TranscriptRowView: View {
    let row: TranscriptRow
    let sessionId: String

    var body: some View {
        switch row.content {
        case .user(let text):
            UserBubble(text: text)
        case .assistant(let text, let streaming):
            VStack(alignment: .leading, spacing: 6) {
                MarkdownView(text)
                if streaming {
                    Text("Writing…")
                        .inter(.footnote)
                        .foregroundStyle(Palette.ink3)
                }
            }
        case .thinking(let text):
            ThinkingView(text: text)
        case .tool(let name, let summary, let state, let detail):
            ToolRowView(name: name, summary: summary, state: state, detail: detail)
        case .request(let request):
            RequestCard(request: request, sessionId: sessionId)
        case .plan(let text, let steps):
            PlanView(text: text, steps: steps ?? [])
        case .notice(let text):
            NoticeView(text: text)
        case .error(let text, let hint):
            ErrorRowView(text: text, hint: hint)
        case .unknown(let kind, let type):
            OpenOnMacView(kind: type ?? kind)
        }
    }
}

/// What the person sent: right of the column, on the surface, in the composer's continuous curve
/// one rung down, so a send reads as the same object moving into the log.
struct UserBubble: View {
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            Text(text)
                .inter(.body)
                .foregroundStyle(Palette.ink)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .surface(Palette.surface, radius: 18)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You: \(text)")
    }
}

/// A message on its way: Sending… until the Mac has it, and what is in the way when it cannot go.
struct OutgoingMessageView: View {
    let item: OutgoingItem
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if case .message(let text) = item.payload {
                UserBubble(text: text)
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
                label(reason, symbol: "exclamationmark.triangle", tone: .failed)
                HStack(spacing: 12) {
                    Button("Try again") { model.retry(item) }
                        .buttonStyle(.bordered)
                    Button("Delete", role: .destructive) { model.discard(item) }
                        .buttonStyle(.bordered)
                }
                .inter(.subheadline, .medium)
            }
        }
    }

    private func label(_ text: String, symbol: String?, tone: Tone) -> some View {
        HStack(spacing: 6) {
            if let symbol {
                Image(systemName: symbol)
            } else {
                ProgressView()
                    .controlSize(.mini)
            }
            Text(text)
                .multilineTextAlignment(alignment == .trailing ? .trailing : .leading)
        }
        .inter(.footnote)
        .foregroundStyle(tone.color)
        .accessibilityElement(children: .combine)
    }
}

/// Thinking is folded: a line that opens to the words.
private struct ThinkingView: View {
    let text: String
    @State private var open = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .imageScale(.small)
                    Text("Thinking")
                }
                .inter(.subheadline, .medium)
                .foregroundStyle(Palette.ink2)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(open ? "Open" : "Folded")
            if open {
                Text(text)
                    .inter(.subheadline, italic: true)
                    .foregroundStyle(Palette.ink2)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// A tool call is one line — its state, its name and what it acted on — that opens to its detail.
private struct ToolRowView: View {
    let name: String
    let summary: String
    let state: ToolState
    let detail: String?
    @State private var open = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { open.toggle() }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    stateSymbol
                    Text(name)
                        .inter(.subheadline, .medium)
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
                        .imageScale(.small)
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .foregroundStyle(Palette.ink3)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(name), \(Self.word(state)): \(summary)")
            .accessibilityValue(open ? "Open" : "Folded")
            if open {
                ScrollView(.horizontal) {
                    Text(detail ?? (state == .running ? "Still running." : "No output."))
                        .mono(.caption1)
                        .foregroundStyle(detail == nil ? Palette.ink2 : Palette.ink)
                        .textSelection(.enabled)
                        .fixedSize()
                        .padding(12)
                }
                .scrollIndicators(.hidden)
                .frame(maxWidth: .infinity, alignment: .leading)
                .surface(Palette.page, radius: Radius.card)
            }
        }
    }

    private var stateSymbol: some View {
        let (symbol, tone): (String, Tone) = switch state {
        case .running: ("circle.dotted", .working)
        case .done: ("checkmark.circle", .quiet)
        case .error: ("xmark.circle", .failed)
        }
        return Image(systemName: symbol)
            .foregroundStyle(tone.color)
            .imageScale(.medium)
    }

    static func word(_ state: ToolState) -> String {
        switch state {
        case .running: "Running"
        case .done: "Done"
        case .error: "Failed"
        }
    }
}

/// A plan, and its steps with where each one is.
private struct PlanView: View {
    let text: String?
    let steps: [PlanStep]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Plan", systemImage: "list.bullet.clipboard")
                .inter(.subheadline, .title)
                .foregroundStyle(Palette.ink)
            if !steps.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: Self.symbol(step.status))
                                .foregroundStyle(Self.tone(step.status).color)
                            Text(step.text)
                                .inter(.body)
                                .foregroundStyle(step.status == "completed" ? Palette.ink2 : Palette.ink)
                                .strikethrough(step.status == "completed", color: Palette.ink3)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityValue(Self.word(step.status))
                    }
                }
            }
            if let text, !text.isEmpty {
                MarkdownView(text)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .surface()
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

private struct NoticeView: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "info.circle")
            .inter(.footnote)
            .foregroundStyle(Palette.ink2)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// An error, with the fix the Mac knows for it.
private struct ErrorRowView: View {
    let text: String
    let hint: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label {
                Text(text)
                    .foregroundStyle(Palette.ink)
            } icon: {
                Image(systemName: "exclamationmark.triangle")
                    .foregroundStyle(Palette.red)
            }
            .inter(.body, .medium)
            if let hint, !hint.isEmpty {
                Text(hint)
                    .inter(.subheadline)
                    .foregroundStyle(Palette.ink2)
            }
        }
        .padding(14)
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
            .inter(.subheadline)
            .foregroundStyle(Palette.ink2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel("\(Self.words). This iPhone cannot show it yet.")
            .accessibilityIdentifier("open-on-mac-\(kind)")
    }
}
