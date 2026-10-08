import RealmKit
import SwiftUI

/// The composer, pinned under the transcript: the agent and model it sends to, the field, Stop while
/// the session works, and Send. A message shows as Sending… in the log until the Mac has it.
struct ComposerView: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @FocusState private var focused: Bool

    var body: some View {
        let transcript = model.store.transcript(sessionId)
        let status = transcript.status ?? transcript.session?.status
        let working = status == .running || status == .waiting
        VStack(alignment: .leading, spacing: 8) {
            if let session = transcript.session {
                HStack(spacing: 6) {
                    Text(AgentNames.label(session.agent))
                        .inter(.caption1, .medium)
                    if let modelName = session.model, !modelName.isEmpty {
                        Text(modelName)
                            .mono(.caption1)
                            .lineLimit(1)
                    }
                }
                .foregroundStyle(Palette.ink2)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Sends to \(AgentNames.label(session.agent))\(session.model.map { ", \($0)" } ?? "")")
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message", text: draft, axis: .vertical)
                    .inter(.body)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1...6)
                    .focused($focused)
                    .padding(.vertical, 11)
                    .accessibilityLabel("Message")
                if working {
                    Button {
                        Task { await model.stop(sessionId) }
                    } label: {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Palette.ink)
                            .frame(width: 36, height: 36)
                            .background(Palette.hover2, in: Circle())
                            .touchTarget()
                    }
                    .buttonStyle(.plain)
                    .disabled(!model.isConnected)
                    .accessibilityLabel("Stop")
                    .accessibilityHint("Stops the agent's turn")
                }
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(canSend ? Color.white : Palette.ink3)
                        .frame(width: 36, height: 36)
                        .background(canSend ? Palette.accent : Palette.hover2, in: Circle())
                        .touchTarget()
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .accessibilityLabel("Send")
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 6)
        .padding(.top, 10)
        .padding(.bottom, 4)
        .surface(Palette.surface, radius: Radius.panel)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    private var draft: Binding<String> {
        Binding(get: { model.composerDrafts[sessionId] ?? "" }, set: { model.composerDrafts[sessionId] = $0 })
    }

    private var canSend: Bool {
        !(model.composerDrafts[sessionId] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        guard canSend else { return }
        model.send(model.composerDrafts[sessionId] ?? "", to: sessionId)
        model.composerDrafts[sessionId] = nil
    }
}
