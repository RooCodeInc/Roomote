import { isTaskSharedDesktopHost } from './shared-desktop-host';

describe('isTaskSharedDesktopHost', () => {
  it("accepts the run's own desktop host with and without a subdomain suffix", () => {
    expect(
      isTaskSharedDesktopHost(
        new URL(
          'http://abc123def4567-shared-desktop.roomotepreview.localhost:18081',
        ),
        'abc123def4567',
      ),
    ).toBe(true);
    expect(
      isTaskSharedDesktopHost(
        new URL(
          'https://abc123def4567-shared-desktop-inner.preview.example.com/stream.mp4',
        ),
        'abc123def4567',
      ),
    ).toBe(true);
  });

  it('rejects other tasks, other ports, and lookalike prefixes', () => {
    expect(
      isTaskSharedDesktopHost(
        new URL(
          'http://other0000000-shared-desktop.roomotepreview.localhost:18081',
        ),
        'abc123def4567',
      ),
    ).toBe(false);
    expect(
      isTaskSharedDesktopHost(
        new URL('http://abc123def4567-web.roomotepreview.localhost:18081'),
        'abc123def4567',
      ),
    ).toBe(false);
    expect(
      isTaskSharedDesktopHost(
        new URL(
          'http://abc123def4567-shared-desktopx.roomotepreview.localhost:18081',
        ),
        'abc123def4567',
      ),
    ).toBe(false);
  });
});
