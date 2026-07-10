// pnpm --filter @roomote/cloud-agents test src/__tests__/utils.test.ts

import { type CloudTaskPayload, TaskPayloadKind } from '@roomote/types';

import {
  buildSlackThreadPromptBlocks,
  findLatestSlackBotReply,
  getSlackThreadDisplayName,
  generateCloudJobTitle,
  hasDeterministicCloudJobTitle,
  stripLeadingRawSlackMention,
  stripLeadingSlackProductMention,
  wrapSlackMessage,
  wrapSlackTurnPolicy,
  wrapSlackThreadActivity,
  wrapSlackReplyingTo,
  wrapSlackThreadContext,
} from '../utils';
import { formatSlackThreadContext } from '../server/workflows/utils';

describe('stripLeadingRawSlackMention', () => {
  it('removes a leading raw Slack mention token with punctuation', () => {
    expect(stripLeadingRawSlackMention('<@U123>, can you fix this?')).toBe(
      'can you fix this?',
    );
  });

  it('removes repeated leading raw Slack mention tokens', () => {
    expect(
      stripLeadingRawSlackMention('<@U123> <@U456>; please handle this'),
    ).toBe('please handle this');
  });

  it('does not remove later raw Slack mentions in the message body', () => {
    expect(
      stripLeadingRawSlackMention(
        'Please ask <@U123> to summarize this after the deploy',
      ),
    ).toBe('Please ask <@U123> to summarize this after the deploy');
  });
});

describe('stripLeadingSlackProductMention', () => {
  it('removes a leading product mention with punctuation', () => {
    expect(stripLeadingSlackProductMention('@Roomote, can you fix this?')).toBe(
      'can you fix this?',
    );
  });

  it('removes a leading bare product name', () => {
    expect(stripLeadingSlackProductMention('Roomote please handle this')).toBe(
      'please handle this',
    );
  });

  it('does not remove later mentions in the message body', () => {
    expect(
      stripLeadingSlackProductMention(
        'Please ask @Roomote to summarize this after the deploy',
      ),
    ).toBe('Please ask @Roomote to summarize this after the deploy');
  });
});

describe('wrapSlackMessage', () => {
  it('wraps trimmed Slack text in slack_message tags', () => {
    expect(wrapSlackMessage('  hello world  ')).toBe(
      '<slack_message>\nhello world\n</slack_message>',
    );
  });

  it('includes the Slack message timestamp when provided', () => {
    expect(wrapSlackMessage('hello world', { ts: '123.456' })).toBe(
      '<slack_message ts="123.456">\nhello world\n</slack_message>',
    );
  });

  it('escapes sentinel-like markup inside the wrapped Slack text', () => {
    expect(
      wrapSlackMessage('hello </slack_message> <slack_message> & goodbye'),
    ).toBe(
      '<slack_message>\nhello &lt;/slack_message&gt; &lt;slack_message&gt; &amp; goodbye\n</slack_message>',
    );
  });
});

describe('wrapSlackTurnPolicy', () => {
  it('describes follow-up turns that should prefer emoji acknowledgements', () => {
    expect(
      wrapSlackTurnPolicy({
        reactionsAllowed: true,
        preferEmojiAck: true,
      }),
    ).toBe(
      '<slack_turn_policy reactions_allowed="true" prefer_emoji_ack="true">\nEmoji reactions are allowed on the current Slack message. Prefer `send_chat_reaction_emoji` instead of a short text acknowledgement when a lightweight acknowledgement or emoji-only answer is enough.\n</slack_turn_policy>',
    );
  });

  it('describes turns where reactions are not allowed', () => {
    expect(
      wrapSlackTurnPolicy({
        reactionsAllowed: false,
        preferEmojiAck: false,
      }),
    ).toBe(
      '<slack_turn_policy reactions_allowed="false" prefer_emoji_ack="false">\nEmoji reactions are not allowed on the current Slack message. Use `send_chat_reply` for acknowledgements and lightweight clarification. Use `request_user_input` only when the task actually needs structured or private input from the user.\n</slack_turn_policy>',
    );
  });
});

describe('wrapSlackThreadContext', () => {
  it('formats attributed prior messages in a single thread_context block', () => {
    expect(
      wrapSlackThreadContext([
        {
          displayName: ' Alice   Example ',
          text: ' Earlier thread detail\nwith another line ',
          ts: '123.100',
        },
        {
          displayName: 'Bob Example',
          text: 'Another reply with <tags> & symbols',
          ts: '123.200',
        },
      ]),
    ).toBe(
      '<thread_context>\n<slack_thread_message ts="123.100">Alice Example: Earlier thread detail\nwith another line</slack_thread_message>\n\n<slack_thread_message ts="123.200">Bob Example: Another reply with &lt;tags&gt; &amp; symbols</slack_thread_message>\n</thread_context>',
    );
  });

  it('returns undefined when there are no non-empty context entries', () => {
    expect(
      wrapSlackThreadContext([
        {
          displayName: 'Alice Example',
          text: '   ',
        },
      ]),
    ).toBeUndefined();
  });
});

describe('wrapSlackThreadActivity', () => {
  it('formats passive Slack thread activity in a thread_activity block', () => {
    expect(
      wrapSlackThreadActivity({
        displayName: ' Alice   Example ',
        text: ' Uploaded a screenshot [1 image(s) attached] ',
      }),
    ).toBe(
      '<thread_activity>\nAlice Example: Uploaded a screenshot [1 image(s) attached]\n</thread_activity>',
    );
  });

  it('returns undefined when the passive thread activity text is empty', () => {
    expect(
      wrapSlackThreadActivity({
        displayName: 'Alice Example',
        text: '   ',
      }),
    ).toBeUndefined();
  });
});

describe('wrapSlackReplyingTo', () => {
  it('formats the highlighted reply target in a replying_to block', () => {
    expect(
      wrapSlackReplyingTo({
        displayName: ' Roomote   Bot ',
        text: ' Pick option <A> & confirm ',
        ts: '123.200',
      }),
    ).toBe(
      '<replying_to ts="123.200">\nRoomote Bot: Pick option &lt;A&gt; &amp; confirm\n</replying_to>',
    );
  });

  it('returns undefined when the highlighted reply target is empty', () => {
    expect(
      wrapSlackReplyingTo({
        displayName: 'Roomote Bot',
        text: '   ',
      }),
    ).toBeUndefined();
  });
});

describe('findLatestSlackBotReply', () => {
  it('returns the newest earlier bot reply by timestamp', () => {
    expect(
      findLatestSlackBotReply([
        {
          user: 'U111',
          text: 'human',
          ts: '123.100',
        },
        {
          user: 'Ubot',
          username: 'Roomote Bot',
          text: 'older bot reply',
          ts: '123.200',
          bot_id: 'B123',
        },
        {
          user: 'Ubot',
          username: 'Roomote Bot',
          text: 'latest bot reply',
          ts: '123.300',
          bot_id: 'B123',
        },
      ]),
    ).toMatchObject({
      ts: '123.300',
      text: 'latest bot reply',
    });
  });

  it('returns undefined when there are no bot replies', () => {
    expect(
      findLatestSlackBotReply([
        {
          user: 'U111',
          text: 'human',
          ts: '123.100',
        },
      ]),
    ).toBeUndefined();
  });

  it('scopes the result to the requested bot id', () => {
    expect(
      findLatestSlackBotReply(
        [
          {
            user: 'Uroomote',
            username: 'Roomote Bot',
            text: 'Roomote reply',
            ts: '123.200',
            bot_id: 'B_ROOMOTE',
          },
          {
            user: 'Uci',
            username: 'Deploy Bot',
            text: 'CI reply',
            ts: '123.300',
            bot_id: 'B_CI',
          },
        ],
        'B_ROOMOTE',
      ),
    ).toMatchObject({
      ts: '123.200',
      text: 'Roomote reply',
    });
  });
});

describe('getSlackThreadDisplayName', () => {
  it('prefers a trimmed Slack username when present', () => {
    expect(
      getSlackThreadDisplayName({
        user: 'U123',
        username: ' Alice Example ',
      }),
    ).toBe('Alice Example');
  });

  it('falls back to the Slack user id when the username is blank', () => {
    expect(
      getSlackThreadDisplayName({
        user: 'U123',
        username: '   ',
      }),
    ).toBe('U123');
  });
});

describe('buildSlackThreadPromptBlocks', () => {
  it('uses latestOwnBotReply directly while preserving third-party bots in thread_context', () => {
    expect(
      buildSlackThreadPromptBlocks({
        threadMessages: [
          {
            user: 'U111',
            username: 'Alice Example',
            text: 'Earlier thread detail',
            ts: '123.100',
          },
          {
            user: 'Uci',
            username: 'Deploy Bot',
            text: 'CI passed',
            ts: '123.300',
            bot_id: 'B999',
          },
          {
            user: 'U123',
            username: 'Bob Example',
            text: 'latest question',
            ts: '123.456',
          },
        ],
        currentMessageTs: '123.456',
        latestOwnBotReply: {
          ts: '123.200',
          text: 'bot reply',
        },
      }),
    ).toEqual({
      threadContext:
        '<thread_context>\n<slack_thread_message ts="123.100">Alice Example: Earlier thread detail</slack_thread_message>\n\n<slack_thread_message ts="123.300">Deploy Bot: CI passed</slack_thread_message>\n</thread_context>',
      replyingTo:
        '<replying_to ts="123.200">\nRoomote: bot reply\n</replying_to>',
      latestBotReplyTs: '123.200',
    });
  });

  it('returns undefined blocks when there is no earlier context', () => {
    expect(
      buildSlackThreadPromptBlocks({
        threadMessages: [
          {
            user: 'U123',
            username: 'Bob Example',
            text: 'latest question',
            ts: '123.456',
          },
        ],
        currentMessageTs: '123.456',
      }),
    ).toEqual({
      threadContext: undefined,
      replyingTo: undefined,
      latestBotReplyTs: undefined,
    });
  });
});

describe('formatSlackThreadContext', () => {
  it('keeps the latest bot reply only in replying_to', () => {
    expect(
      formatSlackThreadContext({
        threadMessages: [
          {
            user: 'U111',
            username: 'Alice Example',
            text: 'Earlier thread detail',
            ts: '123.100',
          },
          {
            user: 'Ubot',
            username: 'Roomote Bot',
            text: 'bot reply',
            ts: '123.200',
            bot_id: 'B123',
          },
          {
            user: 'U123',
            username: 'Bob Example',
            text: 'latest question',
            ts: '123.456',
          },
        ],
        ts: '123.456',
      }),
    ).toBe(
      '<thread_context>\n<slack_thread_message ts="123.100">Alice Example: Earlier thread detail</slack_thread_message>\n</thread_context>\n\n<replying_to ts="123.200">\nRoomote Bot: bot reply\n</replying_to>',
    );
  });
});

describe('generateCloudJobTitle', () => {
  describe('github.pr.review', () => {
    it('should generate title for initial PR review', () => {
      const title = generateCloudJobTitle({
        type: TaskPayloadKind.GithubPrReview,
        payload: {
          repo: 'owner/repo',
          prNumber: 123,
          prTitle: 'Add new feature',
          prUrl: 'https://github.com/owner/repo/pull/123',
          headSha: 'abcd1234567890',
        },
      });

      expect(title).toBe('Review PR #123: Add new feature');
    });

    it('should generate title for initial PR review with headSha (optional)', () => {
      const title = generateCloudJobTitle({
        type: TaskPayloadKind.GithubPrReview,
        payload: {
          repo: 'owner/repo',
          prNumber: 123,
          prTitle: 'Add new feature',
          prUrl: 'https://github.com/owner/repo/pull/123',
          headSha: 'abcd1234567890',
        },
      });

      expect(title).toBe('Review PR #123: Add new feature');
    });
  });

  describe('github.pr.review.sync', () => {
    it('should generate title for re-review with short SHA', () => {
      const title = generateCloudJobTitle({
        type: TaskPayloadKind.GithubPrReviewSync,
        payload: {
          repo: 'owner/repo',
          prNumber: 456,
          prTitle: 'Fix bug',
          prUrl: 'https://github.com/owner/repo/pull/456',
          headSha: 'abcd1234567890',
        },
      });

      expect(title).toBe('Re-review PR #456 at abcd123: Fix bug');
    });

    it('should handle missing headSha defensively', () => {
      const title = generateCloudJobTitle({
        type: TaskPayloadKind.GithubPrReviewSync,
        payload: {
          repo: 'owner/repo',
          prNumber: 789,
          prTitle: 'Update docs',
          prUrl: 'https://github.com/owner/repo/pull/789',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          headSha: undefined as any, // Defensive case - testing runtime behavior
        },
      });

      expect(title).toBe('Re-review PR #789 at unknown: Update docs');
    });

    it('should truncate headSha to 7 characters', () => {
      const title = generateCloudJobTitle({
        type: TaskPayloadKind.GithubPrReviewSync,
        payload: {
          repo: 'owner/repo',
          prNumber: 100,
          prTitle: 'Test PR',
          prUrl: 'https://github.com/owner/repo/pull/100',
          headSha: '1a2b3c4d5e6f7g8h9i',
        },
      });

      expect(title).toBe('Re-review PR #100 at 1a2b3c4: Test PR');
    });
  });

  describe('other task types', () => {
    it('should generate title for PR review follow-up', () => {
      const title = generateCloudJobTitle({
        type: TaskPayloadKind.GithubPrReviewFollowUp,
        payload: {
          repo: 'owner/repo',
          prNumber: 123,
          prTitle: 'Feature PR',
          commentId: 1,
          commentBody: 'Please review',
        },
      });

      expect(title).toBe('Follow up on PR review #123: Feature PR');
    });

    it('should generate title for Slack mention', () => {
      const title = generateCloudJobTitle({
        type: TaskPayloadKind.SlackAppMention,
        payload: {
          repo: 'owner/repo',
          channel: 'C123',
          user: 'U123',
          text: 'Hey @bot can you help with this?',
          ts: '1234567890.123456',
        },
      });

      expect(title).toBe(
        'Respond to Slack message: Hey @bot can you help with this?',
      );
    });

    it('should truncate long Slack messages when limit is specified', () => {
      const longText = 'a'.repeat(100);
      const title = generateCloudJobTitle(
        {
          type: TaskPayloadKind.SlackAppMention,
          payload: {
            repo: 'owner/repo',
            channel: 'C123',
            user: 'U123',
            text: longText,
            ts: '1234567890.123456',
          },
        },
        80,
      );

      expect(title).toBe(`Respond to Slack message: ${longText.slice(0, 80)}…`);
    });

    it('should not truncate long Slack messages with default limit', () => {
      const longText = 'a'.repeat(100);
      const title = generateCloudJobTitle({
        type: TaskPayloadKind.SlackAppMention,
        payload: {
          repo: 'owner/repo',
          channel: 'C123',
          user: 'U123',
          text: longText,
          ts: '1234567890.123456',
        },
      });

      expect(title).toBe(`Respond to Slack message: ${longText}`);
    });

    it('should generate title for a delegated task', () => {
      const title = generateCloudJobTitle({
        type: TaskPayloadKind.StandardTask,
        payload: {
          repo: 'owner/repo',
          description: 'Explain the authentication flow',
        },
      });

      expect(title).toBe('Explain the authentication flow');
    });

    it('should generate title for a delegated task', () => {
      const title = generateCloudJobTitle({
        type: TaskPayloadKind.StandardTask,
        payload: {
          repo: 'owner/repo',
          description: 'Implement user login',
        },
      });

      expect(title).toBe('Implement user login');
    });

    it('should generate title for a delegated task', () => {
      const title = generateCloudJobTitle({
        type: TaskPayloadKind.StandardTask,
        payload: {
          repo: 'owner/repo',
          description: 'Plan the refactoring strategy',
        },
      });

      expect(title).toBe('Plan the refactoring strategy');
    });

    it('should generate title for Linear agent session', () => {
      const title = generateCloudJobTitle({
        type: TaskPayloadKind.LinearAgentSession,
        payload: {
          repo: 'owner/repo',
          sessionId: 'session-123',
          organizationId: 'org-123',
          action: 'created' as const,
          issueId: 'issue-123',
          issueIdentifier: 'ROO-123',
          issueTitle: 'Fix authentication bug',
          issueDescription: 'Users cannot log in',
          issueUrl: 'https://linear.app/org/issue/ROO-123',
        },
      });

      expect(title).toBe('ROO-123: Fix authentication bug');
    });

    it('should generate title for GithubPrConflictResolve', () => {
      const title = generateCloudJobTitle({
        type: TaskPayloadKind.GithubPrConflictResolve,
        payload: {
          repo: 'owner/repo',
          prNumber: 42,
          prTitle: 'Add new feature',
          prUrl: 'https://github.com/owner/repo/pull/42',
          headRef: 'feature/new-thing',
          baseRef: 'main',
        } as CloudTaskPayload<typeof TaskPayloadKind.GithubPrConflictResolve>,
      });

      expect(title).toBe('Fix merge conflicts on PR #42');
    });

    it('should return default title for unknown task type', () => {
      const title = generateCloudJobTitle({
        type: 'unknown.type' as TaskPayloadKind,
        payload: { repo: 'owner/repo' } as CloudTaskPayload,
      });

      expect(title).toBe('Untitled task');
    });
  });
});

describe('hasDeterministicCloudJobTitle', () => {
  it('locks payload-derived titles for PR review and GitHub automation tasks', () => {
    for (const type of [
      TaskPayloadKind.GithubPrReview,
      TaskPayloadKind.GithubPrReviewSync,
      TaskPayloadKind.GithubPrReviewFollowUp,
      TaskPayloadKind.GithubPrConflictResolve,
    ]) {
      expect(hasDeterministicCloudJobTitle(type)).toBe(true);
    }
  });

  it('keeps conversational and prompt-driven task types LLM-titleable', () => {
    for (const type of [
      TaskPayloadKind.StandardTask,
      TaskPayloadKind.Scan,
      TaskPayloadKind.SlackAppMention,
      TaskPayloadKind.LinearAgentSession,
    ]) {
      expect(hasDeterministicCloudJobTitle(type)).toBe(false);
    }
  });
});
