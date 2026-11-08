import RealmKit
import SwiftUI

extension AppModel {
    /// Forks the session as it is now, onto `agent` where it names another, and opens the fork, as the
    /// desktop opens one.
    func fork(_ row: SessionRow, onto agent: String?) {
        guard let api, isConnected else {
            show(toast: "Connect to your Mac to change this session.")
            return
        }
        show(toast: "Forking “\(row.displayTitle)”…")
        Task {
            do {
                let fork = try await api.forkSession(id: row.id, agent: agent)
                toast = nil
                path.append(.session(fork.id))
                await refreshHome()
            } catch {
                show(toast: "Not forked. \(Self.describe(error))")
            }
        }
    }

    func moveToSpace(_ row: SessionRow, to space: Space) async {
        guard let api, isConnected else {
            show(toast: "Connect to your Mac to change this session.")
            return
        }
        do {
            store.sessionChanged(try await api.moveToSpace(id: row.id, spaceId: space.id))
            show(toast: "Moved “\(row.displayTitle)” to \(space.name).")
            await refreshHome()
        } catch {
            show(toast: "Not moved. \(Self.describe(error))")
        }
    }

    /// Switches the session's agent; the Mac's reason where it would not, for the sheet to say.
    func switchAgent(_ row: SessionRow, to agent: String) async -> String? {
        guard let api, isConnected else { return "Connect to your Mac to change this session." }
        do {
            store.sessionChanged(try await api.switchAgent(id: row.id, agent: agent))
            await refreshHome()
            return nil
        } catch {
            return Self.describe(error)
        }
    }

    func setAccount(_ row: SessionRow, to accountId: String) async -> String? {
        guard let api, isConnected else { return "Connect to your Mac to change this session." }
        do {
            store.sessionChanged(try await api.setAccount(id: row.id, accountId: accountId))
            return nil
        } catch {
            return Self.describe(error)
        }
    }

    /// Deletes the session the confirmation was up for; its screen closes if it is open.
    func deleteSession(_ row: SessionRow) {
        guard let api, isConnected else {
            show(toast: "Connect to your Mac to change this session.")
            return
        }
        Task {
            do {
                try await api.deleteSession(id: row.id)
                path.removeAll { $0 == .session(row.id) }
                show(toast: "Deleted “\(row.displayTitle)”.")
                await refreshHome()
            } catch {
                show(toast: "Not deleted. \(Self.describe(error))")
            }
        }
    }

    /// Reads which of an open session's turns are saved; until it answers, none show as saved.
    func loadSaved(_ sessionId: String) async {
        guard let api, isConnected, let seqs = try? await api.saved(id: sessionId) else { return }
        store.saved[sessionId] = Set(seqs)
    }

    /// Saves or unsaves the turn `seq` starts, shown at once and put back with a toast where the Mac
    /// refuses.
    func toggleSaved(_ seq: Int, in sessionId: String) {
        let before = store.saved[sessionId] ?? []
        let saving = !before.contains(seq)
        guard let api, isConnected else {
            show(toast: "Connect to your Mac to change this session.")
            return
        }
        store.saved[sessionId] = saving ? before.union([seq]) : before.subtracting([seq])
        Task {
            do {
                store.saved[sessionId] = Set(try await api.setSaved(id: sessionId, seq: seq, saved: saving))
            } catch {
                store.saved[sessionId] = before
                show(toast: "\(saving ? "Not saved." : "Not unsaved.") \(Self.describe(error))")
            }
        }
    }
}

extension View {
    /// The sheets and the confirmation a session's menus open, wherever the menu was.
    func sessionActionSheets() -> some View {
        modifier(SessionActionSheets())
    }
}

private struct SessionActionSheets: ViewModifier {
    @Environment(AppModel.self) private var model

    func body(content: Content) -> some View {
        @Bindable var model = model
        content
            .sheet(item: $model.movingToSpace) { row in
                MoveToSpaceSheet(row: row)
            }
            .sheet(item: $model.switchingAgent) { row in
                SwitchAgentSheet(row: row)
            }
            .confirmationDialog(deleteTitle, isPresented: deleting, titleVisibility: .visible, presenting: model.deleting) { row in
                Button("Delete", role: .destructive) { model.deleteSession(row) }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("Deletes the session and its transcript. Nothing in Realm brings it back.")
            }
    }

    private var deleteTitle: String {
        "Delete “\(model.deleting?.displayTitle ?? "this session")”?"
    }

    private var deleting: Binding<Bool> {
        Binding(get: { model.deleting != nil }, set: { if !$0 { model.deleting = nil } })
    }
}

/// Move to space…: the other spaces of the session's profile, as the desktop's row menu lists them, the
/// one it is in ticked.
struct MoveToSpaceSheet: View {
    let row: SessionRow
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var moving: String?

    var body: some View {
        let spaces = Self.spaces(for: row, in: model.store.home)
        SettingsSheetFrame(title: "Move to space", kind: nil, mark: nil) {
            Section {
                if spaces.count < 2 {
                    Text("No other spaces")
                        .foregroundStyle(Palette.ink2)
                        .listRowBackground(Fill.card)
                }
                ForEach(spaces) { space in
                    Button {
                        move(to: space)
                    } label: {
                        HStack(spacing: 12) {
                            SpaceGlyph(space: space, size: 20, relativeTo: .body)
                            Text(space.name)
                                .font(.body)
                                .foregroundStyle(Palette.ink)
                            Spacer(minLength: 8)
                            if moving == space.id {
                                ProgressView().controlSize(.small)
                            } else if space.id == row.spaceId {
                                Image(systemName: "checkmark")
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(Palette.accent)
                                    .accessibilityHidden(true)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(space.id == row.spaceId || moving != nil || !model.isConnected)
                    .listRowBackground(Fill.card)
                    .accessibilityAddTraits(space.id == row.spaceId ? .isSelected : [])
                }
            } header: {
                Text("Move “\(row.displayTitle)” to…")
            } footer: {
                Text("A session that has run takes its checkout along, so the transcript still names the tree it ran in.")
            }
        }
    }

    private func move(to space: Space) {
        moving = space.id
        Task {
            await model.moveToSpace(row, to: space)
            dismiss()
        }
    }

    /// The spaces of the profile the session's space is in, in Home's order.
    static func spaces(for row: SessionRow, in home: Home?) -> [Space] {
        let spaces = home?.spaces ?? []
        let profile = spaces.first { $0.id == row.spaceId }?.profileId
        return spaces.filter { $0.profileId == profile }
    }
}

/// Switch agent…: the Mac's agents and, for an agent with logins, which one it runs on, as the desktop's
/// model picker offers both. Another agent asks first, in the picker's words, at the head of the sheet
/// where a long list of agents cannot push it out of sight; a login changes at once.
struct SwitchAgentSheet: View {
    let row: SessionRow
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var asking: AgentOptions?
    @State private var switching = false
    @State private var refusal: String?
    @State private var accounts: SessionAccounts?
    @State private var choosingAccount: String?
    @State private var accountRefusal: String?

    var body: some View {
        let agents = model.agentList?.agents ?? []
        SettingsSheetFrame(title: row.agentDisplayName, kind: row.agent, mark: row.agentMark) {
            if let asking {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Switch to \(asking.name)?")
                            .font(.headline)
                            .foregroundStyle(Palette.ink)
                        Text(note(for: asking))
                            .font(.subheadline)
                            .foregroundStyle(Palette.ink2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .listRowBackground(Fill.card)
                    HStack {
                        Button("Cancel") { self.asking = nil }
                            .disabled(switching)
                        Spacer()
                        Button(switching ? "Switching…" : "Switch") { switchAgent(to: asking) }
                            .fontWeight(.semibold)
                            .foregroundStyle(Palette.accentInk)
                            .disabled(switching || working || !model.isConnected)
                    }
                    .buttonStyle(.borderless)
                    .listRowBackground(Fill.card)
                }
            }
            Section("Agent") {
                ForEach(agents, id: \.kind) { agent in
                    ChoiceRow(title: agent.name, line: agent.available ? nil : agent.note, chosen: agent.kind == row.agent, busy: false) {
                        refusal = nil
                        asking = agent
                    }
                    .disabled(!agent.available || agent.kind == row.agent || switching || !model.isConnected)
                }
            }
            if let accounts, !accounts.accounts.isEmpty {
                Section {
                    ForEach(accounts.accounts) { account in
                        ChoiceRow(title: account.label, line: account.detail, chosen: account.id == accounts.current, busy: choosingAccount == account.id) {
                            choose(account)
                        }
                        .disabled(choosingAccount != nil || switching || !model.isConnected)
                    }
                } header: {
                    Text("Account")
                } footer: {
                    if let accountRefusal { Text(accountRefusal) }
                }
            }
        }
        .task {
            if model.agentList == nil { await model.loadAgents() }
            accounts = try? await model.api?.accounts(id: row.id)
        }
    }

    /// The session's turn is under way, as the Mac's picker reads it before it lets a switch go.
    private var working: Bool {
        (model.store.transcripts[row.id]?.status ?? row.status).isWorking
    }

    private func note(for agent: AgentOptions) -> String {
        if let refusal { return refusal }
        if switching { return "Writing a summary of this conversation for \(agent.name)…" }
        if working { return "\(row.agentDisplayName) is still working. Stop the turn or let it finish, then switch." }
        return "It starts fresh with a summary of this conversation."
    }

    private func switchAgent(to agent: AgentOptions) {
        switching = true
        Task {
            refusal = await model.switchAgent(row, to: agent.kind)
            switching = false
            if refusal == nil { dismiss() }
        }
    }

    private func choose(_ account: SessionAccount) {
        guard account.id != accounts?.current else { return }
        choosingAccount = account.id
        accountRefusal = nil
        Task {
            accountRefusal = await model.setAccount(row, to: account.id)
            if accountRefusal == nil, let before = accounts { accounts = SessionAccounts(accounts: before.accounts, current: account.id) }
            choosingAccount = nil
        }
    }
}

/// Saved: the turns saved in the profile Home shows, the newest saved first, as the desktop's Library ▸
/// Saved lists them. A turn opens its session.
struct SavedView: View {
    @Environment(AppModel.self) private var model
    @State private var saved: SavedTurns?

    var body: some View {
        List {
            if let saved, saved.total > saved.entries.count {
                Text("The \(saved.entries.count) saved most recently, of \(saved.total).")
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink2)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            ForEach(saved?.entries ?? []) { turn in
                Button {
                    model.path.append(.session(turn.sessionId))
                } label: {
                    SavedTurnCard(turn: turn)
                }
                .buttonStyle(.plain)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                .accessibilityHint("Opens \(turn.sessionTitle) at this prompt")
            }
        }
        .listStyle(.plain)
        .listRowSpacing(12)
        .scrollContentBackground(.hidden)
        .background(Ground.transcript)
        .softEdges(ground: Ground.transcript)
        .overlay {
            if let saved, saved.entries.isEmpty {
                ContentUnavailableView("Nothing saved yet", systemImage: "bookmark",
                                       description: Text("Hold a message you sent in a session and choose Save turn."))
            } else if saved == nil {
                Unreached(what: "Saved", working: model.isConnected)
            }
        }
        .navigationTitle("Saved")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: model.channelGeneration) { await load() }
        .refreshable { await load() }
    }

    /// The profile Home shows, or every profile's, newest saved first.
    private func load() async {
        if let turns = await model.savedInChoice() { saved = turns }
    }
}

extension AppModel {
    /// The turns saved in the profile Home shows, or every profile's, newest saved first; nil while the
    /// Mac cannot say.
    func savedInChoice() async -> SavedTurns? {
        guard let api, isConnected else { return nil }
        let profiles = profileChoice.profileId.map { [$0] } ?? (store.home?.profiles?.map(\.id) ?? [])
        var entries: [SavedTurn] = []
        var total = 0
        for profile in profiles {
            guard let turns = try? await api.savedTurns(profileId: profile) else { return nil }
            entries += turns.entries
            total += turns.total
        }
        return SavedTurns(entries: entries.sorted { $0.savedAt > $1.savedAt }, total: total)
    }
}

/// A saved turn as a card: the prompt, the start of its answer, and whose session it was.
private struct SavedTurnCard: View {
    let turn: SavedTurn

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(turn.text.isEmpty ? turn.attachments.joined(separator: ", ") : turn.text)
                .font(.body.weight(.semibold))
                .foregroundStyle(Palette.ink)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let reply = turn.reply {
                Text(reply)
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink2)
                    .lineLimit(3)
            }
            Text("\(turn.sessionTitle) · \(turn.spaceName)")
                .font(.footnote)
                .foregroundStyle(Palette.ink3)
                .lineLimit(1)
                .padding(.top, 4)
        }
        .padding(16)
        .background(Fill.card, in: RoundedRectangle(cornerRadius: Radius.card - 4, style: .continuous))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
