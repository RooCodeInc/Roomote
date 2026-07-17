import { DEFAULT_PR_REVIEW_SETTINGS } from '@roomote/types';

import type { Automation } from '../types';
import {
  normalizeBackgroundAgentSettings,
  normalizeReviewCodeAutomationSettings,
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

describe('normalizeBackgroundAgentSettings channel auto-start', () => {
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
