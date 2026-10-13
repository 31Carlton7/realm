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
    var focused: FocusState<Bool>.Binding
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
                        ComposerContext(session: session)
                    }
                    HStack(alignment: .bottom, spacing: 6) {
                        TextField(placeholder(transcript.session), text: draft, axis: .vertical)
                            .font(.body)
                            .foregroundStyle(Palette.ink)
                            .lineLimit(1...6)
                            .focused(focused)
                            .padding(.vertical, 8)
                            .accessibilityLabel("Message")
                        if buttons.send {
                            Button(action: send) {
                                // A bar's button keeps its size at every text size, as the system's do;
                                // a long press shows it large instead.
                                Image(systemName: "arrow.up")
                                    .font(.system(size: 16, weight: .bold))
                                    .foregroundStyle(.white)
                                    .frame(width: 32, height: 32)
                                    .background(Palette.accentFill, in: Circle())
                                    .touchTarget()
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Send")
                            .accessibilityShowsLargeContentViewer()
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
                    StopButton(sessionId: sessionId)
                        .glassEffectID("stop", in: glass)
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

    private func send() {
        let text = model.composerDrafts[sessionId] ?? ""
        guard ComposerButtons(working: false, draft: text).send else { return }
        model.send(text, to: sessionId)
        model.composerDrafts[sessionId] = nil
    }
}

/// Stop, as a glass circle beside whatever it sits with. It has to reach the Mac, so while the Mac is
/// away it keeps its place, greyed.
struct StopButton: View {
    let sessionId: String
    @Environment(AppModel.self) private var model

    var body: some View {
        Button {
            Task { await model.stop(sessionId) }
        } label: {
            Image(systemName: "stop.fill")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Palette.ink)
                .frame(width: 48, height: 48)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: Circle())
        .disabled(!model.isConnected)
        .opacity(model.isConnected ? 1 : 0.45)
        .accessibilityLabel("Stop")
        .accessibilityHint("Stops the agent's turn")
        .accessibilityShowsLargeContentViewer()
    }
}

/// What the next message goes to: the agent's mark in its vendor's colour, and the model as the Mac's
/// chip names it — the prompter's model chip, carried to the phone. A model only known by its id is
/// shown in mono, as an id is.
private struct ComposerContext: View {
    let session: SessionRow

    var body: some View {
        HStack(spacing: 5) {
            AgentMark(kind: session.agent, mark: session.agentMark, colored: true, size: 12, relativeTo: .caption)
            if let label = session.modelLabel, !label.isEmpty {
                Text(label)
                    .font(.caption.weight(.medium))
            } else if let id = session.model, !id.isEmpty {
                Text(id)
                    .mono(.caption)
            } else {
                Text(session.agentDisplayName)
                    .font(.caption.weight(.medium))
            }
        }
        .foregroundStyle(Palette.ink2)
        .lineLimit(1)
        .padding(.top, 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Sends to \(session.agentDisplayName)\(session.modelDisplayName.map { ", \($0)" } ?? "")")
    }
}
