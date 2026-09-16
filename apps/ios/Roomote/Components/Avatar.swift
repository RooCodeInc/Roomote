import SwiftUI

/// Round avatar: remote image when available, else two-letter initials on `muted`.
struct Avatar: View {
    let name: String?
    let imageURL: String?
    var size: CGFloat = 32

    var body: some View {
        Group {
            if let imageURL, let url = URL(string: imageURL) {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        placeholder
                    }
                }
            } else {
                placeholder
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().stroke(RoomoteTheme.border, lineWidth: 1))
        .accessibilityLabel(name ?? "Avatar")
    }

    private var placeholder: some View {
        ZStack {
            Circle().fill(RoomoteTheme.muted)
            Text(RoomoteLabels.initials(name))
                .font(RoomoteTheme.font(size * 0.375, weight: .medium))
                .foregroundStyle(RoomoteTheme.foreground)
        }
    }
}

/// Avatar with the lime unread dot at its top-right, ringed with the page background.
struct AvatarWithUnread: View {
    let name: String?
    let imageURL: String?
    var unread = false
    var size: CGFloat = 32

    var body: some View {
        Avatar(name: name, imageURL: imageURL, size: size)
            .overlay(alignment: .topTrailing) {
                if unread {
                    Circle()
                        .fill(RoomoteTheme.accent)
                        .frame(width: 8, height: 8)
                        .overlay(Circle().stroke(RoomoteTheme.background, lineWidth: 2))
                        .offset(x: 1, y: -1)
                        .accessibilityLabel("Unread")
                }
            }
    }
}

/// One of the 25 bundled robot portraits, picked deterministically from an id.
struct RobotAvatar: View {
    let id: String
    var size: CGFloat = 24

    var body: some View {
        Group {
            if let image = UIImage(named: "robot-\(String(format: "%03d", Self.index(for: id)))") {
                Image(uiImage: image).resizable().scaledToFit()
            } else {
                Circle().fill(RoomoteTheme.muted)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }

    static func index(for id: String) -> Int {
        var hash: UInt32 = 5381
        for byte in id.utf8 { hash = hash &* 33 &+ UInt32(byte) }
        return Int(hash % 25) + 1
    }
}
