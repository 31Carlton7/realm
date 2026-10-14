import AVFoundation
import RealmKit
import SwiftUI
import VisionKit

/// Pairing: scan the code the Mac shows, or paste its link. The Mac asks its owner before this
/// iPhone sees anything, and this screen says so while it waits.
struct PairView: View {
    @Environment(AppModel.self) private var model
    @State private var link = ""
    @State private var scanning = false
    @State private var cameraProblem: String?
    @State private var cameraSettings = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("On your Mac, open Realm's Settings ▸ Devices and choose Pair an iPhone. Then scan the code it shows.")
                        .inter(.body)
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("The code is good for five minutes, and your Mac asks you to confirm before this iPhone can see anything.")
                        .inter(.subheadline)
                        .foregroundStyle(Palette.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }

                PairingStatusView()

                VStack(alignment: .leading, spacing: 10) {
                    Button {
                        startScanning()
                    } label: {
                        Label("Scan the code", systemImage: "qrcode.viewfinder")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(RealmButtonStyle(primary: true))
                    .disabled(model.pairing.isBusy)
                    if let cameraProblem {
                        Text(cameraProblem)
                            .inter(.subheadline)
                            .foregroundStyle(Palette.ink2)
                            .fixedSize(horizontal: false, vertical: true)
                        if cameraSettings {
                            Button("Open Settings") {
                                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                            }
                            .buttonStyle(RealmButtonStyle(primary: false))
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("Or paste the link")
                        .inter(.footnote, .medium)
                        .foregroundStyle(Palette.ink2)
                        .accessibilityAddTraits(.isHeader)
                    TextField("https://realm.computer/pair#1.…", text: $link, axis: .vertical)
                        .inter(.body)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1...4)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 11)
                        .frame(minHeight: 44)
                        .surface(Palette.surface, radius: Radius.card)
                        .accessibilityLabel("Pairing link")
                    Button("Pair") { model.open(pairingText: link) }
                        .buttonStyle(RealmButtonStyle(primary: false))
                        .disabled(link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.pairing.isBusy)
                }
            }
            .padding(20)
        }
        .background(Palette.page)
        .navigationTitle("Pair with your Mac")
        .fullScreenCover(isPresented: $scanning) {
            ScannerScreen { text in
                scanning = false
                model.open(pairingText: text)
            }
        }
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

/// Where pairing is: on its way, waiting for the owner at the Mac, or what went wrong.
struct PairingStatusView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.pairing {
        case .idle:
            EmptyView()
        case .working(let text):
            HStack(spacing: 12) {
                ProgressView()
                Text(text)
                    .inter(.body, .medium)
                    .foregroundStyle(Palette.ink)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .surface()
        case .confirmOnMac(let macName):
            VStack(alignment: .leading, spacing: 8) {
                Label("Confirm on your Mac", systemImage: "laptopcomputer")
                    .inter(.title3, .title)
                    .foregroundStyle(Palette.ink)
                Text("\(macName) is asking whether to pair with this iPhone. Choose Pair there.")
                    .inter(.body)
                    .foregroundStyle(Palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .surface()
            .accessibilityElement(children: .combine)
        case .failed(let message):
            Label {
                Text(message)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "exclamationmark.triangle")
                    .foregroundStyle(Palette.red)
            }
            .inter(.body, .medium)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .surface()
        }
    }
}

/// The camera, full screen, until it reads a Realm pairing code.
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
            VStack(spacing: 12) {
                Text(notOurs ? "That code is not a Realm pairing code." : "Point the camera at the code on your Mac.")
                    .inter(.body, .medium)
                    .foregroundStyle(Palette.ink)
                    .multilineTextAlignment(.center)
                Button("Cancel") { dismiss() }
                    .buttonStyle(RealmButtonStyle(primary: false))
            }
            .padding(16)
            .frame(maxWidth: .infinity)
            .surface(Palette.surface, radius: Radius.sheet)
            .padding(16)
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
