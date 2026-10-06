// Writes a QR code PNG for a pairing link: `swift qr.swift <text> <out.png>`.
// Plan 28 Phase 1 only — the sidecar shows it so a real iPhone can scan the link. CoreImage draws it,
// so the spike adds no dependency; Phase 2 draws the code in Settings ▸ Devices instead.
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count == 3, let data = args[1].data(using: .utf8) else {
  FileHandle.standardError.write("usage: swift qr.swift <text> <out.png>\n".data(using: .utf8)!)
  exit(64)
}
let filter = CIFilter(name: "CIQRCodeGenerator")!
filter.setValue(data, forKey: "inputMessage")
filter.setValue("M", forKey: "inputCorrectionLevel")
let image = filter.outputImage!.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
let context = CIContext()
guard let cg = context.createCGImage(image, from: image.extent),
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, UTType.png.identifier as CFString, 1, nil) else { exit(1) }
CGImageDestinationAddImage(dest, cg, nil)
exit(CGImageDestinationFinalize(dest) ? 0 : 1)
