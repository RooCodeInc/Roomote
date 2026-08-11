import {
  ALL_REPOSITORIES,
  TaskPayloadKind,
  buildSlackThreadPermalink,
  type SlackAppMentionTask,
} from '@roomote/types';
import type { ResolvedTaskCommitAuthor } from '../../commit-author';

import { slackAppMention } from '../slackAppMention';
import { standardTask } from '../standardTask';

const expectedGuidance =
  'Prefer one brief sentence that names the main advantage and, when relevant, the main tradeoff or limiting condition.';
const expectedBlockGuidance =
  'progressive `request_user_input` blocks of up to 4 questions each';
const expectedMandatoryBlockGuidance =
  'when several related answers block the same next step, do not ask them as plain conversational questions';
const expectedNoOverallLimit =
  'There is no overall question limit across the task';
const expectedExplorationFirstGuidance =
  'only when the task remains blocked on user input after using available repository, system, and prior conversation context';
const expectedInferenceGuidance =
  'can be discovered or reasonably inferred from repository, system, or prior conversation exploration; state the inference and continue';
const sharedSlackPermalink = buildSlackThreadPermalink({
  slackChannelId: 'C456',
  threadTs: '1776819983.463289',
});
const teamSlackPermalink = buildSlackThreadPermalink({
  slackWorkspaceDomain: 'acme-team',
  slackChannelId: 'C456',
  threadTs: '1776819983.463289',
});
const matchedUserAttribution: ResolvedTaskCommitAuthor = {
  kind: 'user',
  displayName: 'Jane Doe',
  publicDisplayName: null,
  githubLogin: null,
  prAssigneeLogin: null,
  gitAuthor: {
    name: 'Jane Doe',
    email: '1+jane@users.noreply.github.com',
  },
};
const matchedUserAttributionWithAssignee: ResolvedTaskCommitAuthor = {
  ...matchedUserAttribution,
  prAssigneeLogin: 'octocat',
};

describe('request_user_input guidance in workflow prompts', () => {
  it('teaches StandardTask prompts to use progressive request_user_input blocks and write decision-supportive option descriptions', () => {
    const { harnessInstructions } = standardTask({
      description: 'Clarify implementation direction when needed',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
    });

    expect(harnessInstructions).toContain(expectedBlockGuidance);
    expect(harnessInstructions).toContain(expectedMandatoryBlockGuidance);
    expect(harnessInstructions).toContain(expectedNoOverallLimit);
    expect(harnessInstructions).toContain(expectedExplorationFirstGuidance);
    expect(harnessInstructions).toContain(expectedInferenceGuidance);
    expect(harnessInstructions).toContain(expectedGuidance);
    expect(harnessInstructions).toContain(
      'Do not just restate the label or write filler like "Choose this if..." without adding concrete information.',
    );
    expect(harnessInstructions).toContain(
      'Use plain conversational questions only when one lightweight inline clarification is enough',
    );
  });

  it('teaches Slack StandardTask runs to keep lightweight clarification in-thread and reserve request_user_input blocks for structured or private input', async () => {
    const taskSpec: SlackAppMentionTask = {
      type: TaskPayloadKind.SlackAppMention,
      payload: {
        repo: 'Roomote/example-app',
        channel: 'C123',
        user: 'U123',
        text: '@Roomote Should I keep this in Slack?',
        ts: '123.456',
      },
    };

    const result = await slackAppMention({
      taskSpec,
      taskRunUrl: 'https://example.com/task/123',
    });

    expect(result.harnessInstructions).toContain(
      'prefer `send_chat_reply` for lightweight non-secret clarification that fits naturally in-thread',
    );
    expect(result.harnessInstructions).toContain(
      'do not use `request_user_input` unless the next step is still genuinely blocked after using thread context and available tools to resolve the question',
    );
    expect(result.harnessInstructions).toContain(
      'use `request_user_input` in progressive blocks of up to 4 questions',
    );
    expect(result.harnessInstructions).toContain(
      'A Slack-rendered `request_user_input` prompt is supplemental and never satisfies ack or closeout on its own',
    );
  });

  it('attaches the Slack-specific request_user_input guidance to all Slack app mention runs', async () => {
    const taskSpec: SlackAppMentionTask = {
      type: TaskPayloadKind.SlackAppMention,
      payload: {
        repo: 'Roomote/example-app',
        channel: 'C123',
        user: 'U123',
        text: '@Roomote Should I keep this in Slack?',
        ts: '123.456',
      },
    };

    const result = await slackAppMention({
      taskSpec,
      taskRunUrl: 'https://example.com/task/123',
    });

    expect(result.harnessInstructions).toContain(
      'prefer `send_chat_reply` for lightweight non-secret clarification that fits naturally in-thread',
    );
    expect(result.harnessInstructions).toContain(
      'use `request_user_input` in progressive blocks of up to 4 questions',
    );
    expect(result.harnessInstructions).toContain(
      'Pair it with a brief `send_chat_reply` closeout that states what input is needed and that work is paused pending the answer',
    );
  });

  it('routes delivery through create-pr when the deployment prAction is create', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      prAction: 'create',
    });

    expect(harnessInstructions).toContain(
      'must finish through the delegated `create-pr` skill',
    );
    expect(harnessInstructions).not.toContain(
      'must finish through the delegated `create-draft-pr` skill',
    );
  });

  it('routes delivery through push when the deployment prAction is push', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      prAction: 'push',
    });

    expect(harnessInstructions).toContain(
      'must finish through the delegated `push` skill',
    );
    expect(harnessInstructions).not.toContain(
      'must finish through the delegated `create-draft-pr` skill',
    );
  });

  it('defaults delivery to create-draft-pr when no prAction is provided', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
    });

    expect(harnessInstructions).toContain(
      'must finish through the delegated `create-draft-pr` skill',
    );
  });

  it('tells autonomous runs to delegate draft PR delivery instead of inlining gh commands in the parent workflow text', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
    });

    expect(harnessInstructions).toContain(
      'the active `implement-changes` workflow stays responsible for the run until the required delivery result is known and must finish through the delegated `create-draft-pr` skill',
    );
    expect(harnessInstructions).toContain(
      'must not satisfy draft-PR delivery by inlining raw `git`, `git push`, or `gh pr` mechanics here',
    );
    expect(harnessInstructions).toContain(
      'In Autonomous mode, repository-changing runs keep the active `implement-changes` workflow open so that, after implementation and before delivery, any repository-file change transitions into `capture-visual-proof`, then finish through the delegated `create-draft-pr` skill so it owns commit, push, draft-PR create-or-refresh execution, and PR result reporting.',
    );
    expect(harnessInstructions).toContain(
      "If the run later transitions into `fix-pr`, that child skill owns branch push state, any required delegated `capture-visual-proof` handoff before PR metadata refresh, PR metadata refresh itself, and PR-fixer closeout instead of inheriting the parent workflow's default PR-delivery finish.",
    );
    expect(harnessInstructions).toContain(
      'After validation and self-review, the next required action for repository-changing work is delegated delivery, not final reporting.',
    );
    expect(harnessInstructions).toContain(
      'Failed, skipped, or unavailable validation is reviewer-facing context for delegated delivery; it does not replace the required push or pull-request state when the implementation is still the intended shipped diff.',
    );
    expect(harnessInstructions).toContain(
      'A proof no-op, non-applicable result, unnecessary result, or blocker is not a final closeout; it must be carried into delegated delivery when repository files changed and Autonomous mode still requires push or pull-request delivery.',
    );
    expect(harnessInstructions).toContain(
      'Supplemental repo-local skill guidance may refine the current step, but it does not replace unresolved obligations owned by the active parent workflow.',
    );
    expect(harnessInstructions).not.toContain(
      'After validated implementation, finish through the delegated `create-draft-pr` skill',
    );
    expect(harnessInstructions).not.toContain('Create draft PR:');
    expect(harnessInstructions).not.toContain('gh pr create');
    expect(harnessInstructions).not.toContain('--body-file /tmp/pr-body.md');
  });

  it('does not include push-only autonomous delivery instructions by default', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
    });

    expect(harnessInstructions).not.toContain(
      'must finish through the delegated `push` skill',
    );
    expect(harnessInstructions).not.toContain(
      'This is the default finish for every Autonomous run when the configured action is push.',
    );
  });

  it('preserves delegated PR provenance and conflict-label instructions for standard tasks', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      attribution: matchedUserAttribution,
      conflictResolverLabel: 'custom:conflict-label',
    });

    expect(harnessInstructions).toContain(
      'prepend `> &#8203;<!-- roomote:pr-attribution:start -->Opened on behalf of Jane Doe.<!-- roomote:pr-attribution:end --> [View the task](https://example.com/task/123) or mention @',
    );
    expect(harnessInstructions).toContain(
      'for follow-up asks.` at the top of the PR body file before creating or refreshing the pull request',
    );
    expect(harnessInstructions).toContain(
      'must use the conflict resolver label `custom:conflict-label` instead of assuming a hardcoded default',
    );
  });

  it('passes linked GitHub assignee instructions through to delegated PR delivery when available', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      attribution: matchedUserAttributionWithAssignee,
    });

    expect(harnessInstructions).toContain(
      "because the creating user has linked GitHub login `octocat`, the delegated PR-delivery skill must pass `assignees: ['octocat']` in its `mcp__roomote__manage_source_control` calls so the created or refreshed pull request is assigned to that user when the provider supports it",
    );
  });

  it('uses a Slack conversation link for Slack-launched PR follow-up instructions when thread metadata is available', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      attribution: matchedUserAttribution,
      taskSurface: 'slack',
      slackChannel: 'C456',
      slackThreadTs: '1776819983.463289',
    });

    expect(harnessInstructions).toContain(
      `prepend \`> &#8203;<!-- roomote:pr-attribution:start -->Opened on behalf of Jane Doe.<!-- roomote:pr-attribution:end --> Follow up by mentioning @roomote, in [the web UI](https://example.com/task/123), or in [Slack](${sharedSlackPermalink}).\` at the top of the PR body file before creating or refreshing the pull request`,
    );
  });

  it('does not mention Slack when a Slack-launched PR has no conversation permalink', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      attribution: matchedUserAttribution,
      taskSurface: 'slack',
    });

    expect(harnessInstructions).toContain(
      'prepend `> &#8203;<!-- roomote:pr-attribution:start -->Opened on behalf of Jane Doe.<!-- roomote:pr-attribution:end --> Follow up by mentioning @roomote or in [the web UI](https://example.com/task/123).` at the top of the PR body file before creating or refreshing the pull request',
    );
  });

  it('still mentions Slack when channel and thread metadata exist without any team-domain lookup', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      attribution: matchedUserAttribution,
      taskSurface: 'slack',
      slackChannel: 'C456',
      slackThreadTs: '1776819983.463289',
    });

    expect(harnessInstructions).toContain(
      `prepend \`> &#8203;<!-- roomote:pr-attribution:start -->Opened on behalf of Jane Doe.<!-- roomote:pr-attribution:end --> Follow up by mentioning @roomote, in [the web UI](https://example.com/task/123), or in [Slack](${sharedSlackPermalink}).\` at the top of the PR body file before creating or refreshing the pull request`,
    );
  });

  it('uses the Slack team domain for follow-up instructions when available', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      attribution: matchedUserAttribution,
      taskSurface: 'slack',
      slackTeamDomain: 'acme-team',
      slackChannel: 'C456',
      slackThreadTs: '1776819983.463289',
    });

    expect(harnessInstructions).toContain(
      `prepend \`> &#8203;<!-- roomote:pr-attribution:start -->Opened on behalf of Jane Doe.<!-- roomote:pr-attribution:end --> Follow up by mentioning @roomote, in [the web UI](https://example.com/task/123), or in [Slack](${teamSlackPermalink}).\` at the top of the PR body file before creating or refreshing the pull request`,
    );
  });

  it('uses a Telegram conversation link for Telegram-launched PR follow-up instructions', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      attribution: matchedUserAttribution,
      taskSurface: 'telegram',
      telegramChatId: '-100456789',
      telegramThreadId: '7',
      telegramMessageId: '42',
    });

    expect(harnessInstructions).toContain(
      'prepend `> &#8203;<!-- roomote:pr-attribution:start -->Opened on behalf of Jane Doe.<!-- roomote:pr-attribution:end --> Follow up by mentioning @roomote, in [the web UI](https://example.com/task/123), or in [Telegram](https://t.me/c/456789/7/42).` at the top of the PR body file before creating or refreshing the pull request',
    );
  });

  it('falls back to the Telegram bot DM link when the chat is a personal/bot DM', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      attribution: matchedUserAttribution,
      taskSurface: 'telegram',
      telegramChatId: '9876543',
      telegramMessageId: '42',
      telegramBotUsername: 'roomote_bot',
    });

    expect(harnessInstructions).toContain(
      'prepend `> &#8203;<!-- roomote:pr-attribution:start -->Opened on behalf of Jane Doe.<!-- roomote:pr-attribution:end --> Follow up by mentioning @roomote, in [the web UI](https://example.com/task/123), or in [Telegram](https://t.me/roomote_bot).` at the top of the PR body file before creating or refreshing the pull request',
    );
  });

  it('omits Telegram when a Telegram-launched PR has no deep-linkable chat id and no bot username', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      attribution: matchedUserAttribution,
      taskSurface: 'telegram',
      telegramChatId: '9876543',
      telegramMessageId: '42',
    });

    expect(harnessInstructions).toContain(
      'prepend `> &#8203;<!-- roomote:pr-attribution:start -->Opened on behalf of Jane Doe.<!-- roomote:pr-attribution:end --> Follow up by mentioning @roomote or in [the web UI](https://example.com/task/123).` at the top of the PR body file before creating or refreshing the pull request',
    );
  });

  it('uses a Teams conversation link for Teams-launched PR follow-up instructions', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      attribution: matchedUserAttribution,
      taskSurface: 'teams',
      teamsConversationId: '19:channel@thread.v2',
      teamsMessageId: '1647012345678',
      teamsTenantId: 'tenant-abc',
    });

    expect(harnessInstructions).toContain(
      'prepend `> &#8203;<!-- roomote:pr-attribution:start -->Opened on behalf of Jane Doe.<!-- roomote:pr-attribution:end --> Follow up by mentioning @roomote, in [the web UI](https://example.com/task/123), or in [Teams](https://teams.microsoft.com/l/message/19%3Achannel%40thread.v2/1647012345678?tenantId=tenant-abc).` at the top of the PR body file before creating or refreshing the pull request',
    );
  });

  it('falls back to the Teams bot personal-app link for personal (a:) conversations', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      attribution: matchedUserAttribution,
      taskSurface: 'teams',
      teamsConversationId: 'a:personal-conversation',
      teamsMessageId: 'activity-2',
      teamsTenantId: 'tenant-abc',
      teamsBotAppId: 'bot-app-id',
    });

    expect(harnessInstructions).toContain(
      'prepend `> &#8203;<!-- roomote:pr-attribution:start -->Opened on behalf of Jane Doe.<!-- roomote:pr-attribution:end --> Follow up by mentioning @roomote, in [the web UI](https://example.com/task/123), or in [Teams](https://teams.microsoft.com/l/app/bot-app-id?tenantId=tenant-abc).` at the top of the PR body file before creating or refreshing the pull request',
    );
  });

  it('omits Teams when a Teams-launched personal chat has no bot app id', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      attribution: matchedUserAttribution,
      taskSurface: 'teams',
      teamsConversationId: 'a:personal-conversation',
      teamsMessageId: 'activity-2',
    });

    expect(harnessInstructions).toContain(
      'prepend `> &#8203;<!-- roomote:pr-attribution:start -->Opened on behalf of Jane Doe.<!-- roomote:pr-attribution:end --> Follow up by mentioning @roomote or in [the web UI](https://example.com/task/123).` at the top of the PR body file before creating or refreshing the pull request',
    );
  });

  it('omits Teams when a Teams-launched PR has no conversation or message id', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      attribution: matchedUserAttribution,
      taskSurface: 'teams',
    });

    expect(harnessInstructions).toContain(
      'prepend `> &#8203;<!-- roomote:pr-attribution:start -->Opened on behalf of Jane Doe.<!-- roomote:pr-attribution:end --> Follow up by mentioning @roomote or in [the web UI](https://example.com/task/123).` at the top of the PR body file before creating or refreshing the pull request',
    );
  });

  it('passes pre-rendered linked work item instructions through to delegated PR delivery when available', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      linkedWorkItems: [
        {
          provider: 'linear',
          identifier: 'ENG-123',
        },
        {
          provider: 'github',
          identifier: '456',
          repository: 'Roomote/example-app',
        },
      ],
    });

    expect(harnessInstructions).toContain('<pr_linked_work_items>');
    expect(harnessInstructions).toContain(
      'include the pre-rendered linked-work-item block verbatim in the PR body',
    );
    expect(harnessInstructions).toContain(
      '<rendered_block>## Linked work items\n\nCloses ENG-123\nCloses Roomote/example-app#456</rendered_block>',
    );
  });

  it('omits delegated conflict-label instructions when no label is provided', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
      attribution: matchedUserAttribution,
    });

    expect(harnessInstructions).toContain(
      'prepend `> &#8203;<!-- roomote:pr-attribution:start -->Opened on behalf of Jane Doe.<!-- roomote:pr-attribution:end --> [View the task](https://example.com/task/123) or mention @',
    );
    expect(harnessInstructions).toContain(
      'for follow-up asks.` at the top of the PR body file before creating or refreshing the pull request',
    );
    expect(harnessInstructions).not.toContain(
      'must use the conflict resolver label',
    );
    expect(harnessInstructions).not.toContain('roomote:auto-resolve-conflicts');
    expect(harnessInstructions).not.toContain('--add-assignee');
  });

  it('preserves delegated task-link instructions even when username is missing', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      taskRunUrl: 'https://example.com/task/123',
    });

    expect(harnessInstructions).toContain(
      'prepend `> &#8203;<!-- roomote:pr-attribution:start -->Created by Roomote.<!-- roomote:pr-attribution:end --> [View the task](https://example.com/task/123) or mention @',
    );
    expect(harnessInstructions).toContain(
      'for follow-up asks.` at the top of the PR body file before creating or refreshing the pull request',
    );
  });

  it('injects source-control provider context when the provider is known', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'group/example-app',
      sourceControlProvider: 'gitlab',
    });

    expect(harnessInstructions).toContain('<source_control_context>');
    expect(harnessInstructions).toContain(
      'The task repositories are hosted on GitLab.',
    );
    expect(harnessInstructions).toContain(
      'Pull request and merge request creation or refresh goes through the Roomote MCP `manage_source_control` tool, which resolves this provider server-side.',
    );
    expect(harnessInstructions).toContain(
      'GitHub-only CLI commands such as `gh pr` and `gh api` cannot operate on GitLab repositories; use local git state and the Roomote MCP tools instead.',
    );
  });

  it('keeps the GitHub provider context free of the non-GitHub CLI warning', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      sourceControlProvider: 'github',
    });

    expect(harnessInstructions).toContain(
      'The task repositories are hosted on GitHub.',
    );
    expect(harnessInstructions).not.toContain('cannot operate on');
  });

  it('omits source-control context when no provider is supplied', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
    });

    expect(harnessInstructions).not.toContain('<source_control_context>');
  });

  it('keeps workspace-root repository guidance free of inline gh pr mechanics', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: ALL_REPOSITORIES,
      repoFullNames: ['Roomote/example-app'],
      conflictResolverLabel: 'custom:conflict-label',
    });

    expect(harnessInstructions).toContain(
      'target `Roomote/example-app` as the repository identifier when a delegated PR-delivery skill asks for the repository',
    );
    expect(harnessInstructions).not.toContain('gh pr create --repo');
    expect(harnessInstructions).not.toContain('roomote:auto-resolve-conflicts');
  });

  it('keeps shared-root workspace guidance for multi-repo environment tasks scoped to one repo', () => {
    const { harnessInstructions } = standardTask({
      description: 'Implement a repository change',
      repo: 'Roomote/example-app',
      repoFullNames: ['Roomote/example-app', 'Roomote/controller'],
    });

    expect(harnessInstructions).toContain(
      '<repository>Roomote/example-app</repository>',
    );
    expect(harnessInstructions).toContain(
      'Use the workspace root as your base directory for operations',
    );
    expect(harnessInstructions).toContain('Available repositories:');
    expect(harnessInstructions).not.toContain(
      '<workspace_context>Single repository workspace.</workspace_context>',
    );
  });
});
