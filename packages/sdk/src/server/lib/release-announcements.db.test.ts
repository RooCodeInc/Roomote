import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  db,
  deploymentSettings,
  eq,
  releaseAnnouncementDeliveries,
  upsertAutomation,
} from '@roomote/db/server';

const mocks = vi.hoisted(() => ({ postMessage: vi.fn() }));

vi.mock('./communication-providers', () => ({
  getCommunicationProviderAdapter: vi.fn(async () => ({
    provider: 'discord',
    postMessage: mocks.postMessage,
  })),
}));

import {
  buildInstalledReleaseAnnouncement,
  drainReleaseAnnouncementDeliveries,
  recordInstalledRelease,
} from './release-announcements';

const changelog = `# Changelog

## 1.2.0

### Highlights

- Added release summaries without @channel or <!here> notifications.
- Improved setup guidance.

### Patch changes

- Fixed a small issue.

## 1.1.0

### Highlights

- Added durable notification delivery.

## 1.0.0

### Highlights

- Initial release.
`;

beforeEach(async () => {
  mocks.postMessage.mockReset();
  mocks.postMessage.mockResolvedValue({
    provider: 'discord',
    channelId: 'manager-channel',
    messageId: 'message-1',
  });
  await db.delete(releaseAnnouncementDeliveries);
  await upsertAutomation(db, {
    key: 'release_announcements',
    enabled: true,
    settings: { optedOut: false },
    targets: [],
    managedTargetKinds: [
      'slack_channel',
      'slack_user',
      'teams_channel',
      'teams_user',
      'telegram_chat',
      'telegram_user',
      'discord_channel',
      'discord_user',
    ],
  });
  await db
    .insert(deploymentSettings)
    .values({
      id: 'default',
      installedReleaseVersion: null,
      installedReleaseRecordedAt: null,
      managerSlackChannelId: null,
      managerDiscordChannelId: null,
    })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: {
        installedReleaseVersion: null,
        installedReleaseRecordedAt: null,
        managerSlackChannelId: null,
        managerDiscordChannelId: null,
      },
    });
});

describe('installed release transitions', () => {
  it('silently establishes the first baseline and ignores restarts', async () => {
    await expect(recordInstalledRelease('v1.0.0')).resolves.toBe('baselined');
    await expect(recordInstalledRelease('1.0.0')).resolves.toBe('unchanged');

    expect(
      await db.query.releaseAnnouncementDeliveries.findMany(),
    ).toHaveLength(0);
  });

  it('inherits the standard Manager Channel destination and deduplicates concurrent recorders', async () => {
    await recordInstalledRelease('1.0.0');
    await db
      .update(deploymentSettings)
      .set({ managerDiscordChannelId: 'manager-channel' })
      .where(eq(deploymentSettings.id, 'default'));

    await Promise.all([
      recordInstalledRelease('1.2.0'),
      recordInstalledRelease('1.2.0'),
    ]);

    const deliveries = await db.query.releaseAnnouncementDeliveries.findMany();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      previousVersion: '1.0.0',
      installedVersion: '1.2.0',
      provider: 'discord',
      channelId: 'manager-channel',
    });
  });

  it('does not queue when disabled and silently resets a rollback baseline', async () => {
    await recordInstalledRelease('1.1.0');
    await db
      .update(deploymentSettings)
      .set({ managerDiscordChannelId: 'manager-channel' })
      .where(eq(deploymentSettings.id, 'default'));
    await upsertAutomation(db, {
      key: 'release_announcements',
      enabled: false,
      settings: { optedOut: true },
    });

    await expect(recordInstalledRelease('1.2.0')).resolves.toBe(
      'announcement_disabled',
    );
    await expect(recordInstalledRelease('1.0.0')).resolves.toBe(
      'rollback_baselined',
    );
    expect(
      await db.query.releaseAnnouncementDeliveries.findMany(),
    ).toHaveLength(0);
  });

  it('prefers its configured destination over the Manager Channel', async () => {
    await recordInstalledRelease('1.0.0');
    await db
      .update(deploymentSettings)
      .set({ managerDiscordChannelId: 'manager-channel' })
      .where(eq(deploymentSettings.id, 'default'));
    await upsertAutomation(db, {
      key: 'release_announcements',
      enabled: true,
      settings: { optedOut: false },
      targets: [
        {
          provider: 'discord',
          targetKind: 'discord_channel',
          externalRef: 'release-channel',
        },
      ],
    });

    await expect(recordInstalledRelease('1.1.0')).resolves.toBe('queued');
    await expect(
      db.query.releaseAnnouncementDeliveries.findFirst(),
    ).resolves.toMatchObject({
      provider: 'discord',
      channelId: 'release-channel',
    });
  });
});

describe('release announcement delivery', () => {
  it('summarizes skipped releases from authored highlights without mass pings', () => {
    const message = buildInstalledReleaseAnnouncement({
      previousVersion: '1.0.0',
      installedVersion: '1.2.0',
      changelogMarkdown: changelog,
    });

    expect(message).toContain('Highlights across 2 releases');
    expect(message).toContain('**v1.2.0:** Added release summaries');
    expect(message).toContain(
      '**v1.1.0:** Added durable notification delivery',
    );
    expect(message).not.toContain('@channel');
    expect(message).not.toContain('<!here>');
    expect(message).toContain(
      'https://github.com/RooCodeInc/Roomote/releases/tag/v1.2.0',
    );
  });

  it('retries a failed destination without losing or duplicating it', async () => {
    await db.insert(releaseAnnouncementDeliveries).values({
      previousVersion: '1.0.0',
      installedVersion: '1.2.0',
      provider: 'discord',
      destinationKey: 'discord:manager-channel',
      channelId: 'manager-channel',
    });
    mocks.postMessage.mockRejectedValueOnce(new Error('temporary outage'));

    await expect(
      drainReleaseAnnouncementDeliveries({ changelogMarkdown: changelog }),
    ).resolves.toEqual({ delivered: 0, failed: 1 });
    let delivery = await db.query.releaseAnnouncementDeliveries.findFirst();
    expect(delivery).toMatchObject({ status: 'pending', attempts: 1 });
    expect(delivery?.lastError).toBe('temporary outage');

    await db
      .update(releaseAnnouncementDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(releaseAnnouncementDeliveries.id, delivery!.id));
    mocks.postMessage.mockResolvedValueOnce({
      provider: 'discord',
      channelId: 'manager-channel',
      messageId: 'message-2',
    });

    await expect(
      drainReleaseAnnouncementDeliveries({ changelogMarkdown: changelog }),
    ).resolves.toEqual({ delivered: 1, failed: 0 });
    delivery = await db.query.releaseAnnouncementDeliveries.findFirst();
    expect(delivery).toMatchObject({
      status: 'delivered',
      attempts: 1,
      providerMessageId: 'message-2',
    });
    await expect(
      drainReleaseAnnouncementDeliveries({ changelogMarkdown: changelog }),
    ).resolves.toEqual({ delivered: 0, failed: 0 });
    expect(mocks.postMessage).toHaveBeenCalledTimes(2);
  });

  it('delivers through a provider-neutral Telegram destination', async () => {
    await db.insert(releaseAnnouncementDeliveries).values({
      previousVersion: '1.0.0',
      installedVersion: '1.2.0',
      provider: 'telegram',
      destinationKey: 'telegram:release-chat',
      channelId: 'release-chat',
    });

    await expect(
      drainReleaseAnnouncementDeliveries({ changelogMarkdown: changelog }),
    ).resolves.toEqual({ delivered: 1, failed: 0 });
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'release-chat' }),
    );
  });

  it('reuses a persisted service URL for Teams direct-message retries', async () => {
    await db.insert(releaseAnnouncementDeliveries).values({
      previousVersion: '1.0.0',
      installedVersion: '1.2.0',
      provider: 'teams',
      destinationKey: 'teams:dm-conversation',
      channelId: 'dm-conversation',
      serviceUrl: 'https://smba.example/amer/',
    });

    await expect(
      drainReleaseAnnouncementDeliveries({ changelogMarkdown: changelog }),
    ).resolves.toEqual({ delivered: 1, failed: 0 });
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'dm-conversation',
        serviceUrl: 'https://smba.example/amer/',
      }),
    );
  });
});
