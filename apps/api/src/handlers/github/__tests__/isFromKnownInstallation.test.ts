// pnpm --filter @roomote/api test github/__tests__/isFromKnownInstallation.test.ts

const { mockFindFirst, mockFindPendingFirst } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockFindPendingFirst: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      githubInstallations: {
        findFirst: mockFindFirst,
      },
      githubPendingInstallations: {
        findFirst: mockFindPendingFirst,
      },
    },
  },
  githubInstallations: {
    installationId: 'githubInstallations.installationId',
  },
  githubPendingInstallations: {
    appId: 'githubPendingInstallations.appId',
  },
  eq: vi.fn((left: unknown, right: unknown) => [left, right]),
}));

import { isFromKnownInstallation } from '../isFromKnownInstallation';

describe('isFromKnownInstallation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows installation.created when the account has a pending installation', async () => {
    mockFindPendingFirst.mockResolvedValue({ id: 'pending-row' });

    const payload = JSON.stringify({
      action: 'created',
      installation: { id: 123, account: { id: 555 } },
    });

    await expect(
      isFromKnownInstallation('installation', payload),
    ).resolves.toBe(true);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it('rejects installation.created when no pending installation matches the account', async () => {
    mockFindPendingFirst.mockResolvedValue(undefined);

    const payload = JSON.stringify({
      action: 'created',
      installation: { id: 123, account: { id: 555 } },
    });

    await expect(
      isFromKnownInstallation('installation', payload),
    ).resolves.toBe(false);
  });

  it('rejects installation.created without an installation account', async () => {
    const payload = JSON.stringify({
      action: 'created',
      installation: { id: 123 },
    });

    await expect(
      isFromKnownInstallation('installation', payload),
    ).resolves.toBe(false);
    expect(mockFindPendingFirst).not.toHaveBeenCalled();
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

  it('allows installation_repositories events from a known installation', async () => {
    mockFindFirst.mockResolvedValue({ id: 'installation-row' });

    const payload = JSON.stringify({
      action: 'added',
      installation: { id: 456 },
      repositories_added: [{ id: 1, full_name: 'acme/new-repo' }],
    });

    await expect(
      isFromKnownInstallation('installation_repositories', payload),
    ).resolves.toBe(true);
  });

  it('rejects repository.created events from an unknown installation', async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const payload = JSON.stringify({
      action: 'created',
      installation: { id: 789 },
      repository: { id: 1, full_name: 'acme/new-repo' },
    });

    await expect(isFromKnownInstallation('repository', payload)).resolves.toBe(
      false,
    );
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
    expect(mockFindPendingFirst).not.toHaveBeenCalled();
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
    expect(mockFindPendingFirst).not.toHaveBeenCalled();
  });
});
