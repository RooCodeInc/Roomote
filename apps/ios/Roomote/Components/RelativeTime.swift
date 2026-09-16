import SwiftUI

@MainActor
enum RelativeTime {
    private static let formatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        formatter.dateTimeStyle = .numeric
        return formatter
    }()

    /// "just now", "5 minutes ago", "2 days ago".
    static func string(from date: Date, relativeTo now: Date = Date()) -> String {
        if now.timeIntervalSince(date) < 60 { return "just now" }
        return formatter.localizedString(for: date, relativeTo: now)
    }
}

/// Relative timestamp that refreshes itself every 30 seconds.
struct RelativeTimeText: View {
    let date: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            Text(RelativeTime.string(from: date, relativeTo: context.date))
        }
    }
}
