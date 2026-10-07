// A connected iPhone's screen, live, as macOS hands it to QuickTime: over the cable, as a capture
// device, at up to 60 frames a second. Realm's phone pane used to show the runner's screenshots, which
// on an iPhone 17 Pro take 773 ms each — one frame a second, and every tap queued behind one. This
// takes the picture off the phone's runner altogether. MEASURED on that phone: 40 fps while it
// scrolled, 32 ms from the phone's frame to this process, and 4.7 ms to make a half-size JPEG.
//
//   phonescreen status
//     One line of JSON: {"camera":"authorized"|"notDetermined"|"denied"|"restricted"}. Never asks:
//     a process with no window cannot show macOS's prompt, so asking is the app's job, not this one's.
//
//   phonescreen stream --name <device name> [--scale 0.5] [--quality 0.6] [--max-fps 30]
//     Frames on stdout, each a 4-byte big-endian length and then a JPEG. A JSON line on stderr when the
//     first frame is out ({"ready":{"width":W,"height":H}}). Exit codes say why there is no picture:
//       3 camera access not asked yet · 4 camera access refused · 2 no such iPhone on a cable
//       5 the capture failed or the phone went away · 64 bad arguments.
//     Ends when stdout closes or on SIGTERM.
//
// macOS counts a connected iPhone's screen as a camera, so this needs the camera grant of the app
// that launched it (Realm), and, under the hardened runtime, the camera entitlement.

import AVFoundation
import CoreImage
import CoreMediaIO
import Foundation

setvbuf(stderr, nil, _IONBF, 0)
signal(SIGPIPE, SIG_IGN)

func fail(_ code: Int32, _ why: String) -> Never {
    FileHandle.standardError.write("{\"error\":\(json(why))}\n".data(using: .utf8)!)
    exit(code)
}

func json(_ s: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: [s], options: [])
    let array = String(data: data, encoding: .utf8)!
    return String(array.dropFirst().dropLast())
}

func cameraState() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: return "authorized"
    case .notDetermined: return "notDetermined"
    case .denied: return "denied"
    case .restricted: return "restricted"
    @unknown default: return "denied"
    }
}

var args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail(64, "usage: phonescreen status | stream --name <device name>") }
args.removeFirst()

if command == "status" {
    print("{\"camera\":\"\(cameraState())\"}")
    exit(0)
}
guard command == "stream" else { fail(64, "unknown command \(command)") }

func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}
guard let name = option("--name"), !name.isEmpty else { fail(64, "stream needs --name <device name>") }
let scale = min(1, max(0.1, Double(option("--scale") ?? "") ?? 0.5))
let quality = min(1, max(0.1, Double(option("--quality") ?? "") ?? 0.6))
let maxFps = min(60, max(1, Double(option("--max-fps") ?? "") ?? 30))

switch cameraState() {
case "authorized": break
case "notDetermined": fail(3, "camera access has not been asked for")
default: fail(4, "camera access is refused")
}

// macOS keeps iOS screens out of the capture devices until a process asks for them.
var address = CMIOObjectPropertyAddress(
    mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
    mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
    mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
var allow: UInt32 = 1
CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &allow)

/// The phone's SCREEN is a muxed device (picture and sound) named as the phone is; its camera, which
/// Continuity Camera also offers, is a video-only device named "<phone> Camera".
func screenDevice() -> AVCaptureDevice? {
    AVCaptureDevice.DiscoverySession(deviceTypes: [.external], mediaType: nil, position: .unspecified).devices
        .first { $0.hasMediaType(.muxed) && $0.localizedName == name }
}

// It appears a moment after the property is set — 0.4 s on an iPhone 17 Pro.
let looking = Date()
var found = screenDevice()
while found == nil && Date().timeIntervalSince(looking) < 6 {
    RunLoop.main.run(until: Date().addingTimeInterval(0.1))
    found = screenDevice()
}
guard let device = found else { fail(2, "no iPhone named \(name) is on a cable to this Mac") }

final class Frames: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let context = CIContext(options: [.cacheIntermediates: false])
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let gap: Double
    var last = 0.0
    var ready = false
    init(gap: Double) { self.gap = gap }

    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        let now = CMClockGetTime(CMClockGetHostTimeClock()).seconds
        // A frame inside the cap is dropped rather than queued: the newest picture is the only one
        // worth sending, and a queue of old ones is latency.
        if now - last < gap { return }
        guard let pixels = CMSampleBufferGetImageBuffer(sample) else { return }
        let image = CIImage(cvPixelBuffer: pixels).transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let options = [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: quality]
        guard let jpeg = context.jpegRepresentation(of: image, colorSpace: space, options: options) else { return }
        last = now
        var length = UInt32(jpeg.count).bigEndian
        var frame = Data(bytes: &length, count: 4)
        frame.append(jpeg)
        do { try FileHandle.standardOutput.write(contentsOf: frame) } catch { exit(0) } // nobody is reading
        if !ready {
            ready = true
            let w = Int(image.extent.width.rounded()), h = Int(image.extent.height.rounded())
            FileHandle.standardError.write("{\"ready\":{\"width\":\(w),\"height\":\(h)}}\n".data(using: .utf8)!)
        }
    }
}

let session = AVCaptureSession()
do {
    let input = try AVCaptureDeviceInput(device: device)
    guard session.canAddInput(input) else { fail(5, "the iPhone's screen could not be opened") }
    session.addInput(input)
} catch {
    fail(5, "the iPhone's screen could not be opened: \(error.localizedDescription)")
}
let output = AVCaptureVideoDataOutput()
output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
output.alwaysDiscardsLateVideoFrames = true
let frames = Frames(gap: 1 / maxFps - 0.002)
output.setSampleBufferDelegate(frames, queue: DispatchQueue(label: "phonescreen.frames"))
guard session.canAddOutput(output) else { fail(5, "the iPhone's screen could not be read") }
session.addOutput(output)

let center = NotificationCenter.default
center.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { note in
    let error = note.userInfo?[AVCaptureSessionErrorKey] as? Error
    fail(5, "the capture stopped: \(error?.localizedDescription ?? "unknown error")")
}
center.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: device, queue: nil) { _ in
    fail(5, "the iPhone was disconnected")
}
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGTERM, SIG_IGN)
term.setEventHandler { session.stopRunning(); exit(0) }
term.resume()

session.startRunning()
RunLoop.main.run()
