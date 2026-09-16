import SwiftUI
import RoomoteKit

struct ArtifactsGallery: View {
    let artifacts: [Artifact]
    @State private var zoomed: Artifact?
    @State private var safariURL: URL?

    private var images: [Artifact] { artifacts.filter { $0.isImage && $0.resolvedURL != nil } }
    private var others: [Artifact] { artifacts.filter { !$0.isImage } }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !images.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(images) { artifact in
                            Button { zoomed = artifact } label: {
                                AsyncImage(url: artifact.resolvedURL) { phase in
                                    if let image = phase.image {
                                        image.resizable().scaledToFill()
                                    } else if case .failure = phase {
                                        Image(systemName: "photo").foregroundStyle(.secondary)
                                    } else {
                                        ProgressView()
                                    }
                                }
                                .frame(width: 140, height: 100)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                                .overlay(alignment: .bottomLeading) {
                                    Text(artifact.type)
                                        .font(.caption2)
                                        .padding(4)
                                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 6))
                                        .padding(4)
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(artifact.fileName)
                        }
                    }
                }
            }
            ForEach(others) { artifact in
                Button {
                    safariURL = artifact.resolvedURL
                } label: {
                    HStack {
                        Image(systemName: "doc")
                        VStack(alignment: .leading) {
                            Text(artifact.fileName).lineLimit(1)
                            Text(artifact.type).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "arrow.up.right.square").foregroundStyle(.secondary)
                    }
                }
                .disabled(artifact.resolvedURL == nil)
            }
        }
        .sheet(item: $zoomed) { artifact in
            if let url = artifact.resolvedURL {
                ImageZoomSheet(url: url, title: artifact.fileName)
            }
        }
        .safariSheet(url: $safariURL)
    }
}
