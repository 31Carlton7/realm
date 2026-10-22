import RealmKit
import SwiftUI

/// What the strip over the composer says of the Mac's queue: how many wait, and when they go.
enum QueueWords {
    /// From this many the strip folds to its head and the next message until it is opened: three rows
    /// over the composer push the field halfway up the screen.
    static let foldAt = 3

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
/// with its words, its files and Send now, Edit and Remove. From three it folds to its head and the next
/// one, until opened. A message this iPhone queued is shown here and nowhere else (`Outbox.inQueue`).
struct QueueStrip: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var unfolded = false
    @State private var editing: QueuedMessage?

    var body: some View {
        let transcript = model.store.transcript(sessionId)
        let queued = transcript.queued ?? []
        if let next = queued.first {
            let status = transcript.status ?? transcript.session?.status
            let folds = queued.count >= QueueWords.foldAt
            let folded = folds && !unfolded && editing == nil
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "list.number")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.ink2)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(QueueWords.title(queued.count))
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Palette.ink)
                            .accessibilityAddTraits(.isHeader)
                        Text(QueueWords.line(count: queued.count, working: status == .running || status == .waiting,
                                             held: queued.contains(where: \.held)))
                            .font(.footnote)
                            .foregroundStyle(Palette.ink2)
                        if folded {
                            Text("Next: \(QueueWords.text(next))")
                                .font(.footnote)
                                .foregroundStyle(Palette.ink2)
                                .lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if folds {
                        Button(folded ? "Show all" : "Show less") { unfolded = folded }
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Palette.accentInk)
                            .touchTarget()
                    }
                }
                if !folded {
                    ForEach(Array(queued.enumerated()), id: \.element.id) { index, message in
                        Divider()
                            .overlay(Palette.divider)
                            .padding(.vertical, 2)
                        QueuedRow(message: message, index: index, count: queued.count, sessionId: sessionId,
                                  editingHere: editing?.id == message.id) {
                            Task { if await model.holdQueued(message, in: sessionId) { editing = message } }
                        }
                        .transition(.opacity)
                    }
                }
            }
            .padding(.leading, 14)
            .padding(.trailing, 6)
            .padding(.vertical, 8)
            .background(Fill.card, in: RoundedRectangle(cornerRadius: Radius.composer, style: .continuous))
            .animation(Motion.animation(reduceMotion), value: queued.map(\.id))
            .animation(Motion.animation(reduceMotion), value: folded)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Queued messages")
            .sheet(item: $editing) { message in
                QueueEditSheet(message: message, sessionId: sessionId)
            }
        }
    }
}

/// One queued message: its words in two lines, its files, the mark of an edit under way, and its three
/// actions — Edit, Remove, and Send now, which the agent's own note explains. While a call for it is on
/// its way the actions give their place to a spinner.
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
        let busy = model.queueCalls[sessionId]?.contains(message.id) == true
        let away = !model.isConnected
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .trailing, spacing: 4))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 4))
        layout {
            VStack(alignment: .leading, spacing: 4) {
                Text(QueueWords.text(message))
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
                if !message.attachments.isEmpty {
                    QueuedFiles(files: message.attachments, sessionId: sessionId)
                }
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
            HStack(spacing: 0) {
                if busy {
                    ProgressView()
                        .frame(width: ComposerLayout.button * 3, height: ComposerLayout.button)
                } else {
                    QueueButton(title: "Edit", symbol: "pencil", action: edit)
                        .disabled(away || message.held)
                        .accessibilityIdentifier("queue-edit")
                    QueueButton(title: "Remove", symbol: "xmark") { Task { await model.removeQueued(message, in: sessionId) } }
                        .disabled(away)
                        .accessibilityIdentifier("queue-remove")
                    Button { Task { await model.sendQueuedNow(message, in: sessionId) } } label: {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 28, height: 28)
                            .background(Palette.accentFill, in: Circle())
                            .frame(width: ComposerLayout.button, height: ComposerLayout.button)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(away || message.held)
                    .opacity(away || message.held ? 0.45 : 1)
                    .accessibilityLabel("Send now")
                    .accessibilityHint(sendNowLine)
                    .accessibilityShowsLargeContentViewer { Label("Send now", systemImage: "arrow.up") }
                    .accessibilityIdentifier("queue-send-now")
                }
            }
        }
        .padding(.vertical, 2)
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
    let title: String
    let symbol: String
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .semibold))
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

/// A queued message's files in one line: small copies of its pictures, which the Mac sends as it does
/// a sent message's, then their names.
private struct QueuedFiles: View {
    let files: [SentFile]
    let sessionId: String

    var body: some View {
        HStack(spacing: 6) {
            ForEach(files.filter(\.isImage).prefix(3)) { file in
                QueuedPicture(file: file, sessionId: sessionId)
            }
            Text(QueueWords.files(files) ?? "")
                .font(.caption)
                .foregroundStyle(Palette.ink2)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}

private struct QueuedPicture: View {
    let file: SentFile
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.displayScale) private var displayScale
    @ScaledMetric(relativeTo: .caption) private var side: CGFloat = 24

    var body: some View {
        ZStack {
            Rectangle().fill(Fill.bubble)
            if let thumbnail = model.thumbnail(file.path, in: sessionId) {
                Image(uiImage: thumbnail)
                    .resizable()
                    .scaledToFill()
            } else {
                Image(systemName: "photo")
                    .font(.caption2)
                    .foregroundStyle(Palette.ink3)
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .accessibilityHidden(true)
        // Made at the size the sent message's tile draws it: the same path is that tile's once it goes.
        .task(id: model.isConnected) { await model.loadThumbnail(file.path, in: sessionId, side: SentPicture.side * displayScale) }
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
            .navigationTitle("Edit queued message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        saved = true
                        dismiss()
                        Task { await model.editQueued(message, text: text, in: sessionId) }
                    }
                    .disabled(empty)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Ground.grouped)
        .onAppear { focused = true }
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
