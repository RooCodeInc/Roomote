import { describe, expect, it } from 'vitest';

import {
  TASK_RUNTIME_FAILURE_TEXT,
  TASK_STARTUP_FAILURE_TEXT,
  buildAccountLinkConnectCopy,
  buildAccountLinkPromptText,
  buildAccountLinkThreadReplyText,
  buildOtherRunningTasksText,
  buildPullRequestMergedNotificationText,
  buildPullRequestStatusNotificationText,
  buildRoutingConfirmationText,
  buildSnapshotResumeAcknowledgementText,
  buildTaskLaunchAcknowledgementText,
  buildTaskStartingText,
  buildThreadReplyFooterText,
  getUserRequestedModelDisplayName,
  resolveUserFacingModelDisplayName,
} from '../chat-messages';

describe('chat message copy builders', () => {
  it('builds account-link DM copy from provider and product names', () => {
    expect(
      buildAccountLinkConnectCopy({
        providerName: 'Slack',
        productName: 'Roomote',
      }),
    ).toMatchObject({
      fallbackText: 'Hi! Let me help you get started with Roomote.',
      requirementText:
        'To get started, I need to link your Slack and Roomote accounts.',
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
        productName: 'Roomote',
        accountLinkUrl: 'https://roomote.dev/api/teams/auth?state=abc',
      }),
    ).toBe(
      "I need to link your Microsoft Teams and Roomote accounts before I can start tasks for you.\n\nOpen [this Microsoft Teams link](https://roomote.dev/api/teams/auth?state=abc) and I'll continue your original request after you sign in.",
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
      }),
    ).toBe('Getting started on your task in App');

    expect(
      buildTaskStartingText({
        workspaceDisplayName: 'App',
        modelDisplayName: 'Anthropic Claude Fable 5',
      }),
    ).toBe(
      'Getting started on your task in App using Anthropic Claude Fable 5 as the coding model',
    );

    expect(
      buildTaskStartingText({
        workspaceDisplayName: 'App',
        kickoffMessage:
          'Looking into daily environment snapshots for faster startup in App',
      }),
    ).toBe(
      'Looking into daily environment snapshots for faster startup in App',
    );

    expect(
      buildTaskStartingText({
        workspaceDisplayName: 'App',
        kickoffMessage: 'Checking login redirects in App with Fable 5',
        modelDisplayName: 'Anthropic Claude Fable 5',
      }),
    ).toBe(
      // Model display name missing from the freeform string → safe template
      // fallback keeps env + model override information.
      'Getting started on your task in App using Anthropic Claude Fable 5 as the coding model',
    );

    expect(
      buildTaskStartingText({
        workspaceDisplayName: 'App',
        kickoffMessage:
          'Checking login redirects in App with Anthropic Claude Fable 5',
        modelDisplayName: 'Anthropic Claude Fable 5',
      }),
    ).toBe('Checking login redirects in App with Anthropic Claude Fable 5');

    expect(
      buildTaskStartingText({
        workspaceDisplayName: 'App',
        // Missing env name → fall back to template
        kickoffMessage: 'Looking into environment snapshot checks',
      }),
    ).toBe('Getting started on your task in App');

    expect(
      buildTaskStartingText({
        workspaceDisplayName: 'App',
        kickoffMessage: '<!channel> Looking into auth bugs in App',
      }),
    ).toBe('Looking into auth bugs in App');

    // Substring collision: env "App" must not match inside "authentication".
    expect(
      buildTaskStartingText({
        workspaceDisplayName: 'App',
        kickoffMessage: 'Mapping authentication flows for login',
      }),
    ).toBe('Getting started on your task in App');

    // Multi-word env names still match as a delimited phrase.
    expect(
      buildTaskStartingText({
        workspaceDisplayName: 'Full Stack',
        kickoffMessage: 'Digging into the flaky checkout race in Full Stack',
      }),
    ).toBe('Digging into the flaky checkout race in Full Stack');

    // Reject free-form model claims when no preference model is being shown
    // (e.g. low-confidence router picks that were demoted to the default).
    expect(
      buildTaskStartingText({
        workspaceDisplayName: 'App',
        kickoffMessage: 'Checking login redirects in App with Opus 4.8',
      }),
    ).toBe('Getting started on your task in App');

    expect(
      buildTaskStartingText({
        workspaceDisplayName: 'App',
        kickoffMessage:
          'Checking login redirects in App using Claude as the coding model',
      }),
    ).toBe('Getting started on your task in App');
  });

  it('only returns model names the router treated as an explicit preference', () => {
    expect(
      getUserRequestedModelDisplayName({
        displayName: 'Grok 4.5',
        source: 'default',
      }),
    ).toBeUndefined();

    expect(
      getUserRequestedModelDisplayName({
        displayName: 'Claude Opus 4.8',
        source: 'preserved',
      }),
    ).toBeUndefined();

    expect(
      getUserRequestedModelDisplayName({
        displayName: 'Anthropic Claude Fable 5',
        source: 'preference',
      }),
    ).toBe('Anthropic Claude Fable 5');
  });

  it('clears previous preference names once a non-preference model is resolved', () => {
    expect(
      resolveUserFacingModelDisplayName({
        model: {
          displayName: 'Grok 4.5',
          source: 'default',
        },
        previousDisplayName: 'Anthropic Claude Fable 5',
      }),
    ).toBeUndefined();

    expect(
      resolveUserFacingModelDisplayName({
        model: {
          displayName: 'Anthropic Claude Fable 5',
          source: 'preference',
        },
        previousDisplayName: 'Claude Opus 4.8',
      }),
    ).toBe('Anthropic Claude Fable 5');

    expect(
      resolveUserFacingModelDisplayName({
        previousDisplayName: 'Anthropic Claude Fable 5',
      }),
    ).toBe('Anthropic Claude Fable 5');
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
        taskUrl: 'https://roomote.dev/task/123',
      }),
    ).toBe('Started a task in App: [open task](https://roomote.dev/task/123)');

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
        taskUrl: 'https://roomote.dev/task/123',
      }),
    ).toBe(
      'I found the previous task for this Teams thread and reconnected it here: [the task](https://roomote.dev/task/123).',
    );
  });

  it('builds thread reply footer text with caller link formatting', () => {
    expect(
      buildThreadReplyFooterText({
        taskUrl: 'https://roomote.dev/task/123',
      }),
    ).toBe('_Reply or use the [web app](https://roomote.dev/task/123)._');

    expect(
      buildThreadReplyFooterText({
        taskUrl: 'https://roomote.dev/task/123',
        explicitMentionRequired: true,
      }),
    ).toBe(
      '_Reply with @-mention or use the [web app](https://roomote.dev/task/123)._',
    );

    expect(
      buildThreadReplyFooterText({
        taskUrl: 'https://roomote.dev/task/123',
        linkedPr: {
          prNumber: 7,
          prUrl: 'https://github.com/org/repo/pull/7',
        },
        livePreviewUrl: 'https://preview.roomote.dev',
      }),
    ).toBe(
      '_Working on [PR #7](https://github.com/org/repo/pull/7), [live preview](https://preview.roomote.dev), reply or use the [web app](https://roomote.dev/task/123)._',
    );

    expect(
      buildThreadReplyFooterText({
        taskUrl: 'https://roomote.dev/task/123',
        livePreviewUrl: 'https://preview.roomote.dev',
        formatLink: (label, url) => `<${url}|${label}>`,
      }),
    ).toBe(
      '_Working on a <https://preview.roomote.dev|live preview>, reply or use the <https://roomote.dev/task/123|web app>._',
    );
  });

  it('keeps shared failure copy and PR status copy in one place', () => {
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

    expect(
      buildPullRequestStatusNotificationText({
        prTitle: 'Fix auth',
        prUrl: 'https://github.com/org/repo/pull/1',
        status: 'closed',
        actorLogin: 'matt',
        formatLink: (label, url) => `<${url}|${label}>`,
        formatStatus: (status) => `*${status}*`,
      }),
    ).toEqual({
      text: 'Fix auth was closed by matt',
      bodyText:
        '<https://github.com/org/repo/pull/1|Fix auth> was *closed* by matt',
    });
  });
});
