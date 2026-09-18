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
  buildReleaseAnnouncement,
  drainReleaseAnnouncementDeliveries,
  recordInstalledRelease,
  sendReleaseAnnouncementTest,
} from './release-announcements';

const changelog = `# Changelog

## 1.2.0

Roomote 1.2 adds release summaries and safer setup guidance.

### Highlights

- Added release summaries without @channel or <!here> notifications.
- Improved setup guidance.
- Added a third authored highlight.
- Added a fourth authored highlight.

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

  it('advances patch baselines silently and announces the next minor boundary from that patch', async () => {
    await recordInstalledRelease('1.11.0');
    await db
      .update(deploymentSettings)
      .set({ managerDiscordChannelId: 'manager-channel' })
      .where(eq(deploymentSettings.id, 'default'));

    await expect(recordInstalledRelease('1.11.1')).resolves.toBe(
      'patch_baselined',
    );
    await expect(
      db.query.deploymentSettings.findFirst({
        where: eq(deploymentSettings.id, 'default'),
        columns: { installedReleaseVersion: true },
      }),
    ).resolves.toMatchObject({ installedReleaseVersion: '1.11.1' });
    expect(
      await db.query.releaseAnnouncementDeliveries.findMany(),
    ).toHaveLength(0);

    await expect(recordInstalledRelease('1.12.2')).resolves.toBe('queued');
    await expect(
      db.query.releaseAnnouncementDeliveries.findFirst(),
    ).resolves.toMatchObject({
      previousVersion: '1.11.0',
      installedVersion: '1.12.0',
    });
  });

  it('selects minor and major release identities when the installed release is a patch', async () => {
    await recordInstalledRelease('1.10.5');
    await db
      .update(deploymentSettings)
      .set({ managerDiscordChannelId: 'manager-channel' })
      .where(eq(deploymentSettings.id, 'default'));

    await expect(recordInstalledRelease('1.11.2')).resolves.toBe('queued');
    await expect(
      db.query.releaseAnnouncementDeliveries.findFirst(),
    ).resolves.toMatchObject({ installedVersion: '1.11.0' });
    await db.delete(releaseAnnouncementDeliveries);
    await expect(recordInstalledRelease('2.0.1')).resolves.toBe('queued');
    await expect(
      db.query.releaseAnnouncementDeliveries.findFirst(),
    ).resolves.toMatchObject({ installedVersion: '2.0.0' });
  });

  it('queues only the latest selected release when minor versions were skipped', async () => {
    await recordInstalledRelease('1.10.5');
    await db
      .update(deploymentSettings)
      .set({ managerDiscordChannelId: 'manager-channel' })
      .where(eq(deploymentSettings.id, 'default'));

    await expect(recordInstalledRelease('1.12.2')).resolves.toBe('queued');
    await expect(
      db.query.releaseAnnouncementDeliveries.findMany(),
    ).resolves.toEqual([
      expect.objectContaining({
        previousVersion: '1.10.0',
        installedVersion: '1.12.0',
      }),
    ]);
  });

  it('does not repeat a selected release after a rollback and re-upgrade', async () => {
    await recordInstalledRelease('1.0.0');
    await db
      .update(deploymentSettings)
      .set({ managerDiscordChannelId: 'manager-channel' })
      .where(eq(deploymentSettings.id, 'default'));

    await expect(recordInstalledRelease('1.2.2')).resolves.toBe('queued');
    await expect(recordInstalledRelease('1.1.4')).resolves.toBe(
      'rollback_baselined',
    );
    await expect(recordInstalledRelease('1.2.3')).resolves.toBe(
      'already_announced',
    );
    await expect(
      db.query.releaseAnnouncementDeliveries.findMany(),
    ).resolves.toHaveLength(1);
  });

  it('does not repeat a release stored under a legacy patch-version delivery key', async () => {
    await recordInstalledRelease('1.2.2');
    await db
      .update(deploymentSettings)
      .set({ managerDiscordChannelId: 'manager-channel' })
      .where(eq(deploymentSettings.id, 'default'));
    await db.insert(releaseAnnouncementDeliveries).values({
      previousVersion: '1.1.0',
      installedVersion: '1.2.2',
      provider: 'discord',
      destinationKey: 'discord:manager-channel',
      channelId: 'manager-channel',
      status: 'delivered',
      deliveredAt: new Date(),
    });

    await expect(recordInstalledRelease('1.1.4')).resolves.toBe(
      'rollback_baselined',
    );
    await expect(recordInstalledRelease('1.2.3')).resolves.toBe(
      'already_announced',
    );
    await expect(
      db.query.releaseAnnouncementDeliveries.findMany(),
    ).resolves.toEqual([
      expect.objectContaining({
        installedVersion: '1.2.2',
        status: 'delivered',
      }),
    ]);
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
  it('sends a representative release sample without requiring an installed baseline', async () => {
    await expect(
      sendReleaseAnnouncementTest(
        {
          provider: 'discord',
          channelId: 'release-channel',
          source: 'automation_target',
        },
        { changelogMarkdown: changelog },
      ),
    ).resolves.toBe('sent');

    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'release-channel',
        text: expect.stringContaining("What's new in Roomote v1.2.0"),
        textFormat: 'markdown',
        idempotencyKey: expect.stringMatching(/^release-test:1\.2\.0:/),
      }),
    );
    expect(mocks.postMessage.mock.calls[0]?.[0]?.text).not.toContain(
      'is installed',
    );
    expect(mocks.postMessage.mock.calls[0]?.[0]?.text).toContain(
      'Roomote 1.2 adds release summaries and safer setup guidance.',
    );
    expect(mocks.postMessage.mock.calls[0]?.[0]?.text).toContain(
      '- Added a fourth authored highlight.',
    );
    await expect(
      db.query.deploymentSettings.findFirst({
        where: eq(deploymentSettings.id, 'default'),
        columns: { installedReleaseVersion: true },
      }),
    ).resolves.toMatchObject({ installedReleaseVersion: null });
    await expect(
      db.query.releaseAnnouncementDeliveries.findMany(),
    ).resolves.toHaveLength(0);
  });

  it('uses the shared automation layout for Slack release announcements', async () => {
    await expect(
      sendReleaseAnnouncementTest(
        {
          provider: 'slack',
          channelId: 'release-channel',
          teamId: 'slack-team',
          source: 'automation_target',
        },
        { changelogMarkdown: changelog },
      ),
    ).resolves.toBe('sent');

    const message = mocks.postMessage.mock.calls[0]?.[0];
    expect(message).toEqual(
      expect.objectContaining({
        textFormat: 'markdown',
        blocks: [
          expect.objectContaining({
            type: 'context',
            elements: expect.arrayContaining([
              expect.objectContaining({
                image_url: expect.stringContaining(
                  '/automation-icons/megaphone.png',
                ),
                alt_text: 'Announce Roomote Updates automation icon',
              }),
              expect.objectContaining({
                type: 'plain_text',
                text: 'Announce Roomote Updates',
              }),
            ]),
          }),
          expect.objectContaining({
            type: 'markdown',
            text: expect.stringContaining("What's new in Roomote v1.2.0"),
          }),
          expect.objectContaining({
            type: 'actions',
            elements: expect.arrayContaining([
              expect.objectContaining({
                action_id: 'late_bound_automation_configure',
                text: expect.objectContaining({ text: 'Configure' }),
              }),
            ]),
          }),
        ],
      }),
    );
  });

  it('skips newer patch releases when selecting the sample release', async () => {
    const changelogWithPatch = `# Changelog

## 1.3.2

### Highlights

- Patch highlight that should not be sampled.

## 1.3.0

### Highlights

- Latest minor highlight.

## 1.2.0

### Highlights

- Older minor highlight.
`;

    await expect(
      sendReleaseAnnouncementTest(
        {
          provider: 'discord',
          channelId: 'release-channel',
          source: 'automation_target',
        },
        { changelogMarkdown: changelogWithPatch },
      ),
    ).resolves.toBe('sent');
    expect(mocks.postMessage.mock.calls[0]?.[0]?.text).toContain(
      "What's new in Roomote v1.3.0",
    );
    expect(mocks.postMessage.mock.calls[0]?.[0]?.text).not.toContain('v1.3.2');
  });

  it('selects the highest stable major or minor release by version', async () => {
    const unorderedChangelog = `# Changelog

## 2.1.0-beta.1

### Highlights

- Prerelease highlight.

## 1.9.0

### Highlights

- Minor highlight.

## 2.0.0

### Highlights

- Major highlight.
`;

    await expect(
      sendReleaseAnnouncementTest(
        {
          provider: 'discord',
          channelId: 'release-channel',
          source: 'automation_target',
        },
        { changelogMarkdown: unorderedChangelog },
      ),
    ).resolves.toBe('sent');
    expect(mocks.postMessage.mock.calls[0]?.[0]?.text).toContain(
      "What's new in Roomote v2.0.0",
    );
    expect(mocks.postMessage.mock.calls[0]?.[0]?.text).not.toContain(
      'Prerelease highlight',
    );
  });

  it('does not send when stable major or minor release notes are missing', async () => {
    await expect(
      sendReleaseAnnouncementTest(
        {
          provider: 'discord',
          channelId: 'release-channel',
          source: 'automation_target',
        },
        {
          changelogMarkdown: `# Changelog

## 1.3.2

### Highlights

- Patch-only highlight.
`,
        },
      ),
    ).resolves.toBe('no_release_notes');
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it('matches the release modal summary and complete authored highlights', () => {
    const announcement = buildReleaseAnnouncement({
      releaseVersion: '1.2.0',
      changelogMarkdown: changelog,
    });

    expect(announcement?.version).toBe('1.2.0');
    expect(announcement?.text).toContain(
      'Roomote 1.2 adds release summaries and safer setup guidance.',
    );
    expect(announcement?.text.match(/^- /gm)).toHaveLength(4);
    expect(announcement?.text).toContain(
      '- Added a fourth authored highlight.',
    );
    expect(announcement?.text).not.toContain('@channel');
    expect(announcement?.text).not.toContain('<!here>');
    expect(announcement?.text).not.toContain('durable notification delivery');
    expect(announcement?.text).toContain(
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

  it('uses the same authored summary and complete highlights for automatic delivery', async () => {
    await db.insert(releaseAnnouncementDeliveries).values({
      previousVersion: '1.1.0',
      installedVersion: '1.2.0',
      provider: 'discord',
      destinationKey: 'discord:manager-channel',
      channelId: 'manager-channel',
    });

    await expect(
      drainReleaseAnnouncementDeliveries({ changelogMarkdown: changelog }),
    ).resolves.toEqual({ delivered: 1, failed: 0 });
    expect(mocks.postMessage.mock.calls[0]?.[0]?.text).toContain(
      'Roomote 1.2 adds release summaries and safer setup guidance.',
    );
    expect(
      mocks.postMessage.mock.calls[0]?.[0]?.text.match(/^- /gm),
    ).toHaveLength(4);
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

  it('terminally skips a valid release range with no authored highlights', async () => {
    await db.insert(releaseAnnouncementDeliveries).values({
      previousVersion: '1.1.0',
      installedVersion: '1.2.0',
      provider: 'discord',
      destinationKey: 'discord:manager-channel',
      channelId: 'manager-channel',
    });
    const changelogWithoutHighlights = `# Changelog

## 1.2.0

### Patch changes

- Fixed an internal issue.

## 1.1.0

### Patch changes

- Fixed another internal issue.
`;

    expect(
      buildReleaseAnnouncement({
        releaseVersion: '1.2.0',
        changelogMarkdown: changelogWithoutHighlights,
      }),
    ).toBeNull();
    await expect(
      drainReleaseAnnouncementDeliveries({
        changelogMarkdown: changelogWithoutHighlights,
      }),
    ).resolves.toEqual({ delivered: 0, failed: 0 });
    await expect(
      db.query.releaseAnnouncementDeliveries.findFirst(),
    ).resolves.toMatchObject({ status: 'skipped', attempts: 0 });
    expect(mocks.postMessage).not.toHaveBeenCalled();
    await expect(
      drainReleaseAnnouncementDeliveries({
        changelogMarkdown: changelogWithoutHighlights,
      }),
    ).resolves.toEqual({ delivered: 0, failed: 0 });
  });

  it('keeps missing authoritative release data retryable', async () => {
    await db.insert(releaseAnnouncementDeliveries).values({
      previousVersion: '1.1.0',
      installedVersion: '1.2.0',
      provider: 'discord',
      destinationKey: 'discord:manager-channel',
      channelId: 'manager-channel',
    });

    await expect(
      drainReleaseAnnouncementDeliveries({
        changelogMarkdown: '# Changelog\n\n## 1.1.0\n',
      }),
    ).resolves.toEqual({ delivered: 0, failed: 1 });
    await expect(
      db.query.releaseAnnouncementDeliveries.findFirst(),
    ).resolves.toMatchObject({ status: 'pending', attempts: 1 });
  });
});
