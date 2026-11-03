import RealmKit
import SwiftUI
import UniformTypeIdentifiers

/// Where a share goes: one of the sessions Home last listed, a new session with one of the Mac's
/// agents in a space, or a teammate's chat. What is offered is what the app last heard from the Mac,
/// as the extension cannot ask it; a phone not yet paired is told to pair first.
struct ShareView: View {
    let draft: ShareDraft
    let targets: ShareTargets?
    let send: (ShareTarget) -> Void
    let cancel: () -> Void
    @State private var target: ShareTarget?
    @State private var spaceId: String?
    @State private var agentKind: String?

    var body: some View {
        NavigationStack {
            Group {
                if let targets {
                    picker(targets)
                } else {
                    ContentUnavailableView("Pair Realm first", systemImage: "laptopcomputer",
                                           description: Text("Open Realm on this iPhone and pair it with your Mac, then share again."))
                }
            }
            .background(Ground.grouped)
            .navigationTitle("Share to Realm")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: cancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") { if let target { send(target) } }
                        .disabled(target == nil || draft.loading > 0 || draft.isEmpty)
                }
            }
        }
    }

    private func picker(_ targets: ShareTargets) -> some View {
        @Bindable var draft = draft
        let space = targets.spaces.first { $0.id == (spaceId ?? targets.spaceId) } ?? targets.spaces.first
        return List {
            Section {
                ShareSummary(draft: draft)
                TextField("Add a message", text: $draft.note, axis: .vertical)
                    .lineLimit(1...4)
            } footer: {
                if let problem = draft.problem {
                    Text(problem)
                }
            }
            .listRowBackground(Fill.card)
            if let space, let agent = targets.agents.first(where: { $0.kind == agentKind }) ?? targets.agents.first {
                let fresh = ShareTarget.newSession(agent: agent.kind, spaceId: space.id)
                Section("New session") {
                    TargetRow(title: "Start a new session", detail: "\(agent.name) in \(space.name)", chosen: target == fresh) {
                        target = fresh
                    }
                    Picker("Space", selection: Binding(get: { space.id }, set: { spaceId = $0; target = .newSession(agent: agent.kind, spaceId: $0) })) {
                        ForEach(targets.spaces) { Text($0.name).tag($0.id) }
                    }
                    Picker("Agent", selection: Binding(get: { agent.kind }, set: { agentKind = $0; target = .newSession(agent: $0, spaceId: space.id) })) {
                        ForEach(targets.agents, id: \.kind) { Text($0.name).tag($0.kind) }
                    }
                }
                .listRowBackground(Fill.card)
            }
            if let teammates = targets.teammates, !teammates.isEmpty {
                Section("Teammates") {
                    ForEach(teammates) { teammate in
                        let spaceName = targets.spaces.first { $0.id == teammate.spaceId }?.name
                        TargetRow(title: teammate.name, detail: spaceName.map { "@\(teammate.handle) · \($0)" } ?? "@\(teammate.handle)",
                                  chosen: target == .teammate(id: teammate.id)) {
                            target = .teammate(id: teammate.id)
                        }
                    }
                }
                .listRowBackground(Fill.card)
            }
            if !targets.sessions.isEmpty {
                Section("Sessions on \(targets.macName)") {
                    ForEach(targets.sessions) { session in
                        TargetRow(title: session.title, detail: [session.spaceName, session.agentName ?? session.agent].joined(separator: " · "),
                                  chosen: target == .session(id: session.id)) {
                            target = .session(id: session.id)
                        }
                    }
                }
                .listRowBackground(Fill.card)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
    }
}

/// What is going: "2 photos and a video", or the link or text when nothing else is, and a spinner while
/// the other app is still handing it over.
private struct ShareSummary: View {
    let draft: ShareDraft

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: draft.files.isEmpty ? "text.quote" : "paperclip")
                .foregroundStyle(Palette.ink2)
            Text(ShareWords.summary(files: draft.files.map(\.name), shared: draft.shared))
                .foregroundStyle(Palette.ink)
                .lineLimit(2)
            Spacer(minLength: 0)
            if draft.loading > 0 { ProgressView() }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct TargetRow: View {
    let title: String
    let detail: String?
    let chosen: Bool
    let choose: () -> Void

    var body: some View {
        Button(action: choose) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                    if let detail {
                        Text(detail)
                            .font(.footnote)
                            .foregroundStyle(Palette.ink2)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                if chosen {
                    Image(systemName: "checkmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Palette.accent)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}

/// What the share sheet says in words.
enum ShareWords {
    /// "2 photos and a video", "deck.pdf", or the link shared where no file is.
    static func summary(files: [String], shared: [String]) -> String {
        guard !files.isEmpty else { return shared.first ?? "Nothing yet" }
        if files.count == 1 { return files[0] }
        let photos = files.filter { kind(of: $0) == .photo }.count
        let videos = files.filter { kind(of: $0) == .video }.count
        let others = files.count - photos - videos
        let parts = [counted(photos, "photo"), counted(videos, "video"), counted(others, "file")].compactMap { $0 }
        return parts.count > 1 ? parts.dropLast().joined(separator: ", ") + " and " + parts[parts.count - 1] : parts[0]
    }

    private enum Kind { case photo, video, other }

    private static func kind(of name: String) -> Kind {
        guard let type = UTType(filenameExtension: (name as NSString).pathExtension) else { return .other }
        if type.conforms(to: .image) { return .photo }
        if type.conforms(to: .movie) { return .video }
        return .other
    }

    private static func counted(_ count: Int, _ noun: String) -> String? {
        switch count {
        case 0: nil
        case 1: "a \(noun)"
        default: "\(count) \(noun)s"
        }
    }
}
