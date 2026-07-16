// pnpm --filter @roomote/api test github/__tests__/isFromKnownInstallation.test.ts

const { mockFindFirst } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      githubInstallations: {
        findFirst: mockFindFirst,
      },
    },
  },
  githubInstallations: {
    installationId: 'githubInstallations.installationId',
  },
  eq: vi.fn((left: unknown, right: unknown) => [left, right]),
}));

import { isFromKnownInstallation } from '../isFromKnownInstallation';

describe('isFromKnownInstallation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows installation.created without a lookup so pending installations can complete', async () => {
    const payload = JSON.stringify({
      action: 'created',
      installation: { id: 123 },
    });

    await expect(
      isFromKnownInstallation('installation', payload),
    ).resolves.toBe(true);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it('allows events from a known installation', async () => {
    mockFindFirst.mockResolvedValue({ id: 'installation-row' });

    const payload = JSON.stringify({
      action: 'opened',
      installation: { id: 456 },
    });

    await expect(
      isFromKnownInstallation('pull_request', payload),
    ).resolves.toBe(true);
  });

  it('rejects events from an unknown installation', async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const payload = JSON.stringify({
      action: 'opened',
      installation: { id: 789 },
    });

    await expect(
      isFromKnownInstallation('pull_request', payload),
    ).resolves.toBe(false);
  });

  it('rejects non-created installation events from an unknown installation', async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const payload = JSON.stringify({
      action: 'deleted',
      installation: { id: 789 },
    });

    await expect(
      isFromKnownInstallation('installation', payload),
    ).resolves.toBe(false);
  });

  it('allows signed events without an installation reference', async () => {
    const payload = JSON.stringify({ zen: 'Keep it logically awesome.' });

    await expect(isFromKnownInstallation('ping', payload)).resolves.toBe(true);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it('defers malformed payloads to signature verification', async () => {
    await expect(
      isFromKnownInstallation('pull_request', 'not-json'),
    ).resolves.toBe(true);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});
