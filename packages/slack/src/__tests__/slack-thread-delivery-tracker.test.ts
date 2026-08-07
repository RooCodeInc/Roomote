const {
  claimUndeliveredSlackThreadMessagesMock,
  getSlackThreadDisplayNameMock,
  markSlackThreadMessagesDeliveredMock,
  releaseClaimedSlackThreadMessagesMock,
} = vi.hoisted(() => ({
  claimUndeliveredSlackThreadMessagesMock: vi.fn(),
  getSlackThreadDisplayNameMock: vi.fn(
    (message: { user: string; username?: string }) =>
      message.username?.trim() || message.user,
  ),
  markSlackThreadMessagesDeliveredMock: vi.fn(),
  releaseClaimedSlackThreadMessagesMock: vi.fn(),
}));

vi.mock('@roomote/cloud-agents', () => ({
  getSlackThreadDisplayName: getSlackThreadDisplayNameMock,
  wrapSlackMessage: vi.fn(
    (text: string, options?: { ts?: string }) =>
      `<slack_message${options?.ts ? ` ts="${options.ts}"` : ''}>\n${text}\n</slack_message>`,
  ),
  wrapSlackReplyingTo: vi.fn(
    ({
      displayName,
      text,
      ts,
    }: {
      displayName: string;
      text: string;
      ts?: string;
    }) =>
      `<replying_to${ts ? ` ts="${ts}"` : ''}>\n${displayName}: ${text}\n</replying_to>`,
  ),
  wrapSlackTurnPolicy: vi.fn(
    ({
      reactionsAllowed,
      preferEmojiAck,
    }: {
      reactionsAllowed: boolean;
      preferEmojiAck: boolean;
    }) =>
      `<slack_turn_policy reactions_allowed="${reactionsAllowed ? 'true' : 'false'}" prefer_emoji_ack="${preferEmojiAck ? 'true' : 'false'}">\n${reactionsAllowed ? 'Emoji reactions are allowed on the current Slack message. Prefer `send_chat_reaction_emoji` instead of a short text acknowledgement when a lightweight acknowledgement or emoji-only answer is enough.' : 'Emoji reactions are not allowed on the current Slack message. Use `send_chat_reply` or `request_user_input` if this turn needs a visible response.'}\n</slack_turn_policy>`,
  ),
  wrapSlackThreadContext: vi.fn(
    (entries: Array<{ displayName: string; text: string; ts?: string }>) =>
      entries.length === 0
        ? undefined
        : `<thread_context>\n${entries
            .map(
              (entry) =>
                `<slack_thread_message${entry.ts ? ` ts="${entry.ts}"` : ''}>${entry.displayName}: ${entry.text}</slack_thread_message>`,
            )
            .join('\n\n')}\n</thread_context>`,
  ),
}));

vi.mock('../slack-messages', () => ({
  claimUndeliveredSlackThreadMessages: claimUndeliveredSlackThreadMessagesMock,
  markSlackThreadMessagesDelivered: markSlackThreadMessagesDeliveredMock,
  releaseClaimedSlackThreadMessages: releaseClaimedSlackThreadMessagesMock,
}));

import { SlackThreadDeliveryTracker } from '../slack-thread-delivery-tracker';

const FOLLOW_UP_TURN_POLICY =
  '<slack_turn_policy reactions_allowed="true" prefer_emoji_ack="true">\nEmoji reactions are allowed on the current Slack message. Prefer `send_chat_reaction_emoji` instead of a short text acknowledgement when a lightweight acknowledgement or emoji-only answer is enough.\n</slack_turn_policy>';

function withFollowUpTurnPolicy(...blocks: string[]): string {
  const combinedBlocks = blocks.join('\n\n');
  if (!combinedBlocks) {
    return FOLLOW_UP_TURN_POLICY;
  }

  const currentMessageMarker = '\n\n<slack_message';
  const currentMessageIndex = combinedBlocks.lastIndexOf(currentMessageMarker);

  if (currentMessageIndex === -1) {
    return [FOLLOW_UP_TURN_POLICY, combinedBlocks].join('\n\n');
  }

  return [
    combinedBlocks.slice(0, currentMessageIndex),
    FOLLOW_UP_TURN_POLICY,
    combinedBlocks.slice(currentMessageIndex + 2),
  ]
    .filter(Boolean)
    .join('\n\n');
}

describe('SlackThreadDeliveryTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimUndeliveredSlackThreadMessagesMock.mockResolvedValue([]);
    markSlackThreadMessagesDeliveredMock.mockResolvedValue(undefined);
    releaseClaimedSlackThreadMessagesMock.mockResolvedValue(undefined);
  });

  it('commits explicitly tracked timestamps once', async () => {
    const tracker = new SlackThreadDeliveryTracker('C123', '111.000');

    tracker.track('111.000');
    tracker.track('112.000');

    await tracker.commit();

    expect(markSlackThreadMessagesDeliveredMock).toHaveBeenCalledTimes(1);
    expect(markSlackThreadMessagesDeliveredMock).toHaveBeenCalledWith(
      'C123',
      '111.000',
      ['111.000', '112.000'],
    );
  });

  it('deduplicates tracked timestamps and makes a second commit a no-op', async () => {
    const tracker = new SlackThreadDeliveryTracker('C123', '111.000');

    tracker.trackAll(['111.000', '111.000', '112.000']);

    await tracker.commit();
    await tracker.commit();

    expect(markSlackThreadMessagesDeliveredMock).toHaveBeenCalledTimes(1);
    expect(markSlackThreadMessagesDeliveredMock).toHaveBeenCalledWith(
      'C123',
      '111.000',
      ['111.000', '112.000'],
    );
  });

  it('builds a continuation prompt from newly claimed earlier messages and the latest bot reply', async () => {
    claimUndeliveredSlackThreadMessagesMock.mockResolvedValue([
      '109.000',
      '110.000',
    ]);
    const tracker = new SlackThreadDeliveryTracker('C123', '111.000');
    const processMessageFiles = vi
      .fn()
      .mockResolvedValue(['claimed-image-1', 'claimed-image-2']);

    const { claimedImageUris, formattedPrompt } =
      await tracker.buildContinuationPrompt({
        currentMessageTs: '111.000',
        currentMessageText: 'latest question',
        fetchThreadMessages: async () => [
          {
            user: 'U222',
            text: 'Earlier\nthread detail',
            ts: '109.000',
            type: 'message',
          },
          {
            user: 'U111',
            username: 'Alice Example',
            text: 'Earlier thread detail',
            ts: '110.000',
            type: 'message',
          },
          {
            user: 'Ubot',
            username: 'Roomote Bot',
            text: 'older bot reply',
            ts: '110.250',
            type: 'message',
            bot_id: 'B123',
          },
          {
            user: 'Ubot',
            username: 'Roomote Bot',
            text: 'bot reply',
            ts: '110.500',
            type: 'message',
            bot_id: 'B123',
          },
          {
            user: 'U123',
            text: 'latest question',
            ts: '111.000',
            type: 'message',
          },
        ],
        normalizeMessageText: async (text) => text.toUpperCase(),
        processMessageFiles,
        getTrackedBotReply: async () => null,
        botUserId: 'B123',
      });

    tracker.track('111.000');
    await tracker.commit();

    expect(claimUndeliveredSlackThreadMessagesMock).toHaveBeenCalledWith(
      'C123',
      '111.000',
      ['109.000', '110.000'],
    );
    expect(formattedPrompt).toBe(
      withFollowUpTurnPolicy(
        '<thread_context>\n<slack_thread_message ts="109.000">U222: EARLIER\nTHREAD DETAIL</slack_thread_message>\n\n<slack_thread_message ts="110.000">Alice Example: EARLIER THREAD DETAIL</slack_thread_message>\n</thread_context>\n\n<replying_to ts="110.500">\nRoomote Bot: BOT REPLY\n</replying_to>\n\n<slack_message ts="111.000">\nlatest question\n</slack_message>',
      ),
    );
    expect(claimedImageUris).toEqual(['claimed-image-1', 'claimed-image-2']);
    expect(processMessageFiles).toHaveBeenCalledWith([
      expect.objectContaining({
        ts: '109.000',
        text: 'EARLIER\nTHREAD DETAIL',
      }),
      expect.objectContaining({ ts: '110.000', text: 'EARLIER THREAD DETAIL' }),
    ]);
    expect(markSlackThreadMessagesDeliveredMock).toHaveBeenCalledWith(
      'C123',
      '111.000',
      ['109.000', '110.000', '111.000'],
    );
  });

  it('keeps the first visible task reply text-only when no prior bot reply exists', async () => {
    claimUndeliveredSlackThreadMessagesMock.mockResolvedValue([]);
    const tracker = new SlackThreadDeliveryTracker('C123', '111.000');

    const { formattedPrompt, turnPolicy } =
      await tracker.buildContinuationPrompt({
        currentMessageTs: '111.000',
        currentMessageText: 'latest question',
        fetchThreadMessages: async () => [
          {
            user: 'U123',
            text: 'latest question',
            ts: '111.000',
            type: 'message',
          },
        ],
        normalizeMessageText: async (text) => text,
        getTrackedBotReply: async () => null,
        botUserId: 'B123',
      });

    expect(formattedPrompt).toBe(
      '<slack_turn_policy reactions_allowed="false" prefer_emoji_ack="false">\nEmoji reactions are not allowed on the current Slack message. Use `send_chat_reply` or `request_user_input` if this turn needs a visible response.\n</slack_turn_policy>\n\n<slack_message ts="111.000">\nlatest question\n</slack_message>',
    );
    expect(turnPolicy).toEqual({ reactionsAllowed: false });
  });

  it('excludes an explicitly embedded source message from incremental context', async () => {
    claimUndeliveredSlackThreadMessagesMock.mockResolvedValue(['109.000']);
    const tracker = new SlackThreadDeliveryTracker('C123', '108.000');

    const { formattedPrompt } = await tracker.buildContinuationPrompt({
      currentMessageTs: '111.000',
      currentMessageText: 'Act on this\n\nMessage to act on:\nSource message',
      excludedContextTimestamps: ['110.000'],
      fetchThreadMessages: async () => [
        {
          user: 'U111',
          text: 'Earlier context',
          ts: '109.000',
          type: 'message',
        },
        {
          user: 'U123',
          text: 'Source message',
          ts: '110.000',
          type: 'message',
        },
      ],
      normalizeMessageText: async (text) => text,
      getTrackedBotReply: async () => null,
      botUserId: 'B123',
    });

    expect(claimUndeliveredSlackThreadMessagesMock).toHaveBeenCalledWith(
      'C123',
      '108.000',
      ['109.000'],
    );
    expect(formattedPrompt).toContain('Earlier context');
    expect(formattedPrompt).toContain(
      '<slack_message ts="111.000">\nAct on this\n\nMessage to act on:\nSource message\n</slack_message>',
    );
    expect(formattedPrompt).not.toContain(
      '<slack_thread_message ts="110.000">',
    );
  });

  it('ignores the tracked started message when deciding the continuation reply target', async () => {
    claimUndeliveredSlackThreadMessagesMock.mockResolvedValue(['110.750']);
    const tracker = new SlackThreadDeliveryTracker('C123', '111.000');

    const { formattedPrompt, turnPolicy } =
      await tracker.buildContinuationPrompt({
        currentMessageTs: '111.000',
        currentMessageText: 'second follow-up',
        fetchThreadMessages: async () => [
          {
            user: 'U123',
            text: 'first unanswered follow-up',
            ts: '110.750',
            type: 'message',
          },
          {
            user: 'U123',
            text: 'second follow-up',
            ts: '111.000',
            type: 'message',
          },
        ],
        normalizeMessageText: async (text) => text,
        getTrackedBotReply: async () => ({
          ts: '110.500',
          text: 'Queued active task message',
        }),
        botUserId: 'B123',
      });

    expect(formattedPrompt).toBe(
      '<thread_context>\n<slack_thread_message ts="110.750">U123: first unanswered follow-up</slack_thread_message>\n</thread_context>\n\n<slack_turn_policy reactions_allowed="false" prefer_emoji_ack="false">\nEmoji reactions are not allowed on the current Slack message. Use `send_chat_reply` or `request_user_input` if this turn needs a visible response.\n</slack_turn_policy>\n\n<slack_message ts="111.000">\nsecond follow-up\n</slack_message>',
    );
    expect(turnPolicy).toEqual({ reactionsAllowed: false });
  });

  it('keeps continuation reactions allowed when another message intervenes after the bot reply', async () => {
    claimUndeliveredSlackThreadMessagesMock.mockResolvedValue(['110.750']);
    const tracker = new SlackThreadDeliveryTracker('C123', '111.000');

    const { formattedPrompt, turnPolicy } =
      await tracker.buildContinuationPrompt({
        currentMessageTs: '111.000',
        currentMessageText: 'second follow-up',
        fetchThreadMessages: async () => [
          {
            user: 'Ubot',
            username: 'Roomote Bot',
            text: 'bot reply',
            ts: '110.500',
            type: 'message',
            bot_id: 'B123',
          },
          {
            user: 'U123',
            text: 'first unanswered follow-up',
            ts: '110.750',
            type: 'message',
          },
          {
            user: 'U123',
            text: 'second follow-up',
            ts: '111.000',
            type: 'message',
          },
        ],
        normalizeMessageText: async (text) => text,
        getTrackedBotReply: async () => null,
        botUserId: 'B123',
      });

    expect(formattedPrompt).toBe(
      withFollowUpTurnPolicy(
        '<thread_context>\n<slack_thread_message ts="110.750">U123: first unanswered follow-up</slack_thread_message>\n</thread_context>\n\n<replying_to ts="110.500">\nRoomote Bot: bot reply\n</replying_to>\n\n<slack_message ts="111.000">\nsecond follow-up\n</slack_message>',
      ),
    );
    expect(turnPolicy).toEqual({ reactionsAllowed: true });
  });

  it('uses the tracked bot reply when available and skips the fallback scan', async () => {
    claimUndeliveredSlackThreadMessagesMock.mockResolvedValue([
      '109.000',
      '110.000',
      '110.750',
    ]);
    const tracker = new SlackThreadDeliveryTracker('C123', '111.000');

    const { formattedPrompt } = await tracker.buildContinuationPrompt({
      currentMessageTs: '111.000',
      currentMessageText: 'latest question',
      fetchThreadMessages: async () => [
        {
          user: 'U222',
          text: 'Earlier\nthread detail',
          ts: '109.000',
          type: 'message',
        },
        {
          user: 'U111',
          username: 'Alice Example',
          text: 'Earlier thread detail',
          ts: '110.000',
          type: 'message',
        },
        {
          user: 'Ubot',
          username: 'Roomote Bot',
          text: 'tracked bot reply from Slack',
          ts: '110.500',
          type: 'message',
          bot_id: 'B123',
        },
        {
          user: 'Uother',
          username: 'Other Bot',
          text: 'other bot reply',
          ts: '110.750',
          type: 'message',
          bot_id: 'B999',
        },
        {
          user: 'U123',
          text: 'latest question',
          ts: '111.000',
          type: 'message',
        },
      ],
      normalizeMessageText: async (text) => text.toUpperCase(),
      getTrackedBotReply: async () => ({
        ts: '110.500',
        text: 'tracked bot reply',
      }),
      botUserId: 'B123',
    });

    tracker.track('111.000');
    await tracker.commit();

    expect(claimUndeliveredSlackThreadMessagesMock).toHaveBeenCalledWith(
      'C123',
      '111.000',
      ['109.000', '110.000', '110.750'],
    );
    expect(formattedPrompt).toBe(
      withFollowUpTurnPolicy(
        '<thread_context>\n<slack_thread_message ts="109.000">U222: EARLIER\nTHREAD DETAIL</slack_thread_message>\n\n<slack_thread_message ts="110.000">Alice Example: EARLIER THREAD DETAIL</slack_thread_message>\n\n<slack_thread_message ts="110.750">Other Bot: OTHER BOT REPLY</slack_thread_message>\n</thread_context>\n\n<replying_to ts="110.500">\nRoomote Bot: TRACKED BOT REPLY\n</replying_to>\n\n<slack_message ts="111.000">\nlatest question\n</slack_message>',
      ),
    );
    expect(markSlackThreadMessagesDeliveredMock).toHaveBeenCalledWith(
      'C123',
      '111.000',
      ['109.000', '110.000', '110.750', '111.000'],
    );
  });

  it('skips replying_to when Slack and task history are in sync', async () => {
    claimUndeliveredSlackThreadMessagesMock.mockResolvedValue([
      '109.000',
      '110.750',
    ]);
    const tracker = new SlackThreadDeliveryTracker('C123', '111.000');

    const { formattedPrompt } = await tracker.buildContinuationPrompt({
      currentMessageTs: '111.000',
      currentMessageText: 'latest question',
      fetchThreadMessages: async () => [
        {
          user: 'U222',
          text: 'Earlier\nthread detail',
          ts: '109.000',
          type: 'message',
        },
        {
          user: 'Ubot',
          username: 'Roomote Bot',
          text: 'tracked bot reply from Slack',
          ts: '110.500',
          type: 'message',
          bot_id: 'B123',
        },
        {
          user: 'Uother',
          username: 'Other Bot',
          text: 'other bot reply',
          ts: '110.750',
          type: 'message',
          bot_id: 'B999',
        },
        {
          user: 'U123',
          text: 'latest question',
          ts: '111.000',
          type: 'message',
        },
      ],
      normalizeMessageText: async (text) => text.toUpperCase(),
      getTrackedBotReply: async () => ({
        ts: '110.500',
        text: 'tracked bot reply',
      }),
      isSlackDiverged: false,
      botUserId: 'B123',
    });

    tracker.track('111.000');
    await tracker.commit();

    expect(formattedPrompt).toBe(
      withFollowUpTurnPolicy(
        '<thread_context>\n<slack_thread_message ts="109.000">U222: EARLIER\nTHREAD DETAIL</slack_thread_message>\n\n<slack_thread_message ts="110.750">Other Bot: OTHER BOT REPLY</slack_thread_message>\n</thread_context>\n\n<slack_message ts="111.000">\nlatest question\n</slack_message>',
      ),
    );
    expect(claimUndeliveredSlackThreadMessagesMock).toHaveBeenCalledWith(
      'C123',
      '111.000',
      ['109.000', '110.750'],
    );
    expect(markSlackThreadMessagesDeliveredMock).toHaveBeenCalledWith(
      'C123',
      '111.000',
      ['109.000', '110.750', '111.000'],
    );
  });

  it('includes replying_to when Slack has diverged from task history', async () => {
    claimUndeliveredSlackThreadMessagesMock.mockResolvedValue(['109.000']);
    const tracker = new SlackThreadDeliveryTracker('C123', '111.000');

    const { formattedPrompt } = await tracker.buildContinuationPrompt({
      currentMessageTs: '111.000',
      currentMessageText: 'latest question',
      fetchThreadMessages: async () => [
        {
          user: 'U222',
          text: 'Earlier thread detail',
          ts: '109.000',
          type: 'message',
        },
        {
          user: 'Ubot',
          username: 'Roomote Bot',
          text: 'tracked bot reply from Slack',
          ts: '110.500',
          type: 'message',
          bot_id: 'B123',
        },
        {
          user: 'U123',
          text: 'latest question',
          ts: '111.000',
          type: 'message',
        },
      ],
      normalizeMessageText: async (text) => text.toUpperCase(),
      getTrackedBotReply: async () => ({
        ts: '110.500',
        text: 'tracked bot reply',
      }),
      isSlackDiverged: true,
      botUserId: 'B123',
    });

    expect(formattedPrompt).toBe(
      withFollowUpTurnPolicy(
        '<thread_context>\n<slack_thread_message ts="109.000">U222: EARLIER THREAD DETAIL</slack_thread_message>\n</thread_context>\n\n<replying_to ts="110.500">\nRoomote Bot: TRACKED BOT REPLY\n</replying_to>\n\n<slack_message ts="111.000">\nlatest question\n</slack_message>',
      ),
    );
  });

  it('re-surfaces an out-of-band bot notification with real Slack bot identity fields', async () => {
    // Real Slack bot-authored messages carry the installation's bot *user* ID
    // (`U…`) in `user` and an unrelated `B…` ID in `bot_id`. A background PR
    // review notification is also already marked delivered (trackSlackBotReply
    // runs at post time), so it can never be claimed into thread_context — the
    // <replying_to> block is its only route back into the prompt.
    claimUndeliveredSlackThreadMessagesMock.mockResolvedValue([]);
    const tracker = new SlackThreadDeliveryTracker('C123', '111.000');

    const { formattedPrompt } = await tracker.buildContinuationPrompt({
      currentMessageTs: '111.000',
      currentMessageText: 'yes, please fix those',
      fetchThreadMessages: async () => [
        {
          user: 'UBOT123',
          username: 'Roomote Bot',
          text: 'I left two review comments on PR #42',
          ts: '110.500',
          type: 'message',
          bot_id: 'B0APPID',
        },
        {
          user: 'U123',
          text: 'yes, please fix those',
          ts: '111.000',
          type: 'message',
        },
      ],
      normalizeMessageText: async (text) => text,
      getTrackedBotReply: async () => ({
        ts: '110.500',
        text: 'I left two review comments on PR #42',
      }),
      isSlackDiverged: true,
      botUserId: 'UBOT123',
    });

    expect(formattedPrompt).toBe(
      withFollowUpTurnPolicy(
        '<replying_to ts="110.500">\nRoomote Bot: I left two review comments on PR #42\n</replying_to>\n\n<slack_message ts="111.000">\nyes, please fix those\n</slack_message>',
      ),
    );
  });

  it('keeps the previous replying_to behavior when divergence is unspecified', async () => {
    claimUndeliveredSlackThreadMessagesMock.mockResolvedValue(['109.000']);
    const tracker = new SlackThreadDeliveryTracker('C123', '111.000');

    const { formattedPrompt } = await tracker.buildContinuationPrompt({
      currentMessageTs: '111.000',
      currentMessageText: 'latest question',
      fetchThreadMessages: async () => [
        {
          user: 'U222',
          text: 'Earlier thread detail',
          ts: '109.000',
          type: 'message',
        },
        {
          user: 'Ubot',
          username: 'Roomote Bot',
          text: 'tracked bot reply from Slack',
          ts: '110.500',
          type: 'message',
          bot_id: 'B123',
        },
        {
          user: 'U123',
          text: 'latest question',
          ts: '111.000',
          type: 'message',
        },
      ],
      normalizeMessageText: async (text) => text.toUpperCase(),
      getTrackedBotReply: async () => ({
        ts: '110.500',
        text: 'tracked bot reply',
      }),
      botUserId: 'B123',
    });

    expect(formattedPrompt).toBe(
      withFollowUpTurnPolicy(
        '<thread_context>\n<slack_thread_message ts="109.000">U222: EARLIER THREAD DETAIL</slack_thread_message>\n</thread_context>\n\n<replying_to ts="110.500">\nRoomote Bot: TRACKED BOT REPLY\n</replying_to>\n\n<slack_message ts="111.000">\nlatest question\n</slack_message>',
      ),
    );
  });

  it('excludes already delivered bot replies from thread_context while keeping the latest reply target', async () => {
    claimUndeliveredSlackThreadMessagesMock.mockResolvedValue(['109.000']);
    const tracker = new SlackThreadDeliveryTracker('C123', '111.000');

    const { formattedPrompt } = await tracker.buildContinuationPrompt({
      currentMessageTs: '111.000',
      currentMessageText: 'latest question',
      fetchThreadMessages: async () => [
        {
          user: 'U222',
          text: 'Earlier\nthread detail',
          ts: '109.000',
          type: 'message',
        },
        {
          user: 'Ubot',
          username: 'Roomote Bot',
          text: 'already delivered bot reply',
          ts: '110.250',
          type: 'message',
          bot_id: 'B123',
        },
        {
          user: 'Ubot',
          username: 'Roomote Bot',
          text: 'latest bot reply',
          ts: '110.500',
          type: 'message',
          bot_id: 'B123',
        },
        {
          user: 'U123',
          text: 'latest question',
          ts: '111.000',
          type: 'message',
        },
      ],
      normalizeMessageText: async (text) => text.toUpperCase(),
      botUserId: 'B123',
    });

    tracker.track('111.000');
    await tracker.commit();

    expect(claimUndeliveredSlackThreadMessagesMock).toHaveBeenCalledWith(
      'C123',
      '111.000',
      ['109.000'],
    );
    expect(formattedPrompt).toBe(
      withFollowUpTurnPolicy(
        '<thread_context>\n<slack_thread_message ts="109.000">U222: EARLIER\nTHREAD DETAIL</slack_thread_message>\n</thread_context>\n\n<replying_to ts="110.500">\nRoomote Bot: LATEST BOT REPLY\n</replying_to>\n\n<slack_message ts="111.000">\nlatest question\n</slack_message>',
      ),
    );
    expect(markSlackThreadMessagesDeliveredMock).toHaveBeenCalledWith(
      'C123',
      '111.000',
      ['109.000', '111.000'],
    );
  });

  it('returns a continuation prompt when the latest bot reply is the only new context needed', async () => {
    const tracker = new SlackThreadDeliveryTracker('C123', '111.000');

    const { claimedImageUris, formattedPrompt } =
      await tracker.buildContinuationPrompt({
        currentMessageTs: '111.000',
        currentMessageText: 'latest question',
        fetchThreadMessages: async () => [
          {
            user: 'Ubot',
            username: 'Roomote Bot',
            text: 'Which option should I use?',
            ts: '110.000',
            type: 'message',
            bot_id: 'B123',
          },
        ],
        normalizeMessageText: async (text) => text,
        botUserId: 'B123',
      });

    await tracker.commit();

    expect(claimUndeliveredSlackThreadMessagesMock).not.toHaveBeenCalled();
    expect(formattedPrompt).toBe(
      withFollowUpTurnPolicy(
        '<replying_to ts="110.000">\nRoomote Bot: Which option should I use?\n</replying_to>\n\n<slack_message ts="111.000">\nlatest question\n</slack_message>',
      ),
    );
    expect(claimedImageUris).toEqual([]);
    expect(markSlackThreadMessagesDeliveredMock).not.toHaveBeenCalled();
  });

  it('ignores the startup wait notice when choosing fallback bot context', async () => {
    claimUndeliveredSlackThreadMessagesMock.mockResolvedValue(['109.000']);
    const tracker = new SlackThreadDeliveryTracker('C123', '111.000');

    const { formattedPrompt } = await tracker.buildContinuationPrompt({
      currentMessageTs: '111.000',
      currentMessageText: 'latest question',
      fetchThreadMessages: async () => [
        {
          user: 'U111',
          username: 'Alice Example',
          text: 'Earlier thread detail',
          ts: '109.000',
          type: 'message',
        },
        {
          user: 'Ubot',
          username: 'Roomote Bot',
          text: 'Real bot reply',
          ts: '110.000',
          type: 'message',
          bot_id: 'B123',
        },
        {
          user: 'Ubot',
          username: 'Roomote Bot',
          text: "_I'm still starting the task from this thread. Please wait a moment, then send another reply if I still missed it._",
          ts: '110.500',
          type: 'message',
          bot_id: 'B123',
        },
        {
          user: 'U123',
          text: 'latest question',
          ts: '111.000',
          type: 'message',
        },
      ],
      normalizeMessageText: async (text) => text.toUpperCase(),
      getTrackedBotReply: async () => null,
      botUserId: 'B123',
    });

    expect(formattedPrompt).toBe(
      withFollowUpTurnPolicy(
        '<thread_context>\n<slack_thread_message ts="109.000">Alice Example: EARLIER THREAD DETAIL</slack_thread_message>\n</thread_context>\n\n<replying_to ts="110.000">\nRoomote Bot: REAL BOT REPLY\n</replying_to>\n\n<slack_message ts="111.000">\nlatest question\n</slack_message>',
      ),
    );
  });

  it('keeps third-party bot text in thread_context while still claiming our bot file attachments', async () => {
    claimUndeliveredSlackThreadMessagesMock.mockResolvedValue([
      '109.000',
      '110.250',
      '110.400',
    ]);
    const tracker = new SlackThreadDeliveryTracker('C123', '111.000');
    const processMessageFiles = vi.fn().mockResolvedValue(['claimed-image']);

    const { claimedImageUris, formattedPrompt } =
      await tracker.buildContinuationPrompt({
        currentMessageTs: '111.000',
        currentMessageText: 'latest question',
        fetchThreadMessages: async () => [
          {
            user: 'U111',
            username: 'Alice Example',
            text: 'Earlier thread detail',
            ts: '109.000',
            type: 'message',
          },
          {
            user: 'Ubot',
            username: 'Roomote Bot',
            text: 'Getting started on your task in App',
            ts: '110.250',
            type: 'message',
            bot_id: 'B123',
            files: [
              {
                id: 'F-own-bot',
                name: 'proof.png',
                mimetype: 'image/png',
                filetype: 'png',
                url_private: 'https://files.slack.com/F-own-bot',
                url_private_download:
                  'https://files.slack.com/F-own-bot/download',
                size: 1024,
              },
            ],
          },
          {
            user: 'Uci',
            username: 'Deploy Bot',
            text: 'CI passed',
            ts: '110.400',
            type: 'message',
            bot_id: 'B999',
          },
          {
            user: 'Ubot',
            username: 'Roomote Bot',
            text: 'Which option should I use?',
            ts: '110.500',
            type: 'message',
            bot_id: 'B123',
          },
          {
            user: 'U123',
            text: 'latest question',
            ts: '111.000',
            type: 'message',
          },
        ],
        normalizeMessageText: async (text) => text.toUpperCase(),
        processMessageFiles,
        botUserId: 'B123',
      });

    expect(claimUndeliveredSlackThreadMessagesMock).toHaveBeenCalledWith(
      'C123',
      '111.000',
      ['109.000', '110.250', '110.400'],
    );
    expect(processMessageFiles).toHaveBeenCalledWith([
      expect.objectContaining({ ts: '109.000' }),
      expect.objectContaining({
        ts: '110.250',
        text: 'GETTING STARTED ON YOUR TASK IN APP',
        files: [expect.objectContaining({ id: 'F-own-bot' })],
      }),
      expect.objectContaining({ ts: '110.400', text: 'CI PASSED' }),
    ]);
    expect(formattedPrompt).toBe(
      withFollowUpTurnPolicy(
        '<thread_context>\n<slack_thread_message ts="109.000">Alice Example: EARLIER THREAD DETAIL</slack_thread_message>\n\n<slack_thread_message ts="110.400">Deploy Bot: CI PASSED</slack_thread_message>\n</thread_context>\n\n<replying_to ts="110.500">\nRoomote Bot: WHICH OPTION SHOULD I USE?\n</replying_to>\n\n<slack_message ts="111.000">\nlatest question\n</slack_message>',
      ),
    );
    expect(claimedImageUris).toEqual(['claimed-image']);
  });

  it('rolls back claimed timestamps before commit', async () => {
    claimUndeliveredSlackThreadMessagesMock.mockResolvedValue(['110.000']);
    const tracker = new SlackThreadDeliveryTracker('C123', '111.000');

    await tracker.buildContinuationPrompt({
      currentMessageTs: '111.000',
      currentMessageText: 'latest question',
      fetchThreadMessages: async () => [
        {
          user: 'U111',
          text: 'Earlier thread detail',
          ts: '110.000',
          type: 'message',
        },
      ],
      normalizeMessageText: async (text) => text,
    });

    await tracker.rollback();
    await tracker.commit();

    expect(releaseClaimedSlackThreadMessagesMock).toHaveBeenCalledWith(
      'C123',
      '111.000',
      ['110.000'],
    );
    expect(markSlackThreadMessagesDeliveredMock).not.toHaveBeenCalled();
  });

  it('releases claimed timestamps when prompt building fails', async () => {
    claimUndeliveredSlackThreadMessagesMock.mockResolvedValue(['110.000']);
    const consoleErrorMock = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const tracker = new SlackThreadDeliveryTracker('C123', '111.000');

    const { formattedPrompt, turnPolicy } =
      await tracker.buildContinuationPrompt({
        currentMessageTs: '111.000',
        currentMessageText: 'latest question',
        fetchThreadMessages: async () => [
          {
            user: 'U111',
            text: 'Earlier thread detail',
            ts: '110.000',
            type: 'message',
          },
        ],
        normalizeMessageText: async () => {
          throw new Error('normalize failed');
        },
      });

    await tracker.commit();

    expect(formattedPrompt).toBeUndefined();
    expect(turnPolicy).toEqual({ reactionsAllowed: false });
    expect(releaseClaimedSlackThreadMessagesMock).toHaveBeenCalledWith(
      'C123',
      '111.000',
      ['110.000'],
    );
    expect(markSlackThreadMessagesDeliveredMock).not.toHaveBeenCalled();

    consoleErrorMock.mockRestore();
  });

  it('claims image-only earlier messages even when they add no text context', async () => {
    claimUndeliveredSlackThreadMessagesMock.mockResolvedValue(['109.000']);
    const tracker = new SlackThreadDeliveryTracker('C123', '111.000');
    const processMessageFiles = vi.fn().mockResolvedValue(['thread-image']);

    const { claimedImageUris, formattedPrompt } =
      await tracker.buildContinuationPrompt({
        currentMessageTs: '111.000',
        currentMessageText: 'latest question',
        fetchThreadMessages: async () => [
          {
            user: 'U111',
            text: '',
            ts: '109.000',
            type: 'message',
            files: [
              {
                id: 'F-thread',
                name: 'thread.png',
                mimetype: 'image/png',
                filetype: 'png',
                url_private: 'https://files.slack.com/F-thread',
                url_private_download:
                  'https://files.slack.com/F-thread/download',
                size: 1024,
              },
            ],
          },
          {
            user: 'U123',
            text: 'latest question',
            ts: '111.000',
            type: 'message',
          },
        ],
        normalizeMessageText: async (text) => text,
        processMessageFiles,
      });

    tracker.track('111.000');
    await tracker.commit();

    expect(claimUndeliveredSlackThreadMessagesMock).toHaveBeenCalledWith(
      'C123',
      '111.000',
      ['109.000'],
    );
    expect(formattedPrompt).toBe(
      '<slack_turn_policy reactions_allowed="false" prefer_emoji_ack="false">\nEmoji reactions are not allowed on the current Slack message. Use `send_chat_reply` or `request_user_input` if this turn needs a visible response.\n</slack_turn_policy>\n\n<slack_message ts="111.000">\nlatest question\n</slack_message>',
    );
    expect(claimedImageUris).toEqual(['thread-image']);
    expect(processMessageFiles).toHaveBeenCalledWith([
      expect.objectContaining({
        ts: '109.000',
        files: [expect.objectContaining({ id: 'F-thread' })],
      }),
    ]);
    expect(markSlackThreadMessagesDeliveredMock).toHaveBeenCalledWith(
      'C123',
      '111.000',
      ['109.000', '111.000'],
    );
  });
});
