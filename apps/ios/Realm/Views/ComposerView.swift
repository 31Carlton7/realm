import RealmKit
import SwiftUI

/// Which of the composer's two buttons are up. Send while there is something to send; Stop while a
/// turn is under way, whatever is typed, so it never hides behind a draft.
struct ComposerButtons: Equatable {
    let send: Bool
    let stop: Bool

    init(working: Bool, draft: String) {
        send = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        stop = working
    }
}

/// The composer, floating over the transcript's foot as the system's bars do, so it wears their glass:
/// the agent and model it sends to, the field, Stop while the session works, and Send. A message shows
/// as Sending… in the log until the Mac has it.
struct ComposerView: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var focused: Bool
    @Namespace private var glass

    var body: some View {
        let transcript = model.store.transcript(sessionId)
        let status = transcript.status ?? transcript.session?.status
        let buttons = ComposerButtons(working: status == .running || status == .waiting,
                                      draft: model.composerDrafts[sessionId] ?? "")
        GlassEffectContainer(spacing: 10) {
            HStack(alignment: .bottom, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    if let session = transcript.session {
                        ComposerContext(agent: session.agent, model: session.model)
                    }
                    HStack(alignment: .bottom, spacing: 6) {
                        TextField(placeholder(transcript.session), text: draft, axis: .vertical)
                            .font(.body)
                            .foregroundStyle(Palette.ink)
                            .lineLimit(1...6)
                            .focused($focused)
                            .padding(.vertical, 8)
                            .accessibilityLabel("Message")
                        if buttons.send {
                            Button(action: send) {
                                Image(systemName: "arrow.up")
                                    .font(.body.weight(.bold))
                                    .foregroundStyle(.white)
                                    .frame(width: 32, height: 32)
                                    .background(Palette.accent, in: Circle())
                                    .touchTarget()
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Send")
                            .transition(reduceMotion ? .opacity : .scale(scale: 0.4).combined(with: .opacity))
                        }
                    }
                }
                .padding(.leading, 16)
                .padding(.trailing, buttons.send ? 2 : 16)
                .padding(.top, 8)
                .frame(minHeight: 44)
                .glassEffect(.regular, in: RoundedRectangle(cornerRadius: Radius.composer, style: .continuous))
                .glassEffectID("field", in: glass)
                if buttons.stop {
                    Button {
                        Task { await model.stop(sessionId) }
                    } label: {
                        Image(systemName: "stop.fill")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Palette.ink)
                            .frame(width: 48, height: 48)
                    }
                    .buttonStyle(.plain)
                    .glassEffect(.regular.interactive(), in: Circle())
                    .glassEffectID("stop", in: glass)
                    .accessibilityLabel("Stop")
                    .accessibilityHint("Stops the agent's turn")
                }
            }
        }
        .animation(Motion.animation(reduceMotion), value: buttons)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    /// The field names who the message goes to, and when the Mac is away, when it will go.
    private func placeholder(_ session: SessionRow?) -> String {
        switch model.linkStatus.kind {
        case .connected, .connecting:
            session.map { "Message \(AgentNames.label($0.agent))" } ?? "Message"
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

    private func send() {
        let text = model.composerDrafts[sessionId] ?? ""
        guard ComposerButtons(working: false, draft: text).send else { return }
        model.send(text, to: sessionId)
        model.composerDrafts[sessionId] = nil
    }
}

/// What the next message goes to: the agent's mark in its vendor's colour, and the model in mono — the
/// Mac's model chip, carried to the phone.
private struct ComposerContext: View {
    let agent: String
    let model: String?

    var body: some View {
        HStack(spacing: 5) {
            AgentMark(kind: agent, colored: true, size: 12, relativeTo: .caption)
            Text(model.flatMap { $0.isEmpty ? nil : $0 } ?? AgentNames.label(agent))
                .mono(.caption)
                .foregroundStyle(Palette.ink2)
                .lineLimit(1)
        }
        .padding(.top, 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Sends to \(AgentNames.label(agent))\(model.map { ", \($0)" } ?? "")")
    }
}
