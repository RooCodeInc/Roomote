const mocks = vi.hoisted(() => ({
  getAutomationRuntime: vi.fn(),
  sendReleaseAnnouncementTest: vi.fn(),
  listConnectedCommunicationProviders: vi.fn(),
  resolveAutomationRuntimeDestination: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  getAutomationRuntime: mocks.getAutomationRuntime,
}));

vi.mock('../../lib/release-announcements', () => ({
  sendReleaseAnnouncementTest: mocks.sendReleaseAnnouncementTest,
}));

vi.mock('../destination', () => ({
  listConnectedCommunicationProviders:
    mocks.listConnectedCommunicationProviders,
  resolveAutomationRuntimeDestination:
    mocks.resolveAutomationRuntimeDestination,
}));

import { releaseAnnouncementsJob } from '../release-announcements';

const configuredDestination = {
  provider: 'discord' as const,
  channelId: 'release-channel',
  source: 'automation_target' as const,
};

describe('releaseAnnouncementsJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAutomationRuntime.mockResolvedValue({
      enabled: true,
      targets: [],
    });
    mocks.listConnectedCommunicationProviders.mockResolvedValue(['discord']);
    mocks.resolveAutomationRuntimeDestination.mockResolvedValue(
      configuredDestination,
    );
    mocks.sendReleaseAnnouncementTest.mockResolvedValue('sent');
  });

  it('skips disabled announcements without resolving or delivering a destination', async () => {
    mocks.getAutomationRuntime.mockResolvedValue({
      enabled: false,
      targets: [],
    });

    await expect(releaseAnnouncementsJob()).resolves.toMatchObject({
      completed: false,
      skippedReason: 'Automation is disabled.',
    });
    expect(mocks.resolveAutomationRuntimeDestination).not.toHaveBeenCalled();
    expect(mocks.sendReleaseAnnouncementTest).not.toHaveBeenCalled();
  });

  it('uses the configured destination and does not probe provider fallbacks', async () => {
    await expect(
      releaseAnnouncementsJob({ destination: configuredDestination }),
    ).resolves.toMatchObject({ completed: true });

    expect(mocks.listConnectedCommunicationProviders).not.toHaveBeenCalled();
    expect(mocks.resolveAutomationRuntimeDestination).not.toHaveBeenCalled();
    expect(mocks.sendReleaseAnnouncementTest).toHaveBeenCalledWith(
      configuredDestination,
    );
  });

  it('skips when the configured and default destinations are unavailable', async () => {
    mocks.resolveAutomationRuntimeDestination.mockResolvedValue(null);

    await expect(releaseAnnouncementsJob()).resolves.toMatchObject({
      completed: false,
      skippedReason: 'Announcement destination is not configured.',
    });
    expect(mocks.sendReleaseAnnouncementTest).not.toHaveBeenCalled();
  });

  it.each([
    ['sent', { completed: true }],
    [
      'no_release_notes',
      {
        skippedReason: 'No stable major or minor release notes are available.',
      },
    ],
    [
      'no_highlights',
      {
        skippedReason:
          'The selected release has no authored summary or highlights.',
      },
    ],
  ] as const)(
    'maps the delivery result %s without changing baseline state',
    async (sendResult, expected) => {
      mocks.sendReleaseAnnouncementTest.mockResolvedValue(sendResult);

      await expect(releaseAnnouncementsJob()).resolves.toMatchObject(expected);
      expect(mocks.sendReleaseAnnouncementTest).toHaveBeenCalledWith(
        configuredDestination,
      );
    },
  );
});
