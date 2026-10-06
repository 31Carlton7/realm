import RealmKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.path) {
            Group {
                if model.store.pairedMac == nil {
                    PairView()
                } else {
                    HomeView()
                }
            }
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .session(let id): SessionView(sessionId: id)
                case .diagnostics: DiagnosticsView()
                }
            }
        }
    }
}

struct PairView: View {
    @Environment(AppModel.self) private var model
    @State private var link = ""

    var body: some View {
        Form {
            Section {
                TextField("https://realm.computer/pair#1.…", text: $link, axis: .vertical)
                    .lineLimit(2...6)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .accessibilityLabel("Pairing link")
                Button("Pair") {
                    Task { await model.pair(with: link) }
                }
                .disabled(link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.pairing.isBusy)
            } header: {
                Text("Pairing link")
            } footer: {
                Text("Paste the link your Mac shows for pairing. The link is good for a few minutes.")
            }

            switch model.pairing {
            case .idle:
                EmptyView()
            case .working(let text):
                Section {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text(text)
                    }
                }
            case .confirmOnMac(let macName):
                Section {
                    Label("Confirm on your Mac", systemImage: "laptopcomputer")
                        .font(.headline)
                    Text("\(macName) is asking whether to pair with this iPhone.")
                        .foregroundStyle(.secondary)
                }
            case .failed(let message):
                Section {
                    Label(message, systemImage: "exclamationmark.triangle")
                }
            }
        }
        .navigationTitle("Pair with your Mac")
    }
}

struct MacStatusLabel: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let status = model.macStatus
        Label(status.text, systemImage: status.symbol)
            .labelStyle(.titleAndIcon)
            .font(.subheadline)
            .fixedSize()
            .accessibilityLabel("Mac: \(status.text)")
    }
}
