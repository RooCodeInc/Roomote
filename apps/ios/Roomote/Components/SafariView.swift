import SwiftUI
import SafariServices

struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
}

/// Presents an SFSafariViewController for `url` when non-nil.
struct SafariSheet: ViewModifier {
    @Binding var url: URL?

    func body(content: Content) -> some View {
        content.sheet(item: $url) { url in
            SafariView(url: url).ignoresSafeArea()
        }
    }
}

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}

extension View {
    func safariSheet(url: Binding<URL?>) -> some View {
        modifier(SafariSheet(url: url))
    }
}
