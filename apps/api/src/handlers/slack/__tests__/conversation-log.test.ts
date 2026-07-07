import {
  getInboundSlackConversationSource,
  shouldRecordInboundSlackConversationMessage,
} from '../helpers/conversation-log';

describe('Slack conversation log helpers', () => {
  it('does not record fresh threaded app mentions when the thread is not Roomote-owned', () => {
    expect(
      shouldRecordInboundSlackConversationMessage(
        {
          type: 'app_mention',
          channel: 'C123',
          channel_type: 'channel',
          user: 'U123',
          text: '<@BOT> can you take this thread?',
          ts: '111.222',
          thread_ts: '111.000',
        },
        false,
      ),
    ).toBe(false);
  });

  it('records threaded replies only when the thread is Roomote-owned or active', () => {
    expect(
      shouldRecordInboundSlackConversationMessage(
        {
          type: 'message',
          channel: 'C123',
          channel_type: 'channel',
          user: 'U123',
          text: 'follow-up',
          ts: '111.223',
          thread_ts: '111.000',
        },
        true,
      ),
    ).toBe(true);
  });

  it('records top-level DMs as inbound conversation history', () => {
    expect(
      shouldRecordInboundSlackConversationMessage(
        {
          type: 'message',
          channel: 'D123',
          channel_type: 'im',
          user: 'U123',
          text: 'hey roomote',
          ts: '111.224',
        },
        false,
      ),
    ).toBe(true);
  });

  it('classifies top-level DMs separately from threaded replies', () => {
    expect(
      getInboundSlackConversationSource({
        type: 'message',
        channel: 'D123',
        channel_type: 'im',
        user: 'U123',
        text: 'hey roomote',
        ts: '111.224',
      }),
    ).toBe('user_dm');

    expect(
      getInboundSlackConversationSource({
        type: 'app_mention',
        channel: 'C123',
        channel_type: 'channel',
        user: 'U123',
        text: '<@BOT> please help',
        ts: '111.225',
        thread_ts: '111.000',
      }),
    ).toBe('user_thread_reply');
  });
});
