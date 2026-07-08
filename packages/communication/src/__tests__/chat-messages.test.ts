import { describe, expect, it } from 'vitest';

import {
  TASK_RUNTIME_FAILURE_TEXT,
  TASK_STARTUP_FAILURE_TEXT,
  buildAccountLinkConnectCopy,
  buildAccountLinkPromptText,
  buildAccountLinkThreadReplyText,
  buildOtherRunningTasksText,
  buildPullRequestMergedNotificationText,
  buildRoutingConfirmationText,
  buildSnapshotResumeAcknowledgementText,
  buildTaskLaunchAcknowledgementText,
  buildTaskStartingText,
  buildThreadReplyFooterText,
} from '../chat-messages';

describe('chat message copy builders', () => {
  it('builds account-link DM copy from provider and product names', () => {
    expect(
      buildAccountLinkConnectCopy({
        providerName: 'Slack',
        productName: 'Openmote',
      }),
    ).toMatchObject({
      fallbackText: 'Hi! Let me help you get started with Openmote.',
      requirementText:
        'To get started, I need to link your Slack and Openmote accounts.',
      identityBenefits: [
        'Associate tasks with you',
        'Access your configured agents',
        'Work with your authorized repositories',
      ],
      buttonText: 'Link accounts',
    });
  });

  it('builds resumable account-link prompt text', () => {
    expect(
      buildAccountLinkPromptText({
        providerName: 'Microsoft Teams',
        productName: 'Openmote',
        accountLinkUrl: 'https://openmote.dev/api/teams/auth?state=abc',
      }),
    ).toBe(
      "I need to link your Microsoft Teams and Openmote accounts before I can start tasks for you.\n\nOpen [this Microsoft Teams link](https://openmote.dev/api/teams/auth?state=abc) and I'll continue your original request after you sign in.",
    );
  });

  it('builds account-link thread replies', () => {
    expect(
      buildAccountLinkThreadReplyText({
        userMention: '<@U123>',
        dmPromptSent: true,
      }),
    ).toBe('<@U123> I sent you a DM to link your account.');

    expect(
      buildAccountLinkThreadReplyText({
        dmPromptSent: false,
        accountLabel: 'Microsoft Teams account',
        fallbackInstruction: 'Use the link below.',
      }),
    ).toBe(
      'I need to link your Microsoft Teams account before I can help. Use the link below.',
    );
  });

  it('builds routing and start acknowledgement text with caller formatting', () => {
    const code = (value: string) => `\`${value}\``;

    expect(
      buildRoutingConfirmationText({
        workspaceDisplayName: 'App',
        modelDisplayName: 'Opus',
        formatWorkspaceName: code,
        formatModelName: code,
      }),
    ).toBe("I'll get started in `App` using `Opus`, OK?");

    expect(
      buildTaskStartingText({
        workspaceDisplayName: 'App',
        formatWorkspaceName: code,
      }),
    ).toBe('Getting started on your task in `App`');
  });

  it('builds queue count, launch, and snapshot resume acknowledgements', () => {
    expect(buildOtherRunningTasksText(1)).toBe(
      '1 other task currently running',
    );
    expect(buildOtherRunningTasksText(2)).toBe(
      '2 other tasks currently running',
    );
    expect(buildOtherRunningTasksText(0)).toBeNull();

    expect(
      buildTaskLaunchAcknowledgementText({
        workspaceDisplayName: 'App',
        taskUrl: 'https://openmote.dev/task/123',
      }),
    ).toBe('Started a task in App: [open task](https://openmote.dev/task/123)');

    expect(
      buildTaskLaunchAcknowledgementText({
        workspaceDisplayName: 'App',
      }),
    ).toBe('Queued a task in App.');

    expect(
      buildSnapshotResumeAcknowledgementText({
        surfaceName: 'Teams thread',
      }),
    ).toBe(
      "I found the previous task for this Teams thread and I'm reconnecting it here...",
    );

    expect(
      buildSnapshotResumeAcknowledgementText({
        surfaceName: 'Teams thread',
        taskUrl: 'https://openmote.dev/task/123',
      }),
    ).toBe(
      'I found the previous task for this Teams thread and reconnected it here: [the task](https://openmote.dev/task/123).',
    );
  });

  it('builds thread reply footer text with caller link formatting', () => {
    expect(
      buildThreadReplyFooterText({
        taskUrl: 'https://openmote.dev/task/123',
      }),
    ).toBe('_Reply or use the [web app](https://openmote.dev/task/123)._');

    expect(
      buildThreadReplyFooterText({
        taskUrl: 'https://openmote.dev/task/123',
        explicitMentionRequired: true,
      }),
    ).toBe(
      '_Reply with @-mention or use the [web app](https://openmote.dev/task/123)._',
    );

    expect(
      buildThreadReplyFooterText({
        taskUrl: 'https://openmote.dev/task/123',
        linkedPr: {
          prNumber: 7,
          prUrl: 'https://github.com/org/repo/pull/7',
        },
        livePreviewUrl: 'https://preview.openmote.dev',
      }),
    ).toBe(
      '_Working on [PR #7](https://github.com/org/repo/pull/7), [live preview](https://preview.openmote.dev), reply or use the [web app](https://openmote.dev/task/123)._',
    );

    expect(
      buildThreadReplyFooterText({
        taskUrl: 'https://openmote.dev/task/123',
        livePreviewUrl: 'https://preview.openmote.dev',
        formatLink: (label, url) => `<${url}|${label}>`,
      }),
    ).toBe(
      '_Working on a <https://preview.openmote.dev|live preview>, reply or use the <https://openmote.dev/task/123|web app>._',
    );
  });

  it('keeps shared failure copy and PR merged copy in one place', () => {
    expect(TASK_STARTUP_FAILURE_TEXT).toContain("couldn't get started");
    expect(TASK_RUNTIME_FAILURE_TEXT).toContain('while working on this task');

    expect(
      buildPullRequestMergedNotificationText({
        prTitle: 'Fix auth',
        prUrl: 'https://github.com/org/repo/pull/1',
        mergedBy: 'matt',
        formatLink: (label, url) => `<${url}|${label}>`,
        formatStatus: (status) => `*${status}*`,
      }),
    ).toEqual({
      text: 'Fix auth was merged by matt',
      bodyText:
        '<https://github.com/org/repo/pull/1|Fix auth> was *merged* by matt',
    });
  });
});
