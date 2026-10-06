import RealmKit
import SwiftUI

struct HomeView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            if let problem = model.problem {
                Section {
                    Label(problem, systemImage: "exclamationmark.triangle")
                }
            }
            if case .refused(_, let reason) = model.store.connection {
                Section {
                    Label(reason, systemImage: "xmark.octagon")
                }
            }
            if let home = model.store.home {
                if !home.needsYou.isEmpty {
                    Section("Needs you") {
                        ForEach(home.needsYou) { row in
                            SessionLink(row: row, showsSpace: true)
                        }
                    }
                }
                ForEach(home.spaces) { space in
                    Section(space.name) {
                        if space.sessions.isEmpty {
                            Text("No sessions")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(space.sessions) { row in
                            SessionLink(row: row, showsSpace: false)
                        }
                        if space.more > 0 {
                            Text("\(space.more) more on your Mac")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } else if !model.store.connection.isConnected {
                Section {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text(model.macStatus.text)
                    }
                }
            }
        }
        .navigationTitle(model.store.pairedMac?.macName ?? "Realm")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                MacStatusLabel()
            }
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: Route.diagnostics) {
                    Label("Diagnostics", systemImage: "stopwatch")
                }
            }
        }
        .refreshable { await model.refreshHome() }
    }
}

struct SessionLink: View {
    let row: SessionRow
    let showsSpace: Bool

    var body: some View {
        NavigationLink(value: Route.session(row.id)) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(row.title.isEmpty ? "Untitled session" : row.title)
                        .lineLimit(2)
                    Spacer(minLength: 8)
                    Text(row.status.word)
                        .font(.subheadline)
                        .foregroundStyle(row.needsYou ? .primary : .secondary)
                }
                HStack(spacing: 4) {
                    Text(detail)
                        .lineLimit(1)
                    if row.updatedAt > 0 {
                        Text("·")
                        Text(Date(timeIntervalSince1970: row.updatedAt / 1000), format: .relative(presentation: .named))
                    }
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var detail: String {
        [showsSpace ? row.spaceName : nil, row.agent, row.model]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }
}
