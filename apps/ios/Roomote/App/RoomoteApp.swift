import SwiftUI
import RoomoteKit

@main
struct RoomoteApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var app = AppModel.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .environment(app.router)
                .onOpenURL { url in
                    app.handle(url: url)
                }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL {
                        app.handle(url: url)
                    }
                }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            if app.isSignedIn {
                AppShell()
            } else {
                SignInView()
            }
        }
        .animation(.default, value: app.isSignedIn)
        .preferredColorScheme(nil)
    }
}
