import AVFoundation
import RealmKit
import SwiftUI
import VisionKit

/// Pairing: scan the code the Mac shows, or paste its link. The Mac asks its owner before this iPhone
/// sees anything, and this screen says so while it waits. Plain, as a first run is: the mark, what
/// Realm is, the steps — the first of them saying where Realm for Mac comes from, for someone who has
/// none yet — and the one action, live from the first frame below the scroller.
struct PairView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var scanning = false
    @State private var pasting = false
    @State private var cameraProblem: String?
    @State private var cameraSettings = false
    /// Shown as a sheet over a paired Mac's sessions, rather than as the whole app.
    var overTheTop = false

    var body: some View {
        Group {
            switch model.pairing {
            case .working(let text):
                PairingProgress(text: text)
            case .confirmOnMac(let macName):
                ConfirmOnMac(macName: macName)
            case .idle, .failed:
                welcome
            }
        }
        .background(Ground.grouped)
        .animation(Motion.spring, value: model.pairing)
        .toolbar {
            if overTheTop {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(model.pairing.isBusy)
                }
            }
        }
        .fullScreenCover(isPresented: $scanning) {
            ScannerScreen { text in
                scanning = false
                model.open(pairingText: text)
            }
        }
        .sheet(isPresented: $pasting) {
            PasteLinkSheet()
        }
    }

    private var welcome: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 18) {
                    Image("RealmMarkShaded")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 56, height: 67)
                        .accessibilityHidden(true)
                    Text("Pair with your Mac")
                        .font(.largeTitle.bold())
                        .foregroundStyle(Palette.ink)
                        .accessibilityAddTraits(.isHeader)
                    Text("Realm runs your coding agents on your Mac. Pair this iPhone with it to see what they're doing, answer what they wait on, and send the next message.")
                        .font(.body)
                        .foregroundStyle(Palette.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                VStack(alignment: .leading, spacing: 16) {
                    // Over a paired Mac, Realm is already there.
                    Step(number: 1, text: overTheTop ? "Open Realm on your Mac."
                                                     : "Open Realm on your Mac. New to Realm? It's free at **[realm.computer](https://realm.computer)**.")
                    // The arrow is held to the word before it, so no line starts with it, and the button's
                    // name is held whole.
                    Step(number: 2, text: "In Settings\u{00A0}▸ Devices, choose Pair\u{00A0}an\u{00A0}iPhone.")
                    Step(number: 3, text: "Scan the code it shows.")
                }
                if case .failed(let message) = model.pairing {
                    Label {
                        Text(message)
                            .foregroundStyle(Palette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(Palette.red)
                    }
                    .font(.subheadline.weight(.medium))
                    .padding(Radius.cardPadding)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .surface()
                    .transition(.opacity)
                }
                if let cameraProblem {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(cameraProblem)
                            .font(.subheadline)
                            .foregroundStyle(Palette.ink2)
                            .fixedSize(horizontal: false, vertical: true)
                        if cameraSettings {
                            Button("Open Settings") {
                                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                            }
                            .buttonStyle(.bordered)
                            .buttonBorderShape(.capsule)
                        }
                    }
                }
                if dynamicTypeSize.isAccessibilitySize {
                    actions
                        .padding(.horizontal, -24)
                }
            }
            .padding(.horizontal, 24)
            .padding(.top, 32)
            .padding(.bottom, 24)
            .frame(maxWidth: 540, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        // At the accessibility sizes the actions are most of a screen: pinned, they would cover the
        // title and the steps for good, so there they scroll with the rest.
        .safeAreaBar(edge: .bottom) {
            if !dynamicTypeSize.isAccessibilitySize { actions }
        }
    }

    /// Scan, Paste, and what pairing promises: the one action, live from the first frame.
    private var actions: some View {
        VStack(spacing: 12) {
            Button {
                startScanning()
            } label: {
                Label("Scan the code", systemImage: "qrcode.viewfinder")
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(Palette.accentFill)
            .accessibilityIdentifier("scan")
            Button("Paste the link") { pasting = true }
                .font(.body.weight(.semibold))
                .buttonStyle(.borderless)
                .tint(Palette.accentInk)
                .frame(minHeight: 44)
            Text("The code is good for five minutes, and your Mac asks you to confirm before this iPhone can see anything.")
                .font(.footnote)
                .foregroundStyle(Palette.ink2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .controlSize(.large)
        .buttonBorderShape(.capsule)
        .padding(.horizontal, 24)
        .padding(.top, 12)
        .padding(.bottom, 8)
        .frame(maxWidth: 540)
        .disabled(model.pairing.isBusy)
    }

    private func startScanning() {
        cameraProblem = nil
        cameraSettings = false
        guard DataScannerViewController.isSupported else {
            cameraProblem = "This iPhone cannot scan codes here. Paste the link instead."
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            open()
        case .notDetermined:
            Task {
                if await AVCaptureDevice.requestAccess(for: .video) {
                    open()
                } else {
                    deniedCamera()
                }
            }
        default:
            deniedCamera()
        }
    }

    private func open() {
        if DataScannerViewController.isAvailable {
            scanning = true
        } else {
            cameraProblem = "The camera is not available right now. Paste the link instead."
        }
    }

    private func deniedCamera() {
        cameraProblem = "Realm is not allowed to use the camera. Allow it in Settings, or paste the link."
        cameraSettings = true
    }
}

/// A numbered step, the number in the accent as Apple's own setup screens draw it. Its words are
/// Markdown, so a step can carry a link, drawn in the accent as a link is.
private struct Step: View {
    let number: Int
    let text: LocalizedStringKey
    @ScaledMetric(relativeTo: .body) private var disc: CGFloat = 28

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            Text("\(number)")
                .font(.subheadline.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(Palette.accentInk)
                .frame(width: disc, height: disc)
                .background(Palette.accentTint, in: Circle())
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 6 }
            Text(text)
                .font(.body)
                .foregroundStyle(Palette.ink)
                .tint(Palette.accentInk)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}

/// On its way to the Mac.
private struct PairingProgress: View {
    let text: String

    var body: some View {
        VStack(spacing: 16) {
            ProgressView()
                .controlSize(.large)
            Text(text)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Palette.ink)
                .multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// The Mac asks its owner first. Nothing here moves on its own: the next step is at the Mac.
private struct ConfirmOnMac: View {
    let macName: String
    @State private var arrived = false

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "laptopcomputer.and.iphone")
                .font(.system(size: 64, weight: .light))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(Palette.accent)
                .symbolEffect(.bounce, value: arrived)
                .accessibilityHidden(true)
            Text("Confirm on your Mac")
                .font(.title2.bold())
                .foregroundStyle(Palette.ink)
                .accessibilityAddTraits(.isHeader)
            Text("\(macName) is asking whether to pair with this iPhone. Choose Pair there.")
                .font(.body)
                .foregroundStyle(Palette.ink2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            ProgressView()
                .padding(.top, 6)
        }
        .padding(32)
        .frame(maxWidth: 480)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .onAppear { arrived = true }
    }
}

/// The link, pasted: the system's Paste reads it without asking, and a field takes it typed.
private struct PasteLinkSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var link = ""
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://realm.computer/pair#1.…", text: $link, axis: .vertical)
                        .tint(Palette.accent)
                        .lineLimit(1...4)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .focused($focused)
                        .listRowBackground(Fill.card)
                        .accessibilityLabel("Pairing link")
                } footer: {
                    Text("The link your Mac shows under the code, in Settings ▸ Devices.")
                }
                Section {
                    PasteButton(payloadType: String.self) { strings in
                        guard let text = strings.first else { return }
                        link = text
                        pair()
                    }
                    .labelStyle(.titleAndIcon)
                    .buttonBorderShape(.capsule)
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Ground.grouped)
            .navigationTitle("Paste the link")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Pair", action: pair)
                        .disabled(link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func pair() {
        model.open(pairingText: link.trimmingCharacters(in: .whitespacesAndNewlines))
        dismiss()
    }
}

/// The camera, full screen, until it reads a Realm pairing code. What it says floats over the picture
/// on glass, as the system's camera controls do.
struct ScannerScreen: View {
    let onCode: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var notOurs = false

    var body: some View {
        ZStack(alignment: .bottom) {
            QRScanner { text in
                if (try? PairingLink.decode(text)) != nil {
                    onCode(text)
                    return true
                }
                notOurs = true
                return false
            }
            .ignoresSafeArea()
            GlassEffectContainer(spacing: 12) {
                VStack(spacing: 12) {
                    Label(notOurs ? "That code is not a Realm pairing code." : "Point the camera at the code on your Mac.",
                          systemImage: notOurs ? "exclamationmark.triangle.fill" : "qrcode.viewfinder")
                        .font(.body.weight(.medium))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 14)
                        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: Radius.composer, style: .continuous))
                        .contentTransition(.opacity)
                    Button("Cancel") { dismiss() }
                        .font(.body.weight(.semibold))
                        .buttonStyle(.glass)
                        .buttonBorderShape(.capsule)
                        .controlSize(.large)
                }
            }
            .padding(20)
        }
    }
}

/// VisionKit's scanner, reading QR codes only. `onPayload` says whether to stop.
struct QRScanner: UIViewControllerRepresentable {
    let onPayload: @MainActor (String) -> Bool

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
                                                recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false,
                                                isPinchToZoomEnabled: true, isGuidanceEnabled: true, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        if !scanner.isScanning, !context.coordinator.done { try? scanner.startScanning() }
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onPayload: onPayload)
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onPayload: @MainActor (String) -> Bool
        var done = false

        init(onPayload: @escaping @MainActor (String) -> Bool) {
            self.onPayload = onPayload
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !done else { return }
            for item in addedItems {
                guard case .barcode(let code) = item, let text = code.payloadStringValue else { continue }
                if onPayload(text) {
                    done = true
                    dataScanner.stopScanning()
                    return
                }
            }
        }
    }
}
