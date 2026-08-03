import { DEFAULT_PR_REVIEW_SETTINGS } from '@roomote/types';

import type { Automation } from '../types';
import {
  normalizeBackgroundAgentSettings,
  normalizeReviewCodeAutomationSettings,
  resolveAutomationDestination,
} from './automations';

function channelAutoStartAutomation(
  targets: Automation['targets'],
): Automation {
  return {
    key: 'slack_channel_auto_start',
    enabled: true,
    targets,
  } as unknown as Automation;
}

describe('normalizeReviewCodeAutomationSettings', () => {
  it('defaults all-author automatic review off', () => {
    const settings = normalizeReviewCodeAutomationSettings(undefined);

    expect(settings.reviewAllPullRequestAuthors).toBe(
      DEFAULT_PR_REVIEW_SETTINGS.reviewAllPullRequestAuthors,
    );
  });

  it('reads all-author automatic review from the review_code settings', () => {
    const settings = normalizeReviewCodeAutomationSettings({
      enabled: true,
      settings: {
        reviewAllPullRequestAuthors: true,
      },
      targets: [],
    } as unknown as Parameters<
      typeof normalizeReviewCodeAutomationSettings
    >[0]);

    expect(settings.reviewAllPullRequestAuthors).toBe(true);
  });
});

describe('resolveAutomationDestination', () => {
  it('prefers an automation target over either manager channel', () => {
    const destination = resolveAutomationDestination(
      {
        targets: [
          {
            provider: 'discord',
            targetKind: 'discord_channel',
            externalRef: 'D-AUTOMATION',
          },
        ],
      },
      'C-MANAGER',
      'D-MANAGER',
    );

    expect(destination).toEqual({
      provider: 'discord',
      channelId: 'D-AUTOMATION',
      source: 'automation_target',
    });
  });

  it('prefers the Slack manager channel over the Discord manager channel', () => {
    expect(
      resolveAutomationDestination(undefined, 'C-MANAGER', 'D-MANAGER'),
    ).toEqual({
      provider: 'slack',
      channelId: 'C-MANAGER',
      source: 'manager_channel',
    });
  });

  it('falls back to the Discord manager channel', () => {
    expect(resolveAutomationDestination(undefined, null, 'D-MANAGER')).toEqual({
      provider: 'discord',
      channelId: 'D-MANAGER',
      source: 'manager_channel',
    });
  });
});

describe('normalizeBackgroundAgentSettings channel auto-start', () => {
  it('projects the Discord manager channel', () => {
    const settings = normalizeBackgroundAgentSettings({
      managerDiscordChannelId: 'D-MANAGER',
    } as Parameters<typeof normalizeBackgroundAgentSettings>[0]);

    expect(settings.managerDiscordChannelId).toBe('D-MANAGER');
  });

  it('projects Slack and Discord auto-respond rows separately, ordered by metadata', () => {
    const settings = normalizeBackgroundAgentSettings(null, [
      channelAutoStartAutomation([
        {
          provider: 'discord',
          targetKind: 'discord_channel',
          externalRef: 'D2',
          metadata: { order: 1, instructions: 'Second discord.' },
        },
        {
          provider: 'slack',
          targetKind: 'slack_channel',
          externalRef: 'C1',
          metadata: { order: 0, instructions: 'Slack bugs.' },
        },
        {
          provider: 'discord',
          targetKind: 'discord_channel',
          externalRef: 'D1',
          metadata: {
            order: 0,
            instructions: 'First discord.',
            launchCriteria: 'Only new alerts.',
          },
        },
      ]),
    ]);

    expect(settings.channelAutoStartSlackChannels).toEqual([
      {
        channelId: 'C1',
        instructions: 'Slack bugs.',
        launchMode: 'always_start',
        launchCriteria: null,
      },
    ]);
    expect(settings.channelAutoStartDiscordChannels).toEqual([
      {
        channelId: 'D1',
        instructions: 'First discord.',
        launchMode: 'always_start',
        launchCriteria: 'Only new alerts.',
      },
      {
        channelId: 'D2',
        instructions: 'Second discord.',
        launchMode: 'always_start',
        launchCriteria: null,
      },
    ]);
    expect(settings.channelAutoStartDiscordChannelIds).toEqual(['D1', 'D2']);
    expect(settings.channelAutoStartSlackChannelIds).toEqual(['C1']);
  });

  it('enables channel auto-start when only Discord channels are configured', () => {
    const settings = normalizeBackgroundAgentSettings(null, [
      channelAutoStartAutomation([
        {
          provider: 'discord',
          targetKind: 'discord_channel',
          externalRef: 'D1',
          metadata: { order: 0 },
        },
      ]),
    ]);

    expect(settings.channelAutoStartSlackChannels).toEqual([]);
    expect(settings.channelAutoStartEnabled).toBe(true);
  });

  it('stays disabled when the automation has no targets', () => {
    const settings = normalizeBackgroundAgentSettings(null, [
      channelAutoStartAutomation([]),
    ]);

    expect(settings.channelAutoStartEnabled).toBe(false);
  });
});

describe('normalizeBackgroundAgentSettings emoji trigger', () => {
  it('projects the configured emoji and instructions when enabled', () => {
    const settings = normalizeBackgroundAgentSettings(null, [
      {
        key: 'call_roomote_via_emoji',
        enabled: true,
        instructions: 'Prioritize safety.',
        settings: { emoji: ':white_check_mark:' },
        targets: [],
      } as unknown as Automation,
    ]);

    expect(settings.callRoomoteViaEmojiName).toBe(':white_check_mark:');
    expect(settings.callRoomoteViaEmojiEnabled).toBe(true);
    expect(settings.callRoomoteViaEmojiInstructions).toBe('Prioritize safety.');
  });

  it('preserves the stored emoji when disabled', () => {
    const settings = normalizeBackgroundAgentSettings(null, [
      {
        key: 'call_roomote_via_emoji',
        enabled: false,
        settings: { emoji: 'eyes' },
        targets: [],
      } as unknown as Automation,
    ]);

    expect(settings.callRoomoteViaEmojiEnabled).toBe(false);
    expect(settings.callRoomoteViaEmojiName).toBe('eyes');
  });
});
