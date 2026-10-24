import RealmKit
import SwiftUI
import UserNotifications

/// Where Settings goes from inside its own sheet.
enum SettingsRoute: Hashable {
    case diagnostics
    case licences
}

/// Settings, in a sheet over Home: the paired Mac, notifications, and the app itself. Done puts it
/// away; nothing here needs saving.
struct SettingsSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SettingsView()
                .navigationDestination(for: SettingsRoute.self) { route in
                    switch route {
                    case .diagnostics: DiagnosticsView()
                    case .licences: LicencesView()
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
    }
}

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmingForget = false
    @AppStorage(ListOptions.Key.style) private var style = ListOptions().style
    @AppStorage(ListOptions.Key.spaceOrder) private var spaceOrder = ListOptions().spaceOrder
    @AppStorage(ListOptions.Key.needsYouFirst) private var needsYouFirst = ListOptions().needsYouFirst

    var body: some View {
        Form {
            if let mac = model.store.pairedMac {
                Section {
                    MacHeader(name: mac.macName, status: model.linkStatus)
                        .listRowBackground(Fill.card)
                    LabeledContent("Relay") {
                        Text(mac.relay.host() ?? mac.relay.absoluteString)
                            .mono(.subheadline)
                            .foregroundStyle(Palette.ink2)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .listRowBackground(Fill.card)
                    LabeledContent("Paired") {
                        Text(mac.pairedAt.formatted(date: .abbreviated, time: .shortened))
                            .foregroundStyle(Palette.ink2)
                    }
                    .listRowBackground(Fill.card)
                }
                Section {
                    Button("Forget \(mac.macName)…", role: .destructive) { confirmingForget = true }
                        .listRowBackground(Fill.card)
                } footer: {
                    Text("Forgets it on this iPhone only. Your Mac lists this iPhone until you remove it in Settings ▸ Devices there.")
                }
            }

            Section {
                Picker("List", selection: $style) {
                    ForEach(ListStyle.allCases) { style in
                        Text(style.title).tag(style)
                    }
                }
                .modifier(ChoiceStyle())
                .listRowBackground(Fill.card)
                if style == .bySpace {
                    Picker("Order spaces", selection: $spaceOrder) {
                        ForEach(SpaceOrder.allCases) { order in
                            Text(order.title).tag(order)
                        }
                    }
                    .modifier(ChoiceStyle())
                    .listRowBackground(Fill.card)
                }
                Toggle("Needs you first", isOn: $needsYouFirst)
                    .tint(Palette.accent)
                    .listRowBackground(Fill.card)
            } header: {
                Text("Session list")
            } footer: {
                Text(style.explanation)
            }

            Section {
                LabeledContent("Notifications") {
                    Text(notificationWords)
                        .foregroundStyle(Palette.ink2)
                }
                .listRowBackground(Fill.card)
                switch model.notificationStatus {
                case .notDetermined:
                    Button("Allow notifications") { model.registerForPushes() }
                        .tint(Palette.accentInk)
                        .listRowBackground(Fill.card)
                case .denied:
                    Button("Turn them on in Settings") {
                        if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                    }
                    .tint(Palette.accentInk)
                    .listRowBackground(Fill.card)
                default:
                    EmptyView()
                }
            } footer: {
                Text("Your Mac sends one when a session waits on you, finishes or fails, and holds it back while you are at the Mac.")
            }

            Section {
                LabeledContent("Version") {
                    Text(DeviceInfo.appVersion)
                        .monospacedDigit()
                        .foregroundStyle(Palette.ink2)
                }
                .listRowBackground(Fill.card)
                NavigationLink("Fonts", value: SettingsRoute.licences)
                    .listRowBackground(Fill.card)
                NavigationLink("Diagnostics", value: SettingsRoute.diagnostics)
                    .listRowBackground(Fill.card)
            } header: {
                Text("About")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Ground.grouped)
        .contentMargins(.top, 12, for: .scrollContent)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
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
}

/// A choice on a row of its own, its value in a menu; at the accessibility sizes, where that value
/// is cut short on one line, its options are rows of their own.
private struct ChoiceStyle: ViewModifier {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    func body(content: Content) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            content.pickerStyle(.inline)
        } else {
            content.pickerStyle(.menu)
        }
    }
}

/// The Mac this iPhone shows, as the head of its own group: its name, and its state in words with the
/// glyph that says it.
private struct MacHeader: View {
    let name: String
    let status: LinkStatus
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        // At the accessibility sizes the glyph goes above the words, which keep the row's width: beside
        // it, "Connected" was hyphenated.
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(spacing: 14))
        layout {
            Image(systemName: "laptopcomputer")
                .font(.system(size: 30, weight: .regular))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(Palette.accent)
                .frame(width: dynamicTypeSize.isAccessibilitySize ? nil : 48)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(name)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                // Not a Label: a list sets a label's glyph in a column of its own, and starts its
                // separator there.
                HStack(spacing: 5) {
                    Image(systemName: status.symbol)
                        .foregroundStyle(status.isConnected ? Palette.green : Palette.ink2)
                    Text(status.words)
                        .foregroundStyle(Palette.ink2)
                }
                .font(.subheadline)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}

/// The family the app bundles, and the licence it comes under.
struct LicencesView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("JetBrains Mono")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .accessibilityAddTraits(.isHeader)
                Text("Code, paths and models are set in it.")
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink2)
                Text(Self.text("JetBrainsMono-OFL"))
                    .mono(.caption)
                    .foregroundStyle(Palette.ink2)
                    .textSelection(.enabled)
            }
            .padding(20)
        }
        .background(Ground.grouped)
        .navigationTitle("Fonts")
        .navigationBarTitleDisplayMode(.inline)
    }

    static func text(_ file: String) -> String {
        guard let url = Bundle.main.url(forResource: file, withExtension: "txt"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return "SIL Open Font License, Version 1.1" }
        return text
    }
}
