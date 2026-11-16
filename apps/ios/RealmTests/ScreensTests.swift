import RealmKit
import SwiftUI
import Testing
import UIKit
@testable import Realm

@MainActor
@Suite("Watching a session's screens", .serialized)
struct ScreensTests {
    static let phone = SessionScreen(id: "sim1", kind: .simulator, name: "iPhone 17 Pro", detail: "iOS Simulator", live: true)
    static let app = SessionScreen(id: "m1", kind: .machine, name: "TextEdit", detail: "Mac app", live: true)

    /// The bar's glyph says which kind the space has open, and both when it has both.
    @Test func theButtonWearsTheKindItShows() {
        #expect(ScreenWords.glyph([Self.phone]) == "iphone")
        #expect(ScreenWords.glyph([Self.app]) == "display")
        #expect(ScreenWords.glyph([Self.phone, Self.app]) == "rectangle.on.rectangle")
        #expect(ScreenWords.hint([Self.phone]) == "Shows iPhone 17 Pro")
        #expect(ScreenWords.hint([Self.phone, Self.app]) == "Shows 2 screens")
    }

    /// A refusal that says the screen is not running or not there rests the watch; a slow link does not.
    @Test func aScreenThatIsGoneStopsTheAsking() {
        let notRunning = ChannelError.rpc(RPCError(code: "FORBIDDEN", message: "iPhone 17 Pro is not running on the Mac."))
        #expect(ScreenWords.isGone(notRunning))
        #expect(ScreenWords.trouble(notRunning) == "iPhone 17 Pro is not running on the Mac.")
        #expect(ScreenWords.isGone(ChannelError.rpc(RPCError(code: "NOT_FOUND", message: ""))))
        #expect(!ScreenWords.isGone(ChannelError.timedOut))
        #expect(ScreenWords.trouble(ChannelError.timedOut) == "The picture took too long to arrive")
        #expect(ScreenWords.trouble(ChannelError.macOffline) == "Your Mac isn't connected")
    }

    @Test func aPicturesAgeIsSaidInUnits() {
        #expect(ScreenWords.age(1) == "Just now")
        #expect(ScreenWords.age(12) == "12s ago")
        #expect(ScreenWords.age(190) == "3m 10s ago")
    }

    /// A live screen's Pause and Share, at rest on the sheet's ground.
    @Test func aLiveScreenOffersPauseAndShare() throws {
        let screen = SessionScreen(id: "sim", kind: .simulator, name: "iPhone 18 Pro Max", detail: "iOS Simulator", live: true)
        let picture = UIGraphicsImageRenderer(size: CGSize(width: 40, height: 80)).image { _ in }
        for dark in [false, true] {
            let words = try Drawing.words(ScreenControls(screen: screen, picture: picture, paused: .constant(false))
                .frame(maxWidth: .infinity).padding(.vertical, 24).background(Ground.grouped), dark: dark)
            #expect(words.contains("Pause"), "\(words)")
        }
        let paused = try Drawing.words(ScreenControls(screen: screen, picture: nil, paused: .constant(true)), dark: false)
        #expect(paused.contains("Jump to live"), "\(paused)")
    }

    /// With nothing open in the space, the sheet says so rather than spinning.
    @Test func anEmptySheetSaysThereIsNothingToShow() throws {
        let words = try Drawing.words(ScreensSheet(sessionId: "s1").environment(modelWithSession(status: .running)).frame(height: 700))
        #expect(words.contains("Nothing to show"), "\(words)")
    }
}
