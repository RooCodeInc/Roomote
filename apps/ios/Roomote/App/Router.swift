import SwiftUI
import Observation
import RoomoteKit

/// Single navigation stack: a root screen picked from the drawer plus pushed
/// Session and task details.
@MainActor
@Observable
final class Router {
    enum Screen: Hashable {
        case home, sessions, inbox, tasks, settings
    }

    enum Route: Hashable {
        case session(id: String)
        case task(id: String)
    }

    var screen: Screen = .home
    var path: [Route] = []
    var drawerOpen = false
    /// Set by the top bar's search button so the Sessions list reveals its field.
    var sessionsSearchRequested = false

    /// A link that arrived before sign-in completed.
    var pendingLink: DeepLink?

    var currentSessionID: String? {
        if case .session(let id)? = path.last { return id }
        return nil
    }

    func show(_ screen: Screen) {
        path = []
        self.screen = screen
        drawerOpen = false
    }

    func open(_ link: DeepLink) {
        switch link {
        case .session(let id):
            screen = .sessions
            path = [.session(id: id)]
        case .task(let id):
            screen = .tasks
            path = [.task(id: id)]
        case .auth:
            break
        }
        drawerOpen = false
    }

    func push(_ route: Route) {
        path.append(route)
        drawerOpen = false
    }

    func pop() {
        _ = path.popLast()
    }

    func flushPendingLink() {
        guard let link = pendingLink else { return }
        pendingLink = nil
        open(link)
    }

    func reset() {
        screen = .home
        path = []
        drawerOpen = false
        sessionsSearchRequested = false
    }

    #if DEBUG
    /// Simulator convenience: `SIMCTL_CHILD_ROOMOTE_DEV_SCREEN=sessions|inbox|tasks|settings|drawer|search`
    /// and `SIMCTL_CHILD_ROOMOTE_DEV_ROUTE=session:<id>|task:<id>` pick the first screen on launch.
    private static var debugStateApplied = false

    func applyDebugLaunchState() {
        guard !Self.debugStateApplied else { return }
        Self.debugStateApplied = true
        let environment = ProcessInfo.processInfo.environment
        switch environment["ROOMOTE_DEV_SCREEN"] {
        case "sessions": screen = .sessions
        case "inbox": screen = .inbox
        case "tasks": screen = .tasks
        case "settings": screen = .settings
        case "search": sessionsSearchRequested = true; screen = .sessions
        case "drawer": drawerOpen = true
        default: break
        }
        if let route = environment["ROOMOTE_DEV_ROUTE"] {
            let parts = route.split(separator: ":", maxSplits: 1).map(String.init)
            if parts.count == 2, parts[0] == "session" { open(.session(id: parts[1])) }
            if parts.count == 2, parts[0] == "task" { open(.task(id: parts[1])) }
            if environment["ROOMOTE_DEV_SCREEN"] == "drawer" { drawerOpen = true }
        }
    }
    #endif
}

/// Destination views for pushed routes.
struct RouteDestination: View {
    let route: Router.Route

    var body: some View {
        Group {
            switch route {
            case .session(let id):
                SessionDetailView(sessionID: id)
            case .task(let id):
                TaskDetailView(taskID: id)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
    }
}

/// Keeps the interactive swipe-back gesture alive while the system bar is hidden.
extension UINavigationController: @retroactive UIGestureRecognizerDelegate {
    override open func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
    }

    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        viewControllers.count > 1
    }
}
