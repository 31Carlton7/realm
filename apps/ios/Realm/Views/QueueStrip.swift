import RealmKit
import SwiftUI

/// What the strip over the composer says of the Mac's queue: how many wait, and when they go.
enum QueueWords {
    /// From this many the strip folds to its head and the next message, and Show all opens the rest in a
    /// sheet: three rows over the composer push the field halfway up the screen.
    static let foldAt = 3

    /// Whether the strip keeps to its head. At the accessibility sizes it always does: one row there is
    /// as tall as the transcript it would cover.
    static func folds(_ count: Int, accessibilitySize: Bool) -> Bool {
        accessibilitySize || count >= foldAt
    }

    /// The folded strip's button, which opens the queue in a sheet.
    static func show(_ count: Int) -> String {
        count == 1 ? "Show" : "Show all"
    }

    /// "Queued on your Mac", "2 queued on your Mac".
    static func title(_ count: Int) -> String {
        count == 1 ? "Queued on your Mac" : "\(count) queued on your Mac"
    }

    /// When they go: while a turn is under way, as it ends, one a turn. Once it is stopped nothing goes
    /// until the next turn ends, and Send now is the way to send one sooner. One being edited holds them.
    static func line(count: Int, working: Bool, held: Bool) -> String {
        if held { return count == 1 ? "It waits while it is being edited." : "Nothing goes while one is being edited." }
        switch (working, count == 1) {
        case (true, true): return "Sends when this turn ends."
        case (true, false): return "They send in order, one as each turn ends."
        case (false, true): return "Waits for the next turn to end. Send now sends it at once."
        case (false, false): return "They wait for the next turn to end. Send now sends one at once."
        }
    }

    /// A queued message in its row: its words, or its files where it has none.
    static func text(_ message: QueuedMessage) -> String {
        let words = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        return words.isEmpty ? files(message.attachments) ?? "" : words
    }

    /// "Photo.jpg", "Photo.jpg and brief.pdf", "Photo.jpg and 2 more"; nil for none.
    static func files(_ files: [SentFile]) -> String? {
        guard let first = files.first?.name else { return nil }
        switch files.count {
        case 1: return first
        case 2: return "\(first) and \(files[1].name)"
        default: return "\(first) and \(files.count - 1) more"
        }
    }

    /// How many of a row's files it shows by name: two keep to one line beside its actions.
    static let filesShown = 2

    /// The rest past those, "1 more", "3 more"; nil when every file is shown.
    static func more(_ files: [SentFile]) -> String? {
        files.count > filesShown ? "\(files.count - filesShown) more" : nil
    }

    /// What VoiceOver says for a row: which of how many it is, its words, its files, and its hold.
    static func spoken(_ message: QueuedMessage, at index: Int, of count: Int, editingHere: Bool) -> String {
        var parts = ["Queued message \(index + 1) of \(count)"]
        let words = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !words.isEmpty { parts.append(words) }
        if let files = files(message.attachments) { parts.append("with \(files)") }
        if message.held { parts.append(held(editingHere: editingHere)) }
        return parts.joined(separator: ", ")
    }

    /// The mark on a held row: this iPhone's edit, or someone else's, on the Mac or another phone.
    static func held(editingHere: Bool) -> String {
        editingHere ? "Held while you edit" : "Being edited elsewhere"
    }
}

/// The Mac's queue for a session, over the composer: what waits for a turn to end, oldest first, each
/// with its words, its files and Send now, Edit and Remove. From three, and at the accessibility sizes,
/// it folds to its head and the next one, and the rest open in a sheet. A message this iPhone queued is
/// shown here and nowhere else (`Outbox.inQueue`).
struct QueueStrip: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var editing: QueuedMessage?
    @State private var sheetShown = false

    var body: some View {
        let transcript = model.store.transcript(sessionId)
        let queued = transcript.queued ?? []
        if !queued.isEmpty || editing != nil {
            Group {
                if let next = queued.first {
                    let status = transcript.status ?? transcript.session?.status
                    // A row being edited here is never folded out from under its sheet.
                    let folded = QueueWords.folds(queued.count, accessibilitySize: dynamicTypeSize.isAccessibilitySize) && editing == nil
                    VStack(alignment: .leading, spacing: QueueLayout.gap) {
                        QueueHead(queued: queued, working: status == .running || status == .waiting, next: folded ? next : nil) {
                            sheetShown = true
                        }
                        if !folded {
                            QueueRows(queued: queued, sessionId: sessionId, editing: $editing)
                        }
                    }
                    .padding(QueueLayout.inset)
                    .background(Fill.card, in: RoundedRectangle(cornerRadius: Radius.composer, style: .continuous))
                    .animation(Motion.animation(reduceMotion), value: queued.map(\.id))
                    .animation(Motion.animation(reduceMotion), value: folded)
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("Queued messages")
                } else {
                    // The queue emptied under an edit — the message was sent or taken out on the Mac: the
                    // edit's sheet keeps its place, and with it the words being written.
                    Color.clear.frame(height: 0)
                }
            }
            .sheet(item: $editing) { message in
                QueueEditSheet(message: message, sessionId: sessionId)
            }
            .sheet(isPresented: $sheetShown) {
                QueueSheet(sessionId: sessionId)
            }
        }
    }
}

/// The card's spacing, on the composer's steps: one inset on all four sides, and one gap between the
/// head, each hairline and each row, so every part sits as far from the next as from the edge.
enum QueueLayout {
    static let inset: CGFloat = 16
    static let gap: CGFloat = 12
    /// What a control draws, where its 44-point target reaches past it into the gap and the inset: a
    /// row is as tall as what it shows, and the controls' ink keeps to the card's edges.
    static let control: CGFloat = 30
    static let overhang = (ComposerLayout.button - control) / 2
}

/// The strip's head: how many wait and when they go, then, folded, the next one and the way to the rest.
private struct QueueHead: View {
    let queued: [QueuedMessage]
    let working: Bool
    /// The next to go, named while the strip is folded.
    let next: QueuedMessage?
    let show: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
        layout {
            VStack(alignment: .leading, spacing: 2) {
                Text(QueueWords.title(queued.count))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .accessibilityAddTraits(.isHeader)
                Text(QueueWords.line(count: queued.count, working: working, held: queued.contains(where: \.held)))
                    .font(.footnote)
                    .foregroundStyle(Palette.ink2)
                if let next {
                    Text("Next: \(QueueWords.text(next))")
                        .font(.footnote)
                        .foregroundStyle(Palette.ink2)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if next != nil {
                Button(action: show) {
                    Text(QueueWords.show(queued.count))
                        .padding(.horizontal, 8)
                        .frame(minHeight: ComposerLayout.button)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Palette.accentInk)
                // Its words on the card's edge, and beside the title as tall as their line, so the head
                // is as tall as its words; its target reaches out into the inset. At the accessibility
                // sizes, on a line of its own under them, its words are taller than that line.
                .padding(.horizontal, -8)
                .padding(.vertical, dynamicTypeSize.isAccessibilitySize ? 0 : -2 * QueueLayout.overhang)
                .accessibilityIdentifier("queue-show")
            }
        }
    }
}

/// The queue's messages in the Mac's order, each under a hairline. Edit holds one on the Mac, then hands
/// it to `editing` for its sheet.
private struct QueueRows: View {
    let queued: [QueuedMessage]
    let sessionId: String
    @Binding var editing: QueuedMessage?
    @Environment(AppModel.self) private var model

    var body: some View {
        ForEach(Array(queued.enumerated()), id: \.element.id) { index, message in
            Divider()
                .overlay(Palette.divider)
            QueuedRow(message: message, index: index, count: queued.count, sessionId: sessionId, editingHere: editing?.id == message.id) {
                Task { if await model.holdQueued(message, in: sessionId) { editing = message } }
            }
            .transition(.opacity)
        }
    }
}

/// The whole queue where there is room for it, from the folded strip: the same rows and actions, with
/// a sheet of their own for an edit. It closes once nothing is left in the queue and no edit is open.
private struct QueueSheet: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var editing: QueuedMessage?

    var body: some View {
        let transcript = model.store.transcript(sessionId)
        let queued = transcript.queued ?? []
        let status = transcript.status ?? transcript.session?.status
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: QueueLayout.gap) {
                    Text(QueueWords.line(count: queued.count, working: status == .running || status == .waiting,
                                         held: queued.contains(where: \.held)))
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink2)
                    QueueRows(queued: queued, sessionId: sessionId, editing: $editing)
                }
                .padding(QueueLayout.inset)
                .background(Fill.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                .padding(16)
            }
            .background(Ground.grouped)
            .softEdges(ground: Ground.grouped)
            .navigationTitle(QueueWords.title(max(1, queued.count)))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
                .sharedBackgroundVisibility(.hidden)
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Ground.grouped)
        .onChange(of: queued.isEmpty && editing == nil) { _, done in
            if done { dismiss() }
        }
        .sheet(item: $editing) { message in
            QueueEditSheet(message: message, sessionId: sessionId)
        }
    }
}

/// One queued message: its words across the row, in two lines (more at the accessibility sizes), the
/// mark of an edit under way, a line of its files, and its three actions in the Mac's order — Edit,
/// Send now, which the agent's own note explains, and Remove. The actions end the words' line or the
/// files' where they fit beside them, and take a line of their own where they do not. While a call for
/// it is on its way the actions give their place to a spinner.
private struct QueuedRow: View {
    let message: QueuedMessage
    let index: Int
    let count: Int
    let sessionId: String
    let editingHere: Bool
    let edit: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        if message.attachments.isEmpty {
            // Its actions on its line where the words fit beside them, under them where they do not.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    words
                    actions
                }
                VStack(alignment: .leading, spacing: 8) {
                    words
                    actions.frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                words
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) {
                        QueuedFiles(files: message.attachments, sessionId: sessionId)
                        Spacer(minLength: 0)
                        actions
                    }
                    VStack(alignment: .leading, spacing: QueueLayout.gap) {
                        QueuedFiles(files: message.attachments, sessionId: sessionId)
                        actions.frame(maxWidth: .infinity, alignment: .trailing)
                    }
                }
            }
        }
    }

    private var words: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(QueueWords.text(message))
                .font(.subheadline)
                .foregroundStyle(Palette.ink)
                // Two lines over the composer; at the accessibility sizes a row is only ever in the
                // queue's sheet, which scrolls.
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 8 : 2)
            if message.held {
                Label(QueueWords.held(editingHere: editingHere), systemImage: "pencil")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Palette.ink2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(QueueWords.spoken(message, at: index, of: count, editingHere: editingHere))
        // On the words alone: held anywhere else the menu would gather the buttons into one element.
        .contentShape(Rectangle())
        .contextMenu {
            Button { Task { await model.sendQueuedNow(message, in: sessionId) } } label: {
                Label("Send now", systemImage: "arrow.up")
                Text(sendNowLine)
            }
            .disabled(away || message.held)
            Button("Edit", systemImage: "pencil", action: edit)
                .disabled(away || message.held)
            Button("Remove", systemImage: "xmark", role: .destructive) { Task { await model.removeQueued(message, in: sessionId) } }
                .disabled(away)
        }
    }

    private var away: Bool { !model.isConnected }

    @ViewBuilder
    private var actions: some View {
        if model.queueCalls[sessionId]?.contains(message.id) == true {
            ProgressView()
                .frame(height: QueueLayout.control)
        } else {
            HStack(spacing: 0) {
                QueueButton(title: "Edit", symbol: "pencil", action: edit)
                    .disabled(away || message.held)
                    .accessibilityIdentifier("queue-edit")
                Button { Task { await model.sendQueuedNow(message, in: sessionId) } } label: {
                    Text("Send now")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                        .padding(.horizontal, 12)
                        .frame(minHeight: QueueLayout.control)
                        .background(Fill.pill, in: Capsule())
                        .frame(minHeight: ComposerLayout.button)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(away || message.held)
                .opacity(away || message.held ? 0.45 : 1)
                .accessibilityHint(sendNowLine)
                .accessibilityIdentifier("queue-send-now")
                QueueButton(title: "Remove", symbol: "xmark") { Task { await model.removeQueued(message, in: sessionId) } }
                    .disabled(away)
                    .accessibilityIdentifier("queue-remove")
            }
            // The last glyph's ink on the card's edge, and every target out into the gap and the inset.
            .padding(.vertical, -QueueLayout.overhang)
            .padding(.trailing, -(ComposerLayout.button - QueueButton.glyph) / 2)
        }
    }

    /// What Send now does: the agent's own note while a turn runs, since it stops some agents' turns
    /// and not others'; with none running, it simply sends.
    private var sendNowLine: String {
        let transcript = model.store.transcript(sessionId)
        let status = transcript.status ?? transcript.session?.status
        guard status == .running || status == .waiting, let note = model.sessionOptions[sessionId]?.agent.steerNote, !note.isEmpty else {
            return "Sends it now, ahead of the queue."
        }
        return note
    }
}

/// A row's quiet glyph button, 44 points to touch, its name for VoiceOver and the large content viewer.
private struct QueueButton: View {
    static let glyph: CGFloat = 15

    let title: String
    let symbol: String
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: Self.glyph, weight: .semibold))
                .foregroundStyle(Palette.ink2)
                .frame(width: ComposerLayout.button, height: ComposerLayout.button)
                .contentShape(Rectangle())
                .opacity(isEnabled ? 1 : 0.45)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityShowsLargeContentViewer { Label(title, systemImage: symbol) }
    }
}

/// A queued message's files in one line, each a small copy of it beside its name — the Mac sends the
/// pictures' copies as it does a sent message's — and past two, how many more. At the accessibility
/// sizes, one to a line: side by side there the names are cut to their first and last letters.
private struct QueuedFiles: View {
    let files: [SentFile]
    let sessionId: String
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let shown = files.prefix(QueueWords.filesShown)
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(spacing: QueueLayout.gap))
        layout {
            ForEach(shown) { file in
                HStack(spacing: 6) {
                    QueuedPicture(file: file, sessionId: sessionId)
                    Text(file.name)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            if let more = QueueWords.more(files) {
                Text(more)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .font(.footnote)
        .foregroundStyle(Palette.ink2)
        .accessibilityHidden(true)
    }
}

private struct QueuedPicture: View {
    let file: SentFile
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.displayScale) private var displayScale
    @ScaledMetric(relativeTo: .footnote) private var side: CGFloat = 28

    var body: some View {
        ZStack {
            Rectangle().fill(Fill.bubble)
            if file.isImage, let thumbnail = model.thumbnail(file.path, in: sessionId) {
                Image(uiImage: thumbnail)
                    .resizable()
                    .scaledToFill()
            } else {
                Image(systemName: FileKind.symbol(file.name))
                    .font(.caption)
                    .foregroundStyle(Palette.ink3)
            }
        }
        .frame(width: side, height: side)
        .pictureTile(radius: Radius.well)
        // Made at the size the sent message's tile draws it: the same path is that tile's once it goes.
        .task(id: model.isConnected) {
            if file.isImage { await model.loadThumbnail(file.path, in: sessionId, side: SentPicture.side * displayScale) }
        }
    }
}

/// A queued message's words, edited while the Mac holds it so its turn cannot send it meanwhile: Save
/// replaces them, keeping its files, and lets it go; Cancel lets it go as it was. Should it go anyway —
/// sent from the Mac — Save puts the words in the message field, so nothing typed is lost.
struct QueueEditSheet: View {
    let message: QueuedMessage
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var saved = false
    @FocusState private var focused: Bool

    init(message: QueuedMessage, sessionId: String) {
        self.message = message
        self.sessionId = sessionId
        _text = State(initialValue: message.text)
    }

    var body: some View {
        let gone = !(model.store.transcript(sessionId).queued ?? []).contains { $0.id == message.id }
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && message.attachments.isEmpty
        NavigationStack {
            Form {
                Section {
                    TextField("Message", text: $text, axis: .vertical)
                        .tint(Palette.accent)
                        .lineLimit(3...12)
                        .focused($focused)
                        .accessibilityLabel("Queued message")
                        .listRowBackground(Fill.card)
                } footer: {
                    Text(gone ? "It went while you were editing. Save puts your words in the message field."
                              : "Nothing in the queue goes until you save or cancel.")
                }
                if !message.attachments.isEmpty {
                    Section {
                        ForEach(message.attachments) { file in
                            Label(file.name, systemImage: FileKind.symbol(file.name))
                                .foregroundStyle(Palette.ink)
                                .listRowBackground(Fill.card)
                        }
                    } header: {
                        Text("Files")
                    } footer: {
                        Text("They go with it as they are.")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Ground.grouped)
            .softEdges(ground: Ground.grouped)
            .navigationTitle("Edit queued message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                .sharedBackgroundVisibility(.hidden)
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        saved = true
                        dismiss()
                        Task { await model.editQueued(message, text: text, in: sessionId) }
                    }
                    .disabled(empty)
                }
                .sharedBackgroundVisibility(.hidden)
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Ground.grouped)
        // Once the sheet is up rather than as it comes: a field still on its way in cannot take the keyboard.
        .task { focused = true }
        .onDisappear {
            if !saved { Task { await model.letGoQueued(message, in: sessionId) } }
        }
    }
}

extension AppModel {
    /// Sends a queued message now, ahead of the turn it waits for.
    func sendQueuedNow(_ message: QueuedMessage, in sessionId: String) async {
        _ = await queueCall(on: message, in: sessionId, refusal: "Not sent.") { api in
            try await api.sendQueuedNow(id: sessionId, queuedId: message.id)
        }
    }

    func removeQueued(_ message: QueuedMessage, in sessionId: String) async {
        _ = await queueCall(on: message, in: sessionId, refusal: "Not removed.") { api in
            try await api.removeQueued(id: sessionId, queuedId: message.id)
        }
    }

    /// Holds a queued message for an edit here, so a turn's end cannot send it meanwhile. False where the
    /// Mac could not, and a toast says why.
    func holdQueued(_ message: QueuedMessage, in sessionId: String) async -> Bool {
        await queueCall(on: message, in: sessionId, refusal: "It cannot be edited now.") { api in
            try await api.holdQueued(id: sessionId, queuedId: message.id, held: true)
        }
    }

    /// Lets go of a message held for an edit that was put away. While the Mac is away there is nothing
    /// to say: it lets a hold go on its own after a while.
    func letGoQueued(_ message: QueuedMessage, in sessionId: String) async {
        guard let api, isConnected else { return }
        try? await api.holdQueued(id: sessionId, queuedId: message.id, held: false)
    }

    /// Replaces a held message's words and lets it go. Words that did not change only let it go. Gone
    /// meanwhile, or refused, the words join the message field instead, so nothing typed is lost.
    func editQueued(_ message: QueuedMessage, text: String, in sessionId: String) async {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard words != message.text.trimmingCharacters(in: .whitespacesAndNewlines) else {
            await letGoQueued(message, in: sessionId)
            return
        }
        let gone = !(store.transcript(sessionId).queued ?? []).contains { $0.id == message.id }
        let why: String
        if gone {
            why = "It had already gone, so your words are in the message field."
        } else if let api, isConnected {
            do {
                try await api.editQueued(id: sessionId, queuedId: message.id, text: words)
                return
            } catch {
                why = "Not saved. \(Self.describe(error)) Your words are in the message field."
            }
        } else {
            why = "Not saved while your Mac is away. Your words are in the message field."
        }
        let draft = composerDrafts[sessionId] ?? ""
        composerDrafts[sessionId] = draft.isEmpty ? words : "\(draft)\n\n\(words)"
        show(toast: why)
    }

    /// One call about a queued message, with a spinner in its row's place until the Mac answers.
    private func queueCall(on message: QueuedMessage, in sessionId: String, refusal: String,
                           _ call: (MobileAPI) async throws -> Void) async -> Bool {
        guard let api, isConnected else {
            show(toast: "Connect to your Mac to change its queue.")
            return false
        }
        queueCalls[sessionId, default: []].insert(message.id)
        defer { queueCalls[sessionId]?.remove(message.id) }
        do {
            try await call(api)
            return true
        } catch {
            show(toast: "\(refusal) \(Self.describe(error))")
            return false
        }
    }
}
