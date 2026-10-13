import RealmKit
import SwiftUI

/// A session: its transcript, and the composer floating over its foot.
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
        let items = TranscriptLayout.items(transcript.rows)
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if transcript.hasMore {
                        Label("Earlier messages are on your Mac", systemImage: "laptopcomputer")
                            .font(.footnote)
                            .foregroundStyle(Palette.ink2)
                            .frame(maxWidth: .infinity)
                    }
                    if let savedAt = transcript.savedAt, !transcript.rows.isEmpty {
                        LastUpdated(savedAt: savedAt)
                            .frame(maxWidth: .infinity)
                    }
                    if transcript.rows.isEmpty && outgoing.isEmpty {
                        EmptyTranscript(isLoaded: transcript.session != nil)
                    }
                    ForEach(items) { item in
                        TranscriptItemView(item: item, sessionId: sessionId)
                            .id(item.id)
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
                withAnimation(Motion.animation(reduceMotion)) { atBottom = isAtBottom }
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
            .overlay(alignment: .bottom) {
                if !atBottom && !transcript.rows.isEmpty {
                    LatestButton { scrollToBottom(proxy) }
                        .padding(.bottom, 10)
                        .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
                }
            }
        }
        .background(Ground.transcript)
        .safeAreaBar(edge: .bottom) {
            ComposerView(sessionId: sessionId)
        }
        .navigationTitle(transcript.session?.displayTitle ?? "Session")
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
        withAnimation(Motion.animation(reduceMotion)) { proxy.scrollTo(Self.bottom, anchor: .bottom) }
    }
}

/// Back to the newest row, for a reader who has scrolled up: glass, because it floats over the
/// transcript as the bars do.
private struct LatestButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.down")
                .font(.system(size: 17, weight: .semibold))
                .frame(width: 44, height: 44)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .accessibilityLabel("Latest")
        .accessibilityShowsLargeContentViewer()
        .accessibilityHint("Scrolls to the newest message")
    }
}

/// Before any row: loading, or why nothing can load.
private struct EmptyTranscript: View {
    let isLoaded: Bool
    @Environment(AppModel.self) private var model

    var body: some View {
        let status = model.linkStatus
        Group {
            if isLoaded {
                ContentUnavailableView("Nothing here yet", systemImage: "text.bubble",
                                       description: Text("Send the first message."))
            } else if status.kind == .connecting || status.kind == .connected {
                VStack(spacing: 12) {
                    ProgressView()
                    Text(status.kind == .connected ? "Opening…" : status.words)
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink2)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 40)
            } else {
                ContentUnavailableView {
                    Label(status.words, systemImage: status.symbol)
                } description: {
                    Text("This session shows here once your Mac is there.")
                }
            }
        }
    }
}

/// The transcript as it is drawn: each row on its own, except a run of tool calls and thinking, which
/// is one ledger of the work done between two things said. The ledger takes its first row's key, so
/// it keeps its place as the run grows.
enum TranscriptItem: Identifiable, Equatable {
    case row(TranscriptRow)
    case work([TranscriptRow])

    var id: String {
        switch self {
        case .row(let row): row.key
        case .work(let rows): "work/\(rows.first?.key ?? "")"
        }
    }
}

enum TranscriptLayout {
    static func items(_ rows: [TranscriptRow]) -> [TranscriptItem] {
        var items: [TranscriptItem] = []
        var run: [TranscriptRow] = []
        for row in rows {
            switch row.content {
            case .tool, .thinking:
                run.append(row)
            default:
                if !run.isEmpty {
                    items.append(.work(run))
                    run = []
                }
                items.append(.row(row))
            }
        }
        if !run.isEmpty { items.append(.work(run)) }
        return items
    }
}

struct TranscriptItemView: View {
    let item: TranscriptItem
    let sessionId: String

    var body: some View {
        switch item {
        case .row(let row):
            TranscriptRowView(row: row, sessionId: sessionId)
        case .work(let rows):
            WorkCard(rows: rows)
        }
    }
}
