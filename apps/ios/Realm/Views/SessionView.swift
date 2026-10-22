import RealmKit
import SwiftUI

/// A session: its transcript, and at its foot what the next press is — the request it waits on in the
/// composer's place, or the composer with what the turn changed and a suggested reply over it.
struct SessionView: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Where the transcript is scrolled to: its foot, until the reader scrolls it themselves.
    @State private var position = ScrollPosition(idType: String.self, edge: .bottom)
    @State private var atBottom = true
    /// The reader is at the newest row, so what arrives keeps them there. Scrolling away, or opening
    /// something in place, lets go of it; coming to rest at the foot again, the press for the newest
    /// row, or sending takes it back.
    @State private var follows = true
    @State private var dragging = false
    /// How many of the transcript's newest items are drawn; earlier ones are a press away.
    @State private var shown = SessionView.window
    /// The height the transcript is seen through, between the bars: a short transcript fills it from
    /// the bottom, so there is never less content than window to place.
    @State private var viewport: CGFloat = 0
    @FocusState private var composing: Bool

    /// The items drawn at a time. Every one drawn is measured as it is, so the foot is where the
    /// transcript really ends at any text size — a lazy list places it by guesses, and a long answer
    /// at the largest sizes is many screens tall.
    static let window = 60

    var body: some View {
        let transcript = model.store.transcript(sessionId)
        // A message the Mac queued shows once, in the queue over the composer, never here as well.
        let queued = model.store.outbox.inQueue(transcript.queued ?? [], for: sessionId)
        let outgoing = model.store.outbox.items(for: sessionId).filter { $0.isMessage && queued[$0.id] == nil }
        let row = transcript.session.map { model.rowEdits.applied(to: $0) ?? $0 }
        let status = transcript.status ?? transcript.session?.status
        // The request the foot holds is drawn there, not twice: answered, it comes back to where it
        // was asked, as the record of it.
        let footRequest = PendingRequest.first(in: transcript, outbox: model.store.outbox)?.request.requestId
        let items = TranscriptLayout.items(transcript.rows.filter { !$0.isRequest(footRequest) && !$0.changedNothing },
                                           settled: status != .running && status != .waiting)
        let drawn = items.suffix(shown)
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if drawn.count < items.count, let first = drawn.first {
                    Button {
                        shown += Self.window
                        // The reader stays with the row they were reading; the earlier ones open above it.
                        position.scrollTo(id: first.id, anchor: .top)
                    } label: {
                        Label("Show earlier messages", systemImage: "arrow.up")
                            .font(.footnote.weight(.medium))
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .frame(maxWidth: .infinity)
                } else if transcript.hasMore {
                    Label("Earlier messages are on your Mac", systemImage: "laptopcomputer")
                        .font(.footnote)
                        .foregroundStyle(Palette.ink2)
                        .frame(maxWidth: .infinity)
                }
                if transcript.rows.isEmpty && outgoing.isEmpty {
                    EmptyTranscript(isLoaded: transcript.session != nil)
                }
                ForEach(drawn) { item in
                    TranscriptItemView(item: item, sessionId: sessionId)
                        .freshEntrance(born: item.firstKey.flatMap { model.rowBirths[$0] })
                        .id(item.id)
                }
                // Thinking is said at the foot; the turn's work in general is the pill's to say.
                if transcript.isLive, status == .running, LiveActivity.of(transcript.rows) == .thinking {
                    LiveLine(word: "Thinking")
                }
                ForEach(outgoing) { item in
                    OutgoingMessageView(item: item)
                        .id(item.id.uuidString)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(minHeight: viewport, alignment: .bottom)
        }
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(.bottom, for: .alignment)
        // While the reader follows, a change of size keeps the foot where it is; once they have let
        // go, what arrives below leaves the rows they are reading where they are.
        .defaultScrollAnchor(follows ? .bottom : nil, for: .sizeChanges)
        .scrollDismissesKeyboard(.interactively)
        .environment(\.holdPlace) { follows = false }
        .onScrollGeometryChange(for: CGFloat.self) { geometry in
            geometry.containerSize.height - geometry.contentInsets.top - geometry.contentInsets.bottom
        } action: { _, height in
            viewport = max(0, height)
        }
        .onScrollPhaseChange { _, phase in
            dragging = phase == .tracking || phase == .interacting || phase == .decelerating
            if dragging {
                follows = false
            } else if phase == .idle && atBottom {
                // A reader who comes to rest at the foot is following again.
                follows = true
            }
        }
        .onChange(of: position.isPositionedByUser) { _, byUser in
            // Scrolled by an accessibility action or a key rather than a drag.
            if byUser && !atBottom { follows = false }
        }
        .onScrollGeometryChange(for: ScrollFoot.self, of: ScrollFoot.init) { old, new in
            if new.atFoot != atBottom {
                withAnimation(Motion.animation(reduceMotion)) { atBottom = new.atFoot }
            }
            if new.atFoot {
                if !dragging { follows = true }
                model.markSeen(sessionId)
            } else if follows && !dragging && new.frame != old.frame {
                // The bars grew — a request docked, the composer took another line: the foot stays
                // in view for a reader who follows.
                position.scrollTo(edge: .bottom)
            }
        }
        .onChange(of: transcript.rows.last) {
            // A row arrived, or the newest grew: a reader who follows sees it.
            if follows && !dragging { position.scrollTo(edge: .bottom) }
        }
        .onChange(of: outgoing.count) { old, new in
            // What the person just sent is always brought into view.
            if new > old { scrollToBottom() }
        }
        .onChange(of: transcript.isLive) { _, live in
            if live && atBottom { model.markSeen(sessionId) }
        }
        .background(Ground.transcript)
        .safeAreaBar(edge: .bottom) {
            SessionFoot(sessionId: sessionId, composing: $composing, showsLatest: !atBottom && !transcript.rows.isEmpty) {
                scrollToBottom()
            }
        }
        .navigationTitle(row?.displayTitle ?? "Session")
        .navigationBarTitleDisplayMode(.inline)
        .navigationSubtitle(subtitle(transcript))
        .toolbar {
            if let row {
                ToolbarItem(placement: .topBarTrailing) { SessionMenu(row: row) }
            }
        }
        .task(id: model.channelGeneration) { await model.open(sessionId) }
        .onDisappear {
            Task { await model.close(sessionId) }
        }
    }

    /// The session's status and space while the Mac is there; the Mac's state when it is not, since
    /// a status from before the connection went is not news.
    private func subtitle(_ transcript: Transcript) -> String {
        guard model.isConnected, let status = transcript.status ?? transcript.session?.status else { return model.macLine }
        return [status == .running ? "Working" : status.word, transcript.session?.spaceName]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func scrollToBottom() {
        follows = true
        withAnimation(Motion.animation(reduceMotion)) { position.scrollTo(edge: .bottom) }
    }
}

/// Where a transcript stands in its scroll view, as one value, so a change can be told apart from the
/// moment before it: a scroll moves only the offset, while bars that grow or shrink change the frame.
struct ScrollFoot: Equatable {
    var content: CGFloat
    var offset: CGFloat
    /// The bottom of what is seen above the bars at the foot, in the content's terms.
    var seen: CGFloat
    /// The height left between the bars.
    var frame: CGFloat

    init(content: CGFloat, offset: CGFloat, seen: CGFloat, frame: CGFloat) {
        self.content = content
        self.offset = offset
        self.seen = seen
        self.frame = frame
    }

    init(_ geometry: ScrollGeometry) {
        self.init(content: geometry.contentSize.height, offset: geometry.contentOffset.y,
                  seen: geometry.visibleRect.maxY - geometry.contentInsets.bottom,
                  frame: geometry.containerSize.height - geometry.contentInsets.top - geometry.contentInsets.bottom)
    }

    /// Within a few points of the newest row, the bars aside.
    var atFoot: Bool { seen >= content - Self.slack }

    static let slack: CGFloat = 32
}

extension EnvironmentValues {
    /// Called by a row that opens in place — a fold, a tool's output, the thinking — before it does:
    /// the reader is reading there, so the rows they opened stay where they are rather than the foot.
    @Entry var holdPlace: @MainActor () -> Void = {}
}

/// What a running turn is doing where no row on screen says so already: a tool that runs and text
/// that streams say it themselves. Thinking gets a line at the foot; anything else is the pill's
/// "Working" to say.
enum LiveActivity: Equatable {
    case thinking, working

    static func of(_ rows: [TranscriptRow]) -> LiveActivity? {
        guard let last = rows.last else { return .working }
        switch last.content {
        case .tool(_, _, .running, _): return nil
        case .assistant(_, true): return nil
        case .request(let request) where request.state == .pending: return nil
        case .thinking: return .thinking
        default: return .working
        }
    }
}

/// The glass pill at the top of the session's foot: the turn's clock while it works — only from a
/// start this phone saw — or the link's trouble, with a press to try again, and beside it the way
/// back to the newest row, which slides out of the same glass.
private struct SessionPill: View {
    let sessionId: String
    let showsLatest: Bool
    let toLatest: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var glass
    @State private var trying = false

    var body: some View {
        let shown = model.shownLinkStatus
        let shownLink: LinkStatus.Kind? = shown.isConnected ? nil : shown.kind
        let transcript = model.store.transcript(sessionId)
        let working = transcript.isLive && transcript.status == .running
        GlassEffectContainer(spacing: 10) {
            HStack(spacing: 10) {
                if let away = shownLink {
                    Button {
                        Task {
                            trying = true
                            await model.refresh()
                            trying = false
                        }
                    } label: {
                        HStack(spacing: 7) {
                            if trying || away == .connecting {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: away.glyph)
                                    .foregroundStyle(away.tone.color)
                            }
                            Text(PillWords.away(away, reconnecting: model.linkTroubled))
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(Palette.ink)
                        }
                        .padding(.horizontal, 14)
                        .frame(height: 40)
                    }
                    .buttonStyle(.plain)
                    .glassEffect(.regular.interactive(), in: Capsule())
                    .glassEffectID("pill", in: glass)
                    .disabled(trying || away == .connecting)
                    .accessibilityHint("Tries to reach your Mac again")
                } else if working {
                    HStack(spacing: 7) {
                        Image(systemName: "progress.indicator")
                            .foregroundStyle(Palette.accentInk)
                            .restingPulse(when: true)
                        if let since = model.workingSince[sessionId] {
                            TimelineView(.periodic(from: since, by: 1)) { context in
                                Text("Working \(PillWords.elapsed(context.date.timeIntervalSince(since)))")
                                    .monospacedDigit()
                                    .accessibilityLabel("Working, \(PillWords.elapsed(context.date.timeIntervalSince(since), spoken: true))")
                            }
                        } else {
                            Text("Working")
                        }
                    }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Palette.ink)
                    .padding(.horizontal, 14)
                    .frame(height: 40)
                    .glassEffect(.regular, in: Capsule())
                    .glassEffectID("pill", in: glass)
                    .accessibilityElement(children: .combine)
                }
                if showsLatest {
                    Button(action: toLatest) {
                        Image(systemName: "arrow.down")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(Palette.ink)
                            .frame(width: 40, height: 40)
                    }
                    .buttonStyle(.plain)
                    .glassEffect(.regular.interactive(), in: Circle())
                    .glassEffectID("latest", in: glass)
                    .accessibilityLabel("Latest")
                    .accessibilityHint("Scrolls to the newest message")
                    .accessibilityShowsLargeContentViewer()
                }
            }
        }
        .animation(Motion.animation(reduceMotion), value: showsLatest)
        .animation(Motion.animation(reduceMotion), value: shownLink)
        .animation(Motion.animation(reduceMotion), value: working)
    }
}

/// What the pill says about the link while the Mac is away.
enum PillWords {
    /// `reconnecting`: the link was up a moment ago, so this is it coming back.
    static func away(_ kind: LinkStatus.Kind, reconnecting: Bool = false) -> String {
        switch kind {
        case .connecting: reconnecting ? "Reconnecting…" : "Connecting…"
        case .asleep: "Mac asleep · Retry"
        case .notAnswering: "Mac not answering · Retry"
        case .relayUnreachable: "Can't reach the relay · Retry"
        case .notConnected: "Not connected · Retry"
        case .refused(let reason): reason
        case .connected: "Connected"
        }
    }

    /// How long a turn has been working: "12s", "3m 12s", "1h 4m"; spoken in whole words.
    static func elapsed(_ interval: TimeInterval, spoken: Bool = false) -> String {
        Duration.seconds(max(0, Int(interval)))
            .formatted(.units(allowed: [.hours, .minutes, .seconds], width: spoken ? .wide : .narrow, maximumUnitCount: 2))
    }
}

/// What sits at a session's foot. The request it waits on takes the composer's place, opaque, as the
/// thing to do next; folded away, it is one line, and the composer comes back under it with Stop and
/// its draft as it was.
private struct SessionFoot: View {
    let sessionId: String
    var composing: FocusState<Bool>.Binding
    /// The reader has scrolled away from the newest row.
    let showsLatest: Bool
    let toLatest: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var folded: String?

    var body: some View {
        let transcript = model.store.transcript(sessionId)
        let pending = PendingRequest.first(in: transcript, outbox: model.store.outbox)
        let reviewable = TranscriptLayout.reviewable(transcript.rows)
        let empty = (model.composerDrafts[sessionId] ?? "").isEmpty && (model.draftAttachments[sessionId] ?? []).isEmpty
        let hint = empty ? transcript.hint.flatMap { $0.isEmpty ? nil : $0 } : nil
        let docked = pending.map { folded != $0.request.requestId } ?? false
        // The pill rides in the bar rather than over the transcript, so the newest row is never under it.
        let pill = showsLatest || !model.shownLinkStatus.isConnected || (transcript.isLive && transcript.status == .running)
        VStack(spacing: 10) {
            if pill {
                SessionPill(sessionId: sessionId, showsLatest: showsLatest, toLatest: toLatest)
                    .transition(.opacity)
            }
            if let pending, docked {
                WaitingDock(pending: pending, sessionId: sessionId, fold: { folded = pending.request.requestId })
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
                    .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            } else {
                if let pending {
                    FoldedRequest(pending: pending, sessionId: sessionId, unfold: { folded = nil })
                        .padding(.horizontal, 12)
                } else if reviewable != nil || hint != nil {
                    FootChips(sessionId: sessionId, checkpointId: reviewable, hint: hint) { text in
                        model.composerDrafts[sessionId] = text
                        composing.wrappedValue = true
                    }
                }
                ComposerView(sessionId: sessionId, focused: composing)
                    .transition(.opacity)
            }
        }
        .animation(Motion.animation(reduceMotion), value: docked)
        .animation(Motion.animation(reduceMotion), value: pending?.request.requestId)
        .animation(Motion.animation(reduceMotion), value: pill)
    }
}

/// A request folded out of the composer's way: who asks, in one line that brings the card back. Stop
/// is the composer's, on the row under it.
private struct FoldedRequest: View {
    let pending: PendingRequest
    let sessionId: String
    let unfold: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        let session = model.store.transcript(sessionId).session
        Button(action: unfold) {
            HStack(spacing: 8) {
                Image(systemName: "hand.raised.fill")
                    .foregroundStyle(Palette.orange)
                Text("\(Asker.name(pending.request, agent: session?.agent ?? "")) is waiting on you")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Image(systemName: "chevron.up")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Palette.ink3)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(Fill.card, in: Capsule())
        .accessibilityHint("Opens the request")
    }
}

/// The chips over the composer: Review changes for what the last turn changed, and the reply the Mac
/// suggests, which a press puts in the field to send or to change.
private struct FootChips: View {
    let sessionId: String
    let checkpointId: String?
    let hint: String?
    let useHint: (String) -> Void
    @Environment(AppModel.self) private var model
    @State private var reviewing = false

    var body: some View {
        ScrollView(.horizontal) {
            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 8) {
                    if let checkpointId, model.turnChanges[checkpointId]?.totalFiles != 0 {
                        Button {
                            reviewing = true
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "plusminus")
                                Text("Review changes")
                                if let changes = model.turnChanges[checkpointId], changes.countsLines {
                                    LineCounts(additions: changes.additions, deletions: changes.deletions)
                                }
                            }
                            .font(.subheadline.weight(.medium))
                        }
                        .buttonStyle(.glass)
                        .buttonBorderShape(.capsule)
                        .task(id: checkpointId) { await model.loadChanges(checkpointId, in: sessionId) }
                        .sheet(isPresented: $reviewing) {
                            ChangesSheet(checkpointId: checkpointId, sessionId: sessionId)
                        }
                    }
                    if let hint {
                        Button {
                            useHint(hint)
                        } label: {
                            Label(hint, systemImage: "arrow.turn.down.right")
                                .font(.subheadline)
                                .lineLimit(1)
                                .frame(maxWidth: 260, alignment: .leading)
                        }
                        .buttonStyle(.glass)
                        .buttonBorderShape(.capsule)
                        .accessibilityLabel("Suggested reply: \(hint)")
                        .accessibilityHint("Puts it in the message field")
                    }
                }
                .padding(.horizontal, 12)
            }
        }
        .scrollIndicators(.hidden)
        .scrollClipDisabled()
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

/// The transcript as it is drawn. Rows stand on their own, except the work: in a turn still going, a
/// run of tool calls and thinking is a run of quiet lines; in a finished one, everything said and done
/// on the way to the answer folds under one line, so a long session reads prompt, answer, prompt,
/// answer. What a person may need to act on or see — a request, an error, a plan, the files changed
/// or made — is never folded away. Each fold knows the changes its turn left, which an edit's line
/// opens onto.
enum TranscriptItem: Identifiable, Equatable {
    case row(TranscriptRow)
    case work([TranscriptRow], checkpointAfter: String?)
    case folded([TranscriptRow], checkpointAfter: String?)

    var id: String {
        switch self {
        case .row(let row): row.key
        case .work(let rows, _): "work/\(rows.first?.key ?? "")"
        case .folded(let rows, _): "fold/\(rows.first?.key ?? "")"
        }
    }

    /// The key of the row it starts with, which says how long ago it arrived.
    var firstKey: String? {
        switch self {
        case .row(let row): row.key
        case .work(let rows, _), .folded(let rows, _): rows.first?.key
        }
    }
}

enum TranscriptLayout {
    /// `settled`: the session's last turn is over, so it folds like the ones before it.
    static func items(_ rows: [TranscriptRow], settled: Bool) -> [TranscriptItem] {
        let checkpoints = turnCheckpoints(rows)
        var items: [TranscriptItem] = []
        for turn in turns(rows) {
            let finished = turn.upperBound < rows.count || settled
            let final = finished ? turn.last(where: { if case .assistant = rows[$0].content { true } else { false } }) : nil
            var run: [Int] = []
            func close() {
                guard let first = run.first else { return }
                let runRows = run.map { rows[$0] }
                if finished, runRows.contains(where: \.isWork) {
                    items.append(.folded(runRows, checkpointAfter: checkpoints[first]))
                } else if finished {
                    items.append(contentsOf: runRows.map(TranscriptItem.row))
                } else {
                    // A turn still going: its work is quiet lines, its words are rows.
                    var work: [TranscriptRow] = []
                    for row in runRows {
                        if row.isWork {
                            work.append(row)
                        } else {
                            if !work.isEmpty { items.append(.work(work, checkpointAfter: checkpoints[first])) }
                            work = []
                            items.append(.row(row))
                        }
                    }
                    if !work.isEmpty { items.append(.work(work, checkpointAfter: checkpoints[first])) }
                }
                run = []
            }
            for index in turn {
                let row = rows[index]
                if index != final, row.folds(finished: finished) {
                    run.append(index)
                } else {
                    close()
                    items.append(.row(row))
                }
            }
            close()
        }
        return items
    }

    /// The transcript's turns: each runs from something the person said to the next.
    static func turns(_ rows: [TranscriptRow]) -> [Range<Int>] {
        var starts = rows.indices.filter { if case .user = rows[$0].content { true } else { false } }
        if starts.first != 0 { starts.insert(0, at: 0) }
        return zip(starts, starts.dropFirst() + [rows.count]).compactMap { $0 < $1 ? $0..<$1 : nil }
    }

    /// For each row, the changes its turn left: the first changes notice after it, before the next
    /// thing the person said.
    static func turnCheckpoints(_ rows: [TranscriptRow]) -> [String?] {
        var checkpoints = [String?](repeating: nil, count: rows.count)
        var checkpoint: String?
        for index in rows.indices.reversed() {
            if case .user = rows[index].content { checkpoint = nil }
            if let id = rows[index].checkpointId { checkpoint = id }
            checkpoints[index] = checkpoint
        }
        return checkpoints
    }

    /// The changes of the newest turn, when nothing has been said since it settled: what Review
    /// changes opens.
    static func reviewable(_ rows: [TranscriptRow]) -> String? {
        for row in rows.reversed() {
            if case .user = row.content { return nil }
            if let id = row.checkpointId, !row.changedNothing { return id }
        }
        return nil
    }
}

extension TranscriptRow {
    /// Whether this is the request with this id.
    func isRequest(_ requestId: String?) -> Bool {
        guard let requestId, case .request(let request) = content else { return false }
        return request.requestId == requestId
    }

    /// A turn's changes that came to no file at all, as the Mac words them: it records every turn it
    /// measured, but there is nothing here to review.
    var changedNothing: Bool {
        guard checkpointId != nil, case .notice(let text) = content else { return false }
        return text.hasPrefix("Changed 0 ")
    }
}

private extension TranscriptRow {
    /// A tool call or thinking: the work, as against what was said.
    var isWork: Bool {
        switch content {
        case .tool, .thinking: true
        default: false
        }
    }

    /// Whether the row goes under a turn's fold. In a finished turn that is the work, the words on the
    /// way to the answer and the quiet notices; in a turn still going, only the work gathers.
    func folds(finished: Bool) -> Bool {
        switch content {
        case .tool, .thinking: true
        case .assistant: finished
        case .notice: finished && checkpointId == nil && (madeFiles ?? []).isEmpty
        case .user, .request, .plan, .error, .unknown: false
        }
    }
}

struct TranscriptItemView: View {
    let item: TranscriptItem
    let sessionId: String
    var checkpointAfter: String?

    var body: some View {
        switch item {
        case .row(let row):
            TranscriptRowView(row: row, sessionId: sessionId, checkpointAfter: checkpointAfter)
        case .work(let rows, let checkpoint):
            WorkRun(rows: rows, sessionId: sessionId, checkpointAfter: checkpoint ?? checkpointAfter)
        case .folded(let rows, let checkpoint):
            FoldedWork(rows: rows, sessionId: sessionId, checkpointAfter: checkpoint ?? checkpointAfter)
        }
    }
}
