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
    enum Kind: Hashable {
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
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var settingsShown = false
    @State private var picking: AttachmentPick?
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
        let presenting = settingsShown || picking != nil || previewing != nil
        let composing = focused.wrappedValue || !text.isEmpty || !attachments.isEmpty || preparing > 0 || presenting
        let action = ComposerAction(working: status == .running || status == .waiting,
                                    hasContent: ComposerAction.hasContent(text: text, attachments: attachments),
                                    midTurn: options?.midTurn, canSteer: options != nil)
        ComposerLayout(card: composing) {
            if !attachments.isEmpty || preparing > 0 {
                AttachmentStrip(attachments: attachments, preparing: preparing, files: model.store.files,
                                open: { attachment in
                                    refocus = focused.wrappedValue
                                    previewing = AttachmentStrip.previewLink(attachment, files: model.store.files)
                                },
                                remove: { model.removeAttachment($0, from: sessionId) })
                    .layoutValue(key: ComposerPart.self, value: .strip)
                    .transition(.opacity)
            }
            TextField(placeholder(session), text: draft, axis: .vertical)
                .tint(Palette.accent)
                .font(.body)
                .foregroundStyle(Palette.ink)
                // Then it scrolls; at the accessibility sizes sooner, so the newest row stays in view.
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 1...4 : 1...8)
                .focused(focused)
                .padding(.vertical, ComposerLayout.fieldInset)
                .accessibilityLabel("Message")
                .layoutValue(key: ComposerPart.self, value: .field)
            // Files go only to a Mac that answers `session.options`: an older one would drop them.
            if let options {
                AddMenu(limits: options.attachments, count: attachments.count + preparing) { pick in
                    refocus = focused.wrappedValue
                    picking = pick
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
        .attachmentPickers($picking, room: (options?.attachments.maxCount ?? 1) - attachments.count - preparing) { sources in
            Task { await model.attach(sources, to: sessionId) }
        }
        .sheet(isPresented: $settingsShown) {
            SessionSettingsSheet(sessionId: sessionId)
        }
        .quickLookPreview($previewing)
        .onChange(of: previewing) { _, now in
            if now == nil { AttachmentStrip.forgetPreviews() }
        }
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

    /// A button's side, and the toolbar's height until its chips' words need more.
    static let button: CGFloat = 44
    /// The field's own padding above and below its lines.
    static let fieldInset: CGFloat = 11

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
            // The field across the card, the toolbar under it: as tall as its chips' words, which grow
            // with the text size while the buttons keep theirs, centred beside them.
            let fieldWidth = width - 32
            let fieldHeight = field.map { subviews[$0].sizeThatFits(ProposedViewSize(width: fieldWidth, height: nil)).height } ?? button
            if let field { frames[field] = CGRect(x: 16, y: top, width: fieldWidth, height: fieldHeight) }
            let bar = top + fieldHeight - 4
            let leading: CGFloat = add == nil ? 10 : 4 + button
            let trailing = width - 4 - button
            let chipsWidth = max(0, trailing - 4 - leading)
            let barHeight = max(button, chips.map { subviews[$0].sizeThatFits(ProposedViewSize(width: chipsWidth, height: nil)).height } ?? 0)
            let middle = bar + (barHeight - button) / 2
            if let add { frames[add] = CGRect(x: 4, y: middle, width: button, height: button) }
            if let primary { frames[primary] = CGRect(x: trailing, y: middle, width: button, height: button) }
            if let chips { frames[chips] = CGRect(x: leading, y: bar, width: chipsWidth, height: barHeight) }
            return (frames, bar + barHeight + 4)
        }
        // One row, the buttons beside the field's last line as it grows: centred on that line, which at
        // the accessibility sizes is taller than a button, rather than at the field's foot below it.
        let fieldX: CGFloat = add == nil ? 16 : 4 + button
        let fieldWidth = max(0, width - fieldX - 4 - button - 2)
        let fieldHeight = field.map { subviews[$0].sizeThatFits(ProposedViewSize(width: fieldWidth, height: nil)).height } ?? button
        let row = max(button, fieldHeight)
        let fieldY = top + (row - fieldHeight) / 2
        let lastLine = fieldY + fieldHeight - Self.fieldInset - UIFont.preferredFont(forTextStyle: .body).lineHeight / 2
        let buttonY = min(top + row - button, max(top, lastLine - button / 2))
        if let field { frames[field] = CGRect(x: fieldX, y: fieldY, width: fieldWidth, height: fieldHeight) }
        if let add { frames[add] = CGRect(x: 4, y: buttonY, width: button, height: button) }
        if let primary { frames[primary] = CGRect(x: width - 4 - button, y: buttonY, width: button, height: button) }
        if let chips { frames[chips] = CGRect(x: fieldX, y: top + row, width: 0, height: 0) }
        return (frames, top + row + 2)
    }
}

/// Where `+` takes the person: the photo library, the camera, or Files.
enum AttachmentPick {
    case photos, camera, files
}

extension View {
    /// The photo library, the camera and Files, each presented while `pick` names it, with what was
    /// picked handed to `attach`. The library offers as many photos as `room` leaves, and at least one.
    func attachmentPickers(_ pick: Binding<AttachmentPick?>, room: Int, attach: @escaping ([AttachmentSource]) -> Void) -> some View {
        modifier(AttachmentPickers(pick: pick, room: room, attach: attach))
    }
}

private struct AttachmentPickers: ViewModifier {
    @Binding var pick: AttachmentPick?
    let room: Int
    let attach: ([AttachmentSource]) -> Void
    @State private var picked: [PhotosPickerItem] = []

    func body(content: Content) -> some View {
        content
            .photosPicker(isPresented: shown(.photos), selection: $picked, maxSelectionCount: max(1, room), matching: .images)
            .onChange(of: picked) { _, items in
                guard !items.isEmpty else { return }
                picked = []
                attach(items.map(AttachmentSource.library))
            }
            .fullScreenCover(isPresented: shown(.camera)) {
                CameraPicker { image in
                    pick = nil
                    if let image { attach([.camera(image)]) }
                }
                .ignoresSafeArea()
            }
            .fileImporter(isPresented: shown(.files), allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                if case .success(let urls) = result, !urls.isEmpty { attach(urls.map(AttachmentSource.file)) }
            }
    }

    private func shown(_ kind: AttachmentPick) -> Binding<Bool> {
        Binding(get: { pick == kind }, set: { if !$0, pick == kind { pick = nil } })
    }
}

/// `+`: photos, the camera where the phone has one, and files. At the Mac's limit its items are off,
/// and each says why.
struct AddMenu: View {
    let limits: SendLimits
    /// Files already in the message, or on their way into it.
    let count: Int
    let pick: (AttachmentPick) -> Void

    var body: some View {
        let full = count >= limits.maxCount
        Menu {
            item("Photo library", "photo.on.rectangle", .photos, full: full)
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                item("Take photo", "camera", .camera, full: full)
            }
            item("Choose files", "folder", .files, full: full)
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
            Label(title, systemImage: symbol)
            if full { Text(AttachmentLimits.full(limits)) }
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
        let away = unreachable(kind)
        Group {
            if action.alternatives.isEmpty {
                Button { perform(kind) } label: { glyph }
                    .buttonStyle(.plain)
            } else {
                Menu {
                    ForEach(action.alternatives, id: \.self) { other in
                        // A second line of words in an item's label is what a menu draws under its title.
                        let item = Button(role: other == .stop ? .destructive : nil) { perform(other) } label: {
                            Label(other.title, systemImage: other.symbol)
                            if let line = other.explanation(steerNote: steerNote) { Text(line) }
                        }
                        .disabled(unreachable(other))
                        // The app's tint colours every glyph in a menu, a destructive one's too: Stop's takes its words' red.
                        if other == .stop { item.tint(.red) } else { item }
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

    /// Stop has to reach the Mac: while it is away, Stop keeps its place, greyed. A message waits.
    private func unreachable(_ kind: ComposerAction.Kind) -> Bool {
        kind == .stop && !connected
    }

    private var glyph: some View {
        PrimaryGlyph(kind: action.kind, enabled: action.enabled)
    }
}

/// The primary button's face: the kind's glyph on its fill, a quiet one while there is nothing to send.
struct PrimaryGlyph: View {
    let kind: ComposerAction.Kind
    let enabled: Bool

    var body: some View {
        let (fill, ink): (Color, Color) = switch kind {
        case .stop: (Palette.ink, Ground.transcript)
        case .send where !enabled: (Palette.mark, Palette.ink3)
        case .send, .queue, .steer: (Palette.accentFill, .white)
        }
        Image(systemName: kind.symbol)
            .font(.system(size: kind == .stop ? 12 : 15, weight: .bold))
            .foregroundStyle(ink)
            .contentTransition(.symbolEffect(.replace))
            .frame(width: 32, height: 32)
            .background(fill, in: Circle())
            .frame(width: ComposerLayout.button, height: ComposerLayout.button)
            .contentShape(Rectangle())
    }
}
