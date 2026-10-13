import RealmKit
import SwiftUI
import UIKit
import UserNotifications

@main
struct RealmApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(delegate.model)
                // `realm-mobile://pair#…`, and `https://realm.computer/pair#…` as a Universal Link. The
                // pairing secret is in the fragment, which never reaches a server.
                .onOpenURL { url in delegate.model.open(url: url) }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { delegate.model.open(url: url) }
                }
                .task { await delegate.model.launch() }
        }
        .onChange(of: scenePhase) { _, phase in
            delegate.model.scenePhaseChanged(phase)
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let model = AppModel()

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        // Unattended runs read `print` from a file (`simctl launch --stdout`); line-buffer it.
        setvbuf(stdout, nil, _IOLBF, 0)
        if !RealmType.isInstalled { model.log.error("JetBrains Mono did not register; the system's mono stands in.") }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        model.didRegisterForPushes(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        model.log.error("Could not register for pushes: \(error.localizedDescription, privacy: .public)")
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    /// A tap on a notification opens its session. The extension leaves the session's id in `userInfo`.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let session = response.notification.request.content.userInfo["session"] as? String
        await MainActor.run { model.show(session: session) }
    }
}
