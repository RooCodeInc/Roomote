import SwiftUI
import UIKit

/// Design tokens shared with the Roomote web app (light and dark).
///
/// Colors are the web's oklch tokens converted to sRGB; fonts are the bundled
/// DM Sans variable font and Monaspace Neon, with system fallbacks when the
/// fonts fail to register.
enum RoomoteTheme {
    // MARK: Colors

    static let background = dynamic(light: 0xF1F2EF, dark: 0x21221F)
    static let card = dynamic(light: 0xFFFFFF, dark: 0x000000)
    static let foreground = dynamic(light: 0x000000, dark: 0xFFFFFF)
    static let muted = dynamic(light: 0xEEEEEE, dark: 0x222222)
    static let mutedForeground = dynamic(light: 0x000000, dark: 0xFFFFFF, alpha: 0.65)
    static let primary = dynamic(light: 0x000000, dark: 0xD6EE26)
    static let primaryForeground = dynamic(light: 0xFFFFFF, dark: 0x000000)
    /// The lime accent used for selection, unread dots, and focus rings.
    static let accent = dynamic(light: 0xB0CD26, dark: 0xD6EE26)
    static let border = dynamic(lightHex: 0xCECECE, lightAlpha: 1, darkHex: 0xFFFFFF, darkAlpha: 0.5)
    static let input = dynamic(light: 0xCECECE, dark: 0x484848)
    static let destructive = dynamic(light: 0xF14D4C, dark: 0xDE3B3D)
    static let warning = Color(hex: 0xE6A826)
    static let warningForeground = Color(hex: 0x2F1E00)
    /// User prompt bubble: foreground/10 on light, zinc-700 on dark.
    static let userBubble = dynamic(lightHex: 0x000000, lightAlpha: 0.10, darkHex: 0x3F3F46, darkAlpha: 1)
    /// Inline code chip: foreground at 15%.
    static let inlineCode = dynamic(light: 0x000000, dark: 0xFFFFFF, alpha: 0.15)
    /// Pressed row background: lime at 10%.
    static let rowPressed = dynamic(lightHex: 0xB0CD26, lightAlpha: 0.10, darkHex: 0xD6EE26, darkAlpha: 0.10)
    static let scrim = Color.black.opacity(0.5)

    // MARK: Radii (0.3rem base)

    enum Radius {
        static let sm: CGFloat = 0.8
        static let md: CGFloat = 2.8
        static let lg: CGFloat = 4.8
        static let xl: CGFloat = 8.8
    }

    // MARK: Fonts

    /// DM Sans at `size` with a variable-font weight, falling back to the system font.
    static func font(_ size: CGFloat, weight: UIFont.Weight = .regular) -> Font {
        Font(uiFont(size, weight: weight))
    }

    static func mono(_ size: CGFloat, medium: Bool = false) -> Font {
        let name = medium ? "MonaspaceNeon-Medium" : "MonaspaceNeon-Regular"
        if let font = UIFont(name: name, size: size) { return Font(font) }
        return .system(size: size, weight: medium ? .medium : .regular, design: .monospaced)
    }

    static func uiFont(_ size: CGFloat, weight: UIFont.Weight = .regular) -> UIFont {
        guard let name = dmSansFontName, let base = UIFont(name: name, size: size) else {
            return .systemFont(ofSize: size, weight: weight)
        }
        let variation: [Int: Double] = [
            Self.axis("wght"): Self.wght(for: weight),
            Self.axis("opsz"): Double(min(max(size, 9), 40)),
        ]
        let key = UIFontDescriptor.AttributeName(rawValue: kCTFontVariationAttribute as String)
        let descriptor = base.fontDescriptor.addingAttributes([key: variation])
        return UIFont(descriptor: descriptor, size: size)
    }

    private static let dmSansFontName: String? = {
        for family in UIFont.familyNames where family.hasPrefix("DM Sans") {
            if let name = UIFont.fontNames(forFamilyName: family).first { return name }
        }
        #if DEBUG
        print("RoomoteTheme: DM Sans not registered; families: \(UIFont.familyNames.filter { $0.contains("DM") || $0.contains("Monaspace") })")
        #endif
        return nil
    }()

    private static func axis(_ tag: String) -> Int {
        tag.utf8.reduce(0) { ($0 << 8) | Int($1) }
    }

    private static func wght(for weight: UIFont.Weight) -> Double {
        switch weight {
        case .ultraLight: 200
        case .thin: 100
        case .light: 300
        case .medium: 500
        case .semibold: 600
        case .bold: 700
        case .heavy: 800
        case .black: 900
        default: 400
        }
    }

    // MARK: Color helpers

    private static func dynamic(light: UInt32, dark: UInt32, alpha: CGFloat = 1) -> Color {
        dynamic(lightHex: light, lightAlpha: alpha, darkHex: dark, darkAlpha: alpha)
    }

    private static func dynamic(lightHex: UInt32, lightAlpha: CGFloat, darkHex: UInt32, darkAlpha: CGFloat) -> Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(hex: darkHex, alpha: darkAlpha)
                : UIColor(hex: lightHex, alpha: lightAlpha)
        })
    }
}

extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

extension Color {
    init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(uiColor: UIColor(hex: hex, alpha: alpha))
    }
}

/// SF Symbols standing in for the Lucide icons the web app uses.
enum RoomoteIcon {
    static let menu = "line.3.horizontal"
    static let plus = "plus"
    static let search = "magnifyingglass"
    static let home = "house"
    static let sessions = "list.bullet.rectangle"
    static let inbox = "tray"
    static let tasks = "doc.text"
    static let automations = "bolt"
    static let analytics = "chart.bar"
    static let settings = "gearshape"
    static let close = "xmark"
    static let chevronRight = "chevron.right"
    static let chevronDown = "chevron.down"
    static let arrowUpRight = "arrow.up.right"
    static let copy = "doc.on.doc"
    static let share = "square.and.arrow.up"
    static let brain = "brain"
    static let environment = "square.dashed"
    static let fileText = "doc.text"
    static let listChecks = "checklist"
    static let collapse = "arrow.left.to.line"
    static let externalLink = "arrow.up.forward.square"
    static let audioLines = "waveform"
    static let mic = "mic"
    static let send = "arrow.turn.down.left"
    static let idCard = "person.text.rectangle"
    static let messagesSquare = "bubble.left.and.bubble.right"
    static let activity = "waveform.path.ecg"
    static let userRound = "person"
    static let calendar = "calendar"
    static let sliders = "slider.horizontal.3"
    static let list = "list.bullet"
    static let columns = "rectangle.split.3x1"
    static let stop = "stop.circle"
    static let pullRequest = "arrow.triangle.pull"
}

// MARK: - Labels shared by rows and headers

enum RoomoteLabels {
    /// "openai/gpt-5.6-sol" -> "GPT 5.6 Sol"; nil -> "Default model".
    static func modelLabel(_ model: String?) -> String {
        guard let model, !model.isEmpty else { return "Default model" }
        let name = model.split(separator: "/").last.map(String.init) ?? model
        let words = name.split(whereSeparator: { $0 == "-" || $0 == "_" || $0 == " " }).map(String.init)
        return words.map { word in
            let lower = word.lowercased()
            if ["gpt", "o1", "o3", "o4"].contains(lower) { return word.uppercased() }
            if lower.first?.isNumber == true { return lower }
            return lower.prefix(1).uppercased() + lower.dropFirst()
        }.joined(separator: " ")
    }

    /// "web" -> "Web", "github" -> "GitHub".
    static func sourceLabel(_ surface: String) -> String {
        switch surface.lowercased() {
        case "": "Web"
        case "github": "GitHub"
        case "gitlab": "GitLab"
        case "api": "API"
        default: surface.prefix(1).uppercased() + surface.dropFirst()
        }
    }

    /// "__all_repositories__" -> "All repositories"; other names pass through.
    static func environmentLabel(_ name: String) -> String {
        guard name.hasPrefix("__") else { return name }
        let words = name.trimmingCharacters(in: CharacterSet(charactersIn: "_")).replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    /// "manage_tasks" -> "manage tasks".
    static func toolLabel(_ name: String) -> String {
        name.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
    }

    static func initials(_ name: String?) -> String {
        let parts = (name ?? "").split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first }.map(String.init).joined()
        return letters.isEmpty ? "?" : letters.uppercased()
    }

    /// "Sep 15, 11:44pm"
    static func timestamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "MMM d, h:mma"
        formatter.amSymbol = "am"
        formatter.pmSymbol = "pm"
        return formatter.string(from: date)
    }
}
