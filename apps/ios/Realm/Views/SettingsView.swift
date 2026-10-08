import RealmKit
import SwiftUI
import UserNotifications

/// The paired Mac, notifications, and the app itself.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmingForget = false

    var body: some View {
        Form {
            if let mac = model.store.pairedMac {
                Section {
                    value("Name", mac.macName)
                    LabeledContent("State") {
                        Label(model.linkStatus.words, systemImage: model.linkStatus.symbol)
                            .labelStyle(.titleAndIcon)
                            .inter(.body)
                            .foregroundStyle(Palette.ink2)
                    }
                    .inter(.body)
                    .listRowBackground(Palette.surface)
                    LabeledContent("Relay") {
                        Text(mac.relay.host() ?? mac.relay.absoluteString)
                            .mono(.subheadline)
                            .foregroundStyle(Palette.ink2)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .inter(.body)
                    .listRowBackground(Palette.surface)
                    value("Paired", mac.pairedAt.formatted(date: .abbreviated, time: .shortened))
                } header: {
                    SectionHead(title: "Mac", symbol: "laptopcomputer")
                }
                Section {
                    Button("Forget \(mac.macName)", role: .destructive) { confirmingForget = true }
                        .inter(.body, .medium)
                        .listRowBackground(Palette.surface)
                } footer: {
                    Text("Forgets it on this iPhone only. Your Mac lists this iPhone until you remove it in Settings ▸ Devices there.")
                        .inter(.footnote)
                        .foregroundStyle(Palette.ink2)
                }
            }

            Section {
                LabeledContent("Notifications") {
                    Text(notificationWords)
                        .inter(.body)
                        .foregroundStyle(Palette.ink2)
                }
                .inter(.body)
                .listRowBackground(Palette.surface)
                switch model.notificationStatus {
                case .notDetermined:
                    Button("Allow notifications") { model.registerForPushes() }
                        .inter(.body, .medium)
                        .listRowBackground(Palette.surface)
                case .denied:
                    Button("Turn them on in Settings") {
                        if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                    }
                    .inter(.body, .medium)
                    .listRowBackground(Palette.surface)
                default:
                    EmptyView()
                }
            } header: {
                SectionHead(title: "Notifications", symbol: "bell")
            } footer: {
                Text("Your Mac sends one when a session waits on you, finishes or fails, and holds it back while you are at the Mac.")
                    .inter(.footnote)
                    .foregroundStyle(Palette.ink2)
            }

            Section {
                value("Version", DeviceInfo.appVersion)
                NavigationLink(value: Route.licences) {
                    Text("Fonts")
                        .inter(.body)
                }
                .listRowBackground(Palette.surface)
                NavigationLink(value: Route.diagnostics) {
                    Text("Diagnostics")
                        .inter(.body)
                }
                .listRowBackground(Palette.surface)
            } header: {
                SectionHead(title: "About", symbol: "info.circle")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Palette.page)
        .navigationTitle("Settings")
        .task { await model.refreshNotificationStatus() }
        .confirmationDialog("Forget \(model.store.pairedMac?.macName ?? "this Mac")?", isPresented: $confirmingForget,
                            titleVisibility: .visible) {
            Button("Forget \(model.store.pairedMac?.macName ?? "this Mac")", role: .destructive) { model.forgetMac() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This iPhone stops showing its sessions and deletes what it kept of them. To pair again, scan a new code.")
        }
    }

    private var notificationWords: String {
        switch model.notificationStatus {
        case .authorized: "Allowed"
        case .provisional: "Delivered quietly"
        case .ephemeral: "Allowed for now"
        case .denied: "Off"
        case .notDetermined: "Not asked yet"
        @unknown default: "Unknown"
        }
    }

    private func value(_ label: String, _ value: String) -> some View {
        LabeledContent(label) {
            Text(value)
                .inter(.body)
                .foregroundStyle(Palette.ink2)
        }
        .inter(.body)
        .listRowBackground(Palette.surface)
    }
}

/// The two families the app is set in, and the licence each comes under.
struct LicencesView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                licence("Inter", file: "Inter-OFL")
                licence("JetBrains Mono", file: "JetBrainsMono-OFL")
            }
            .padding(16)
        }
        .background(Palette.page)
        .navigationTitle("Fonts")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func licence(_ name: String, file: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(name)
                .inter(.title3, .title)
                .foregroundStyle(Palette.ink)
                .accessibilityAddTraits(.isHeader)
            Text(Self.text(file))
                .mono(.caption1)
                .foregroundStyle(Palette.ink2)
                .textSelection(.enabled)
        }
    }

    static func text(_ file: String) -> String {
        guard let url = Bundle.main.url(forResource: file, withExtension: "txt"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return "SIL Open Font License, Version 1.1" }
        return text
    }
}
