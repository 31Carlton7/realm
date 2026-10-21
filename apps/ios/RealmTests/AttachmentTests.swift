import ImageIO
import RealmKit
import Testing
import UIKit
import UniformTypeIdentifiers
@testable import Realm

/// Pictures made in memory, encoded as a camera or the library would hand them over.
enum Pictures {
    static func image(width: Int, height: Int) -> CGImage {
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        context.setFillColor(UIColor.systemTeal.cgColor)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.setFillColor(UIColor.systemOrange.cgColor)
        context.fill(CGRect(x: 0, y: 0, width: width / 2, height: height / 3))
        return context.makeImage()!
    }

    /// `properties` as a file's metadata: where it was taken, which way up it is.
    static func encoded(_ image: CGImage, as type: UTType, properties: [CFString: Any] = [:]) -> Data {
        let data = NSMutableData()
        let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        CGImageDestinationFinalize(destination)
        return data as Data
    }

    static func size(of data: Data) -> CGSize? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int
        else { return nil }
        return CGSize(width: width, height: height)
    }

    static func properties(of data: Data) -> [CFString: Any] {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return [:] }
        return CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
    }

    static func isJPEG(_ data: Data) -> Bool { data.prefix(3) == Data([0xFF, 0xD8, 0xFF]) }
}

@Suite("A photo, made ready for the Mac")
struct PhotoPrepTests {
    /// A big photo comes down to 2048 pixels on its long edge, its shape kept, as a JPEG.
    @Test func aBigPhotoComesDownTo2048OnItsLongEdge() throws {
        let jpeg = try #require(PhotoPrep.jpeg(Pictures.encoded(Pictures.image(width: 4_032, height: 3_024), as: .png)))
        #expect(Pictures.isJPEG(jpeg))
        #expect(Pictures.size(of: jpeg) == CGSize(width: 2_048, height: 1_536))
    }

    /// A small one is never made bigger.
    @Test func aSmallPhotoKeepsItsSize() throws {
        let jpeg = try #require(PhotoPrep.jpeg(Pictures.encoded(Pictures.image(width: 1_000, height: 500), as: .png)))
        #expect(Pictures.size(of: jpeg) == CGSize(width: 1_000, height: 500))
    }

    /// Where it was taken does not go with it, and a photo taken on its side arrives upright.
    @Test func whereItWasTakenStaysOnThePhone() throws {
        let gps: [CFString: Any] = [kCGImagePropertyGPSLatitude: 51.5, kCGImagePropertyGPSLatitudeRef: "N",
                                    kCGImagePropertyGPSLongitude: 0.12, kCGImagePropertyGPSLongitudeRef: "W"]
        let original = Pictures.encoded(Pictures.image(width: 400, height: 200), as: .jpeg,
                                        properties: [kCGImagePropertyGPSDictionary: gps, kCGImagePropertyOrientation: 6])
        #expect(Pictures.properties(of: original)[kCGImagePropertyGPSDictionary] != nil, "the original says where it was taken")
        let jpeg = try #require(PhotoPrep.jpeg(original))
        #expect(Pictures.properties(of: jpeg)[kCGImagePropertyGPSDictionary] == nil)
        #expect(Pictures.size(of: jpeg) == CGSize(width: 200, height: 400))
        #expect((Pictures.properties(of: jpeg)[kCGImagePropertyOrientation] as? Int ?? 1) == 1)
    }

    /// The camera's picture, held on its side, is drawn upright at the same size.
    @Test func aCameraPhotoIsDrawnUprightAndSmaller() throws {
        let image = UIImage(cgImage: Pictures.image(width: 4_000, height: 3_000), scale: 1, orientation: .right)
        let jpeg = try #require(PhotoPrep.jpeg(image))
        #expect(Pictures.isJPEG(jpeg))
        #expect(Pictures.size(of: jpeg) == CGSize(width: 1_536, height: 2_048))
    }

    @Test func bytesThatAreNotAPictureAreNotOne() {
        #expect(PhotoPrep.jpeg(Data("%PDF-1.7".utf8)) == nil)
    }
}

@Suite("A file, made ready for the Mac")
struct FilePrepTests {
    @Test func aFilesKindIsReadFromItsName() {
        #expect(FilePrep.mime(of: "notes.pdf") == "application/pdf")
        #expect(FilePrep.mime(of: "IMG_0412.HEIC") == "image/heic")
        #expect(FilePrep.mime(of: "Makefile") == "application/octet-stream")
    }

    /// A file goes as it is, unless it is a picture an agent cannot take inline: that goes as a JPEG.
    @Test func onlyAPictureTheMacWouldRefuseIsMadeAJPEG() throws {
        let png = Pictures.encoded(Pictures.image(width: 300, height: 200), as: .png)
        let kept = FilePrep.prepared(png, name: "chart.png")
        #expect(kept.data == png && kept.name == "chart.png" && kept.mime == "image/png")
        let pdf = Data("%PDF-1.7".utf8)
        #expect(FilePrep.prepared(pdf, name: "notes.pdf").data == pdf)
        let tiff = FilePrep.prepared(Pictures.encoded(Pictures.image(width: 300, height: 200), as: .tiff), name: "scan.tiff")
        #expect(tiff.name == "scan.jpg" && tiff.mime == "image/jpeg" && Pictures.isJPEG(tiff.data))
    }
}

@Suite("What one message may take")
struct AttachmentLimitTests {
    static let limits = SendLimits(maxCount: 6, maxBytes: 8 * 1024 * 1024, maxTotalBytes: 10 * 1024 * 1024)

    static func file(_ megabytes: Int) -> OutgoingAttachment {
        OutgoingAttachment(id: UUID(), name: "Photo.jpg", mime: "image/jpeg", size: megabytes * 1024 * 1024, file: "x.jpg")
    }

    /// Each refusal says what is too much, and how much the Mac takes.
    @Test func theMacsLimitsAreSaidInWords() {
        #expect(AttachmentLimits.refusal("notes.pdf", size: 1_000, joining: [Self.file(1)], limits: Self.limits) == nil)
        #expect(AttachmentLimits.refusal("notes.pdf", size: 1_000, joining: Array(repeating: Self.file(1), count: 6), limits: Self.limits)
                == "Up to 6 files in one message.")
        #expect(AttachmentLimits.refusal("notes.pdf", size: 9 * 1024 * 1024, joining: [], limits: Self.limits)
                == "notes.pdf is over 8 MB, the most your Mac takes from iPhone.")
        #expect(AttachmentLimits.refusal("film.mov", size: 3 * 1024 * 1024, joining: [Self.file(4), Self.file(4)], limits: Self.limits)
                == "film.mov would take this message over 10 MB, the most your Mac takes in one.")
        // Exactly at a limit is within it.
        #expect(AttachmentLimits.refusal("film.mov", size: 2 * 1024 * 1024, joining: [Self.file(4), Self.file(4)], limits: Self.limits) == nil)
        #expect(AttachmentLimits.refusal("film.mov", size: 8 * 1024 * 1024, joining: [], limits: Self.limits) == nil)
    }

    /// A photo is named so no two in a message share a name; a picture made a JPEG says so.
    @Test func photosAreNamedApart() {
        func named(_ names: String...) -> [OutgoingAttachment] {
            names.map { OutgoingAttachment(id: UUID(), name: $0, mime: "image/jpeg", size: 1, file: "x.jpg") }
        }
        #expect(AttachmentNames.photo(besides: []) == "Photo.jpg")
        #expect(AttachmentNames.photo(besides: named("notes.pdf")) == "Photo.jpg")
        #expect(AttachmentNames.photo(besides: named("Photo.jpg")) == "Photo 2.jpg")
        #expect(AttachmentNames.photo(besides: named("Photo.jpg", "Photo 2.jpg", "Photo 4.jpg")) == "Photo 3.jpg")
        #expect(AttachmentNames.jpeg("IMG_0412.HEIC") == "IMG_0412.jpg")
        #expect(AttachmentNames.jpeg("scan") == "scan.jpg")
    }
}

@Suite("What the mode chip says")
struct SettingWordsTests {
    static func options(_ permissionMode: String?, modes: [Choice] = [Choice(id: "build", label: "Build"), Choice(id: "plan", label: "Plan"),
                                                                     Choice(id: "ask", label: "Ask")]) -> SessionOptions {
        SessionOptions(agent: AgentOptions(kind: "claude", name: "Claude", mark: "claude", models: [ModelChoice(id: nil, label: "Opus 5.5")],
                                           modes: modes,
                                           permissions: [Choice(id: "default", label: "Ask each time"), Choice(id: "acceptEdits", label: "Accept edits"),
                                                         Choice(id: "bypassPermissions", label: "Full access")]),
                       model: nil, modelLabel: "Opus 5.5", effort: nil, permissionMode: permissionMode, midTurn: .queue,
                       attachments: SendLimits(maxCount: 6, maxBytes: 1, maxTotalBytes: 1))
    }

    /// In Build the chip is the rung the agent is on, in Plan and Ask the mode, each with a glyph that says it.
    @Test func inBuildTheRungInPlanOrAskTheMode() {
        #expect(SettingWords.chip(Self.options("default")) == ("Ask each time", "hand.raised"))
        #expect(SettingWords.chip(Self.options("acceptEdits")) == ("Accept edits", "pencil"))
        #expect(SettingWords.chip(Self.options("bypassPermissions")) == ("Full access", "exclamationmark.shield"))
        #expect(SettingWords.chip(Self.options("plan")) == ("Plan", "list.bullet.clipboard"))
        #expect(SettingWords.chip(Self.options("ask")) == ("Ask", "questionmark.bubble"))
        // Build on a rung the Mac has not said yet is Build, not a guess.
        #expect(SettingWords.chip(Self.options(nil)) == ("Build", "hammer"))
    }

    @Test func eachSayInOneLineWhatItLetsTheAgentDo() {
        #expect(SettingWords.line(.plan) == "Plans first, and changes nothing until you approve the plan.")
        #expect(SettingWords.line(permission: "acceptEdits") == "Edits files without asking, and asks before commands.")
        #expect(SettingWords.line(permission: "someOtherRung") == nil)
    }
}
