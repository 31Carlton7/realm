import RealmKit
import SwiftUI

struct DiagnosticsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var diagnostics = model.diagnostics
        Form {
            Section {
                Picker("Session", selection: $diagnostics.sessionId) {
                    Text("First idle session").tag(String?.none)
                    ForEach(sessions) { row in
                        Text(row.title.isEmpty ? row.id : row.title).tag(Optional(row.id))
                    }
                }
                Stepper("Echoes: \(diagnostics.echoes)", value: $diagnostics.echoes, in: 1...20)
            } footer: {
                Text("Pings your Mac \(diagnostics.pings) times, opens the session, then sends it \(diagnostics.echoes) short messages and times each one's echo. Use it with a session whose agent you do not mind receiving them.")
            }

            Section("Connection") {
                LabeledContent("Handshake", value: Diagnostics.format(model.store.latency.handshake))
                LabeledContent("Connect", value: Diagnostics.format(model.store.latency.connect))
            }

            Section("Round trip, \(diagnostics.pingSamples.count) pings") {
                LabeledContent("p50", value: Diagnostics.format(diagnostics.pingP50))
                LabeledContent("p95", value: Diagnostics.format(diagnostics.pingP95))
            }

            Section("Session") {
                LabeledContent("First row", value: Diagnostics.format(diagnostics.firstRow))
                LabeledContent("Echo p50", value: Diagnostics.format(diagnostics.eventP50))
                LabeledContent("Echo p95", value: Diagnostics.format(diagnostics.eventP95))
            }

            Section {
                Button(diagnostics.running ? "Running…" : "Run diagnostics") {
                    Task { await diagnostics.run(using: model, sendReport: false) }
                }
                .disabled(diagnostics.running || !model.isConnected)
                .tint(Palette.accentInk)
                Button("Send to Mac") {
                    Task { await diagnostics.send(using: model) }
                }
                .disabled(diagnostics.report == nil || diagnostics.running)
                .tint(Palette.accentInk)
            } footer: {
                if let status = diagnostics.status { Text(status) }
            }

            if !diagnostics.problems.isEmpty {
                Section("Problems") {
                    ForEach(diagnostics.problems, id: \.self) { Text($0) }
                }
            }
        }
        .navigationTitle("Diagnostics")
    }

    private var sessions: [SessionRow] {
        var seen = Set<String>()
        return (model.store.home?.spaces.flatMap(\.sessions) ?? []).filter { seen.insert($0.id).inserted }
    }
}
