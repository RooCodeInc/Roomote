const store = vi.hoisted(() => new Map<string, string>());
vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    zadd: async () => 1,
    eval: async (
      script: string,
      count: number,
      key: string,
      ownerOrPointerKey: string,
      owner?: string,
      value?: string,
      ttl?: string | number,
    ) => {
      if (count === 2) {
        if (store.get(key) !== owner) return 0;
        if (ttl !== 'keepTtl' || store.has(ownerOrPointerKey)) {
          store.set(ownerOrPointerKey, value!);
        }
        return 1;
      }
      if (store.get(key) !== ownerOrPointerKey) return 0;
      if (script.includes("'del'")) store.delete(key);
      return 1;
    },
  }),
}));
vi.mock('./fast-agent-provider-message', () => ({
  recordFastAgentConversationMessageBestEffort: async () => {},
}));
import {
  getThreadReplyFooterRecord,
  setThreadReplyFooterRecord,
  type DiscordCommunicationProvider,
} from '@roomote/communication';
import {
  buildSlackThreadReplyFooterBlock,
  type SlackNotifier,
} from '@roomote/slack';
import {
  createDiscordFastReplyReplacer,
  createSlackFastReplyReplacer,
} from './fast-agent-reply-replacement';

describe('replacement writes obey footer lease ownership', () => {
  beforeEach(() => store.clear());
  const footerContext = { linkedPrs: [], livePreviewUrl: null };
  it.each([false, true])(
    'Discord replacement respects lease loss=%s',
    async (loseLease) => {
      const original = {
        messageId: 'old',
        textWithoutFooter: 'Original',
        refresh: { footerText: 'old footer', channelId: 'T' },
      };
      await setThreadReplyFooterRecord('discord', 'C', 'T', original);
      const editMessage = vi.fn().mockResolvedValue(undefined);
      editMessage.mockImplementationOnce(async () => {
        if (!loseLease) return;
        store.set('discord:thread_reply_footer_lock:C:T', 'competitor');
        await setThreadReplyFooterRecord('discord', 'C', 'T', {
          ...original,
          messageId: 'competitor',
          textWithoutFooter: 'New body',
        });
      });
      const replace = createDiscordFastReplyReplacer({
        provider: { editMessage } as unknown as DiscordCommunicationProvider,
        conversation: {
          surface: 'discord',
          workspaceId: 'guild',
          conversationId: 'C',
          replyTarget: { channelId: 'C', threadId: 'T' },
        },
        channelId: 'C',
        threadId: 'T',
        sessionId: 'session',
        footerContext,
        postReplacement: vi.fn(),
      });
      await replace(
        { messageId: 'old' },
        { purpose: 'closeout', message: 'Updated old reply' },
      );
      expect(
        (await getThreadReplyFooterRecord('discord', 'C', 'T'))?.messageId,
      ).toBe(loseLease ? 'competitor' : 'old');
      if (loseLease) {
        expect(editMessage).toHaveBeenLastCalledWith({
          channelId: 'T',
          messageId: 'old',
          text: 'Updated old reply',
          preserveButtons: true,
        });
      } else {
        expect(editMessage).toHaveBeenCalledTimes(1);
        expect(
          (await getThreadReplyFooterRecord('discord', 'C', 'T'))
            ?.textWithoutFooter,
        ).toBe('Updated old reply');
      }
    },
  );
  it('Slack removes only its stale replacement footer after a competing relocation', async () => {
    store.set('slack:thread_reply_footer:C:T', 'old');
    const body = { type: 'markdown', text: 'Updated old reply' };
    const updateMessage = vi.fn().mockResolvedValue(true);
    updateMessage.mockImplementationOnce(async () => {
      store.set('slack:thread_reply_footer_lock:C:T', 'competitor');
      store.set('slack:thread_reply_footer:C:T', 'competitor');
      return true;
    });
    const slack = {
      updateMessage,
      getMessageBlocks: vi.fn(async () => [
        body,
        buildSlackThreadReplyFooterBlock({ footerText: 'footer' }),
      ]),
    } as unknown as SlackNotifier;
    const replace = createSlackFastReplyReplacer({
      slack,
      conversation: {
        surface: 'slack',
        workspaceId: 'team',
        conversationId: 'T',
        replyTarget: { channelId: 'C', threadId: 'T' },
      },
      channelId: 'C',
      threadTs: 'T',
      sessionId: 'session',
      footerContext,
    });
    await replace(
      { messageId: 'old' },
      { purpose: 'closeout', message: 'Updated old reply' },
    );
    expect(store.get('slack:thread_reply_footer:C:T')).toBe('competitor');
    expect(updateMessage).toHaveBeenLastCalledWith({
      channel: 'C',
      ts: 'old',
      message: { blocks: [body] },
    });
  });
});
