import { act, render, screen } from '@testing-library/react';

import { MediaViewerImage } from './MediaViewer';

describe('MediaViewerImage', () => {
  it('reuses an already-loaded image without showing stale content', () => {
    const pendingImages: Array<{ onload: (() => void) | null }> = [];

    class MockImage {
      onload: (() => void) | null = null;

      set src(_value: string) {
        pendingImages.push(this);
      }
    }

    vi.stubGlobal('Image', MockImage);

    const { rerender, unmount } = render(
      <MediaViewerImage src="/first.png" alt="First artifact" />,
    );

    act(() => pendingImages[0]?.onload?.());
    expect(screen.getByRole('img', { name: 'First artifact' })).toHaveAttribute(
      'src',
      '/first.png',
    );

    rerender(<MediaViewerImage src="/second.png" alt="Second artifact" />);
    expect(screen.queryByRole('img', { name: 'First artifact' })).toBeNull();
    expect(screen.queryByRole('img', { name: 'Second artifact' })).toBeNull();

    act(() => pendingImages[1]?.onload?.());
    expect(
      screen.getByRole('img', { name: 'Second artifact' }),
    ).toHaveAttribute('src', '/second.png');

    unmount();
    render(<MediaViewerImage src="/first.png" alt="First artifact" />);
    expect(screen.getByRole('img', { name: 'First artifact' })).toHaveAttribute(
      'src',
      '/first.png',
    );
    expect(pendingImages).toHaveLength(2);
  });

  it('keeps a loaded image visible while its signed URL refreshes', () => {
    const pendingImages: Array<{ onload: (() => void) | null }> = [];

    class MockImage {
      onload: (() => void) | null = null;

      set src(_value: string) {
        pendingImages.push(this);
      }
    }

    vi.stubGlobal('Image', MockImage);

    const { rerender } = render(
      <MediaViewerImage src="/artifact.png?signature=first" alt="Artifact" />,
    );
    act(() => pendingImages[0]?.onload?.());

    rerender(
      <MediaViewerImage src="/artifact.png?signature=second" alt="Artifact" />,
    );

    expect(screen.getByRole('img', { name: 'Artifact' })).toHaveAttribute(
      'src',
      '/artifact.png?signature=first',
    );

    act(() => pendingImages[1]?.onload?.());
    expect(screen.getByRole('img', { name: 'Artifact' })).toHaveAttribute(
      'src',
      '/artifact.png?signature=second',
    );
  });

  afterEach(() => vi.unstubAllGlobals());
});
