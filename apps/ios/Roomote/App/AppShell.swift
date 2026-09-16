import SwiftUI
import RoomoteKit

/// Signed-in root: top bar, the drawer-selected screen, and the drawer overlay.
struct AppShell: View {
    @Environment(Router.self) private var router
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var router = router
        ZStack {
            NavigationStack(path: $router.path) {
                VStack(spacing: 0) {
                    TopBar()
                    rootScreen
                        .id(router.screen)
                }
                .background(RoomoteTheme.background.ignoresSafeArea())
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: Router.Route.self) { route in
                    RouteDestination(route: route)
                }
            }
            DrawerContainer()
        }
        .tint(RoomoteTheme.accent)
        .onAppear {
            router.flushPendingLink()
            Task { await app.refreshInboxCount() }
            #if DEBUG
            router.applyDebugLaunchState()
            #endif
        }
        .task(id: app.refreshToken) {
            if app.refreshToken > 0 { await app.refreshInboxCount() }
        }
    }

    @ViewBuilder
    private var rootScreen: some View {
        switch router.screen {
        case .home: HomeView()
        case .sessions: SessionsListView()
        case .inbox: InboxView()
        case .tasks: TasksListView()
        case .settings: SettingsView()
        }
    }
}

/// Scrim plus the drawer sliding in from the left.
private struct DrawerContainer: View {
    @Environment(Router.self) private var router

    var body: some View {
        @Bindable var router = router
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                if router.drawerOpen {
                    RoomoteTheme.scrim
                        .ignoresSafeArea()
                        .onTapGesture { router.drawerOpen = false }
                        .transition(.opacity)
                    DrawerView()
                        .frame(width: geometry.size.width * 0.75)
                        .transition(.move(edge: .leading))
                        .gesture(
                            DragGesture(minimumDistance: 20)
                                .onEnded { value in
                                    if value.translation.width < -60 { router.drawerOpen = false }
                                }
                        )
                }
            }
        }
        .animation(.easeInOut(duration: 0.22), value: router.drawerOpen)
    }
}
