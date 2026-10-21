import PhotosUI
import QuickLook
import RealmKit
import SwiftUI
import UIKit

/// What the composer's one button does, from whether a turn is under way and whether anything is there
/// to send. Idle, it sends, and is off with nothing to send. While a turn runs it stops the turn, until
/// something is typed or attached; then it sends as the Mac takes a message mid-turn — queued for the
/// turn's end, or steered into it — and a long press offers the other way, and Stop.
struct ComposerAction: Equatable {
    enum Kind: Hashable, CaseIterable {
        case send, stop, queue, steer
    }

    let kind: Kind
    let enabled: Bool
    /// What a long press offers besides, in order.
    let alternatives: [Kind]

    /// `midTurn` and `canSteer` are the Mac's to say (`session.options`). A Mac that does not say is
    /// never offered Steer: only it knows what steering does to its agent's turn.
    init(working: Bool, hasContent: Bool, midTurn: Delivery?, canSteer: Bool) {
        if !working {
            kind = .send
            enabled = hasContent
            alternatives = []
        } else if !hasContent {
            kind = .stop
            enabled = true
            alternatives = []
        } else {
            kind = canSteer && midTurn == .steer ? .steer : .queue
            enabled = true
            alternatives = (canSteer ? [kind == .steer ? .queue : .steer] : []) + [.stop]
        }
    }

    /// Words or a file: something to send.
    static func hasContent(text: String, attachments: [OutgoingAttachment]) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
    }

    /// How a message goes when this is pressed; nil for Stop.
    static func delivery(_ kind: Kind) -> Delivery? {
        switch kind {
        case .send: .auto
        case .queue: .queue
        case .steer: .steer
        case .stop: nil
        }
    }
}

extension ComposerAction.Kind {
    var title: String {
        switch self {
        case .send: "Send"
        case .stop: "Stop"
        case .queue: "Queue"
        case .steer: "Steer"
        }
    }

    var symbol: String {
        switch self {
        case .send: "arrow.up"
        case .stop: "stop.fill"
        case .queue: "list.number"
        case .steer: "arrow.turn.left.up"
        }
    }

    /// What it does, in a line: under it in the long press, and VoiceOver's hint. Steer's is the Mac's
    /// own for its agent, since steering stops some agents' turns and not others'.
    func explanation(steerNote: String) -> String? {
        switch self {
        case .send: nil
        case .stop: "Stops the agent's turn."
        case .queue: "Sends when this turn ends."
        case .steer: steerNote.isEmpty ? "Sends now, into the turn under way." : steerNote
        }
    }
}

/// The composer, floating over the transcript's foot in the glass the system's bars wear. At rest it is
/// one capsule — `+`, the field, the button. Composing — the field focused, or something typed or
/// attached — it is a card: the files over the field, and under it a toolbar of `+`, the model and mode
/// chips, and the one button, which is Send, Stop, Queue or Steer as the moment asks. A message shows
/// as Sending… in the log until the Mac has it.
struct ComposerView: View {
    let sessionId: String
    var focused: FocusState<Bool>.Binding
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var settingsShown = false
    @State private var photosShown = false
    @State private var cameraShown = false
    @State private var filesShown = false
    @State private var picked: [PhotosPickerItem] = []
    @State private var previewing: URL?
    /// The field had the keyboard when a sheet or a picker opened over it: it takes it back after.
    @State private var refocus = false

    var body: some View {
        let transcript = model.store.transcript(sessionId)
        let session = transcript.session
        let status = transcript.status ?? session?.status
        let text = model.composerDrafts[sessionId] ?? ""
        let attachments = model.draftAttachments[sessionId] ?? []
        let preparing = model.preparingAttachments[sessionId] ?? 0
        let options = model.sessionOptions[sessionId]
        let presenting = settingsShown || photosShown || cameraShown || filesShown || previewing != nil
        let composing = focused.wrappedValue || !text.isEmpty || !attachments.isEmpty || preparing > 0 || presenting
        let action = ComposerAction(working: status == .running || status == .waiting,
                                    hasContent: ComposerAction.hasContent(text: text, attachments: attachments),
                                    midTurn: options?.midTurn, canSteer: options != nil)
        ComposerLayout(card: composing) {
            if composing, !attachments.isEmpty || preparing > 0 {
                AttachmentStrip(attachments: attachments, preparing: preparing, files: model.store.files,
                                open: preview, remove: { model.removeAttachment($0, from: sessionId) })
                    .layoutValue(key: ComposerPart.self, value: .strip)
                    .transition(.opacity)
            }
            TextField(placeholder(session), text: draft, axis: .vertical)
                .font(.body)
                .foregroundStyle(Palette.ink)
                .lineLimit(1...8)
                .focused(focused)
                .padding(.vertical, 11)
                .accessibilityLabel("Message")
                .layoutValue(key: ComposerPart.self, value: .field)
            // Files go only to a Mac that answers `session.options`: an older one would drop them.
            if let options {
                AddMenu(limits: options.attachments, count: attachments.count + preparing) { pick in
                    refocus = focused.wrappedValue
                    switch pick {
                    case .photos: photosShown = true
                    case .camera: cameraShown = true
                    case .files: filesShown = true
                    }
                }
                .layoutValue(key: ComposerPart.self, value: .add)
            }
            if composing {
                ComposerChips(sessionId: sessionId) {
                    refocus = focused.wrappedValue
                    settingsShown = true
                }
                .layoutValue(key: ComposerPart.self, value: .chips)
                .transition(.opacity.animation(.easeOut(duration: 0.2)))
            }
            PrimaryButton(action: action, steerNote: options?.agent.steerNote ?? "", connected: model.isConnected) { kind in
                if let delivery = ComposerAction.delivery(kind) {
                    model.sendDraft(sessionId, delivery: delivery)
                } else {
                    Task { await model.stop(sessionId) }
                }
            }
            .layoutValue(key: ComposerPart.self, value: .primary)
        }
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: Radius.composer, style: .continuous))
        // Under Reduce Motion the card does not grow into place: it is there, and its new parts fade in.
        .animation(reduceMotion ? nil : Motion.morph, value: composing)
        .animation(reduceMotion ? nil : Motion.morph, value: attachments.count + preparing)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .photosPicker(isPresented: $photosShown, selection: $picked,
                      maxSelectionCount: max(1, (options?.attachments.maxCount ?? 1) - attachments.count - preparing),
                      matching: .images)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            picked = []
            Task { await model.attach(items.map(AttachmentSource.library), to: sessionId) }
        }
        .fullScreenCover(isPresented: $cameraShown) {
            CameraPicker { image in
                cameraShown = false
                if let image { Task { await model.attach([.camera(image)], to: sessionId) } }
            }
            .ignoresSafeArea()
        }
        .fileImporter(isPresented: $filesShown, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result, !urls.isEmpty {
                Task { await model.attach(urls.map(AttachmentSource.file), to: sessionId) }
            }
        }
        .sheet(isPresented: $settingsShown) {
            SessionSettingsSheet(sessionId: sessionId)
        }
        .quickLookPreview($previewing)
        .onChange(of: presenting) { _, now in
            guard !now, refocus else { return }
            refocus = false
            focused.wrappedValue = true
        }
    }

    /// The field names who the message goes to, and when the Mac is away, when it will go.
    private func placeholder(_ session: SessionRow?) -> String {
        switch model.linkStatus.kind {
        case .connected, .connecting:
            session.map { "Message \($0.agentDisplayName)" } ?? "Message"
        case .asleep:
            "Sends when your Mac wakes"
        case .relayUnreachable:
            "Sends once the relay is back"
        case .notAnswering, .notConnected, .refused:
            "Sends when your Mac is connected"
        }
    }

    private var draft: Binding<String> {
        Binding(get: { model.composerDrafts[sessionId] ?? "" }, set: { model.composerDrafts[sessionId] = $0 })
    }

    /// Quick Look titles a preview with its file's name, so it is shown a link to the bytes under the
    /// attachment's own.
    private func preview(_ attachment: OutgoingAttachment) {
        let folder = URL.temporaryDirectory.appending(path: "Preview/\(attachment.id.uuidString)", directoryHint: .isDirectory)
        let link = folder.appending(path: attachment.name.replacingOccurrences(of: "/", with: "-"))
        if !FileManager.default.fileExists(atPath: link.path) {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try? FileManager.default.linkItem(at: model.store.files.url(of: attachment), to: link)
        }
        refocus = focused.wrappedValue
        previewing = link
    }
}

/// A part of the composer, as `ComposerLayout` places it.
enum ComposerPart: LayoutValueKey {
    case strip, field, add, chips, primary

    static let defaultValue = ComposerPart.field
}

/// Where the composer's parts go. At rest, one row: `+`, the field, the button. As a card: the files,
/// the field under them, and a toolbar of `+`, the chips and the button under that. A part keeps who it
/// is between the two, so the field keeps the keyboard and each part moves to its new place.
struct ComposerLayout: Layout {
    var card: Bool

    /// A button's side, which is also the toolbar's height.
    static let button: CGFloat = 44

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.replacingUnspecifiedDimensions().width
        return CGSize(width: width, height: frames(width: width, subviews: subviews).height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (index, frame) in frames(width: bounds.width, subviews: subviews).frames {
            subviews[index].place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), proposal: ProposedViewSize(frame.size))
        }
    }

    private func frames(width: CGFloat, subviews: Subviews) -> (frames: [Int: CGRect], height: CGFloat) {
        func index(_ part: ComposerPart) -> Int? { subviews.firstIndex { $0[ComposerPart.self] == part } }
        let button = Self.button
        var frames: [Int: CGRect] = [:]
        var top: CGFloat = card ? 4 : 2
        if let strip = index(.strip) {
            let height = subviews[strip].sizeThatFits(ProposedViewSize(width: width - 24, height: nil)).height
            frames[strip] = CGRect(x: 12, y: 4, width: width - 24, height: height)
            top = 4 + height
        }
        let add = index(.add), chips = index(.chips), primary = index(.primary)
        let field = index(.field)
        if card {
            // The field across the card, the toolbar under it.
            let fieldWidth = width - 32
            let fieldHeight = field.map { subviews[$0].sizeThatFits(ProposedViewSize(width: fieldWidth, height: nil)).height } ?? button
            if let field { frames[field] = CGRect(x: 16, y: top, width: fieldWidth, height: fieldHeight) }
            let bar = top + fieldHeight - 4
            var leading: CGFloat = 4
            if let add {
                frames[add] = CGRect(x: leading, y: bar, width: button, height: button)
                leading += button
            } else {
                leading = 10
            }
            let trailing = width - 4 - button
            if let primary { frames[primary] = CGRect(x: trailing, y: bar, width: button, height: button) }
            if let chips { frames[chips] = CGRect(x: leading, y: bar, width: max(0, trailing - 4 - leading), height: button) }
            return (frames, bar + button + 4)
        }
        // One row, the buttons at its foot as the field grows.
        let fieldX: CGFloat = add == nil ? 16 : 4 + button
        let fieldWidth = max(0, width - fieldX - 4 - button - 2)
        let fieldHeight = field.map { subviews[$0].sizeThatFits(ProposedViewSize(width: fieldWidth, height: nil)).height } ?? button
        let row = max(button, fieldHeight)
        if let field { frames[field] = CGRect(x: fieldX, y: top + (row - fieldHeight) / 2, width: fieldWidth, height: fieldHeight) }
        if let add { frames[add] = CGRect(x: 4, y: top + row - button, width: button, height: button) }
        if let primary { frames[primary] = CGRect(x: width - 4 - button, y: top + row - button, width: button, height: button) }
        if let chips { frames[chips] = CGRect(x: fieldX, y: top + row, width: 0, height: 0) }
        return (frames, top + row + 2)
    }
}

/// Where `+` takes the person: the photo library, the camera, or Files.
enum AttachmentPick {
    case photos, camera, files
}

/// `+`: photos, the camera where the phone has one, and files. At the Mac's limit its items are off,
/// and each says why.
private struct AddMenu: View {
    let limits: SendLimits
    /// Files already in the message, or on their way into it.
    let count: Int
    let pick: (AttachmentPick) -> Void

    var body: some View {
        let full = count >= limits.maxCount
        Menu {
            item("Photo Library", "photo.on.rectangle", .photos, full: full)
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                item("Take Photo", "camera", .camera, full: full)
            }
            item("Choose Files", "folder", .files, full: full)
        } label: {
            // A bar's button keeps its size at every text size, as the system's do; a long press shows it large.
            Image(systemName: "plus")
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(Palette.ink)
                .frame(width: ComposerLayout.button, height: ComposerLayout.button)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Add photos or files")
        .accessibilityShowsLargeContentViewer {
            Label("Add photos or files", systemImage: "plus")
        }
    }

    private func item(_ title: String, _ symbol: String, _ kind: AttachmentPick, full: Bool) -> some View {
        Button { pick(kind) } label: {
            Label {
                Text(title)
                if full { Text(AttachmentLimits.full(limits)) }
            } icon: {
                Image(systemName: symbol)
            }
        }
        .disabled(full)
    }
}

/// The one button at the composer's end. With a choice to offer, a tap does the button's own thing
/// and a long press opens the others, each with what it does under it.
private struct PrimaryButton: View {
    let action: ComposerAction
    let steerNote: String
    let connected: Bool
    let perform: (ComposerAction.Kind) -> Void

    var body: some View {
        let kind = action.kind
        // Stop has to reach the Mac: while it is away, Stop keeps its place, greyed. A message waits.
        let away = kind == .stop && !connected
        Group {
            if action.alternatives.isEmpty {
                Button { perform(kind) } label: { glyph }
                    .buttonStyle(.plain)
            } else {
                Menu {
                    ForEach(action.alternatives, id: \.self) { other in
                        Button(role: other == .stop ? .destructive : nil) { perform(other) } label: {
                            Label {
                                Text(other.title)
                                if let line = other.explanation(steerNote: steerNote) { Text(line) }
                            } icon: {
                                Image(systemName: other.symbol)
                            }
                        }
                        .disabled(other == .stop && !connected)
                    }
                } label: {
                    glyph
                } primaryAction: {
                    perform(kind)
                }
                .accessibilityActions {
                    ForEach(action.alternatives, id: \.self) { other in
                        Button(other.title) { perform(other) }
                    }
                }
            }
        }
        .disabled(!action.enabled || away)
        .opacity(away ? 0.45 : 1)
        .accessibilityLabel(kind.title)
        .accessibilityHint(kind.explanation(steerNote: steerNote) ?? "")
        .accessibilityShowsLargeContentViewer {
            Label(kind.title, systemImage: kind.symbol)
        }
    }

    private var glyph: some View {
        let (fill, ink): (Color, Color) = switch action.kind {
        case .stop: (Palette.ink, Ground.transcript)
        case .send where !action.enabled: (Palette.mark, Palette.ink3)
        case .send, .queue, .steer: (Palette.accentFill, .white)
        }
        return Image(systemName: action.kind.symbol)
            .font(.system(size: action.kind == .stop ? 12 : 15, weight: .bold))
            .foregroundStyle(ink)
            .contentTransition(.symbolEffect(.replace))
            .frame(width: 32, height: 32)
            .background(fill, in: Circle())
            .frame(width: ComposerLayout.button, height: ComposerLayout.button)
            .contentShape(Rectangle())
    }
}
