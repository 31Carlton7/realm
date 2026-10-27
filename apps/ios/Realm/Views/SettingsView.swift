import RealmKit
import SwiftUI
import UserNotifications

/// Where Settings goes from inside its own sheet.
enum SettingsRoute: Hashable {
    case diagnostics
    case licences
}

/// Settings, in a sheet over Home, as Manus keeps its profile: the paired Mac at the head, the Mac's
/// pages, then how the list is laid out, notifications and the app itself, each a row with its
/// glyph. Done puts it away; nothing here needs saving.
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
                    // Manus's close, at the trailing corner.
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Close", systemImage: "xmark") { dismiss() }
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
                        .profileRow()
                }
                // The Mac's link on a card of its own, as Manus puts the plan under the profile.
                Section {
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
            }

            // The Mac's pages beyond Home, which the bar's menu used to offer.
            if !model.work.unsupported {
                Section {
                    ForEach(WorkPage.allCases, id: \.self) { page in
                        Button {
                            model.settingsShown = false
                            model.path.append(page.route)
                        } label: {
                            LabeledContent {
                                HStack(spacing: 6) {
                                    if let note = page.note(reviews: model.work.reviews, schedules: model.work.schedules) {
                                        Text(note)
                                    }
                                    Image(systemName: "chevron.right")
                                        .font(.footnote.weight(.semibold))
                                        .foregroundStyle(Palette.ink3)
                                }
                                .foregroundStyle(Palette.ink2)
                            } label: {
                                Label(page.title, systemImage: page.symbol)
                                    .foregroundStyle(Palette.ink)
                            }
                        }
                        .profileRow()
                    }
                } header: {
                    Text("Realm")
                }
            }

            Section {
                Picker(selection: $style) {
                    ForEach(ListStyle.allCases) { style in
                        Text(style.title).tag(style)
                    }
                } label: {
                    Label("List", systemImage: "list.bullet")
                }
                .modifier(ChoiceStyle())
                .profileRow()
                if style == .bySpace {
                    Picker(selection: $spaceOrder) {
                        ForEach(SpaceOrder.allCases) { order in
                            Text(order.title).tag(order)
                        }
                    } label: {
                        Label("Order spaces", systemImage: "arrow.up.arrow.down")
                    }
                    .modifier(ChoiceStyle())
                    .profileRow()
                }
                Toggle(isOn: $needsYouFirst) {
                    Label("Needs you first", systemImage: "hand.raised")
                }
                .tint(Palette.accent)
                .profileRow()
            } header: {
                Text("Session list")
            } footer: {
                Text(style.explanation)
            }

            Section {
                LabeledContent {
                    Text(notificationWords)
                        .foregroundStyle(Palette.ink2)
                } label: {
                    Label("Notifications", systemImage: "bell")
                }
                .profileRow()
                switch model.notificationStatus {
                case .notDetermined:
                    Button("Allow notifications") { model.registerForPushes() }
                        .tint(Palette.accentInk)
                        .profileRow()
                case .denied:
                    Button("Turn them on in Settings") {
                        if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                    }
                    .tint(Palette.accentInk)
                    .profileRow()
                default:
                    EmptyView()
                }
            } header: {
                Text("General")
            } footer: {
                Text("Your Mac sends one when a session waits on you, finishes or fails, and holds it back while you are at the Mac.")
            }

            Section {
                NavigationLink(value: SettingsRoute.licences) {
                    Label("Fonts", systemImage: "textformat")
                }
                .profileRow()
                NavigationLink(value: SettingsRoute.diagnostics) {
                    Label("Diagnostics", systemImage: "stethoscope")
                }
                .profileRow()
                if let mac = model.store.pairedMac {
                    Button(role: .destructive) {
                        confirmingForget = true
                    } label: {
                        Label("Forget \(mac.macName)…", systemImage: "minus.circle")
                            .foregroundStyle(Palette.red)
                    }
                    .profileRow()
                }
            } header: {
                Text("Other")
            } footer: {
                // The version at the foot, as Manus signs its own.
                VStack(spacing: 10) {
                    if model.store.pairedMac != nil {
                        Text("Forgets it on this iPhone only. Your Mac lists this iPhone until you remove it in Settings ▸ Devices there.")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Text("Realm \(DeviceInfo.appVersion)")
                        .monospacedDigit()
                        .frame(maxWidth: .infinity)
                        .padding(.top, 12)
                }
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

extension View {
    /// A row of the profile sheet as Manus draws one: on the sheet's own ground, no card and no line,
    /// its glyph and its words starting together.
    func profileRow() -> some View {
        listRowBackground(Color.clear).listRowSeparator(.hidden)
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
            // A round avatar, as Manus heads its profile with the person's.
            Image(systemName: "laptopcomputer")
                .font(.system(size: 24, weight: .medium))
                .foregroundStyle(.white)
                .frame(width: 56, height: 56)
                .background(Palette.accentFill, in: Circle())
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
