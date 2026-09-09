const mocks = vi.hoisted(() => ({
  current: 'old',
  owned: true,
  locked: false,
  post: vi.fn(),
  getBlocks: vi.fn(),
  remove: vi.fn(),
  deleteMessage: vi.fn(),
  setFooter: vi.fn(),
  clearFooter: vi.fn(),
}));
vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      slackInstallations: {
        findFirst: async () => ({ botAccessToken: 'test-token' }),
      },
      taskSlackReplyDetails: {
        findFirst: async () => ({ summary: 'Summary', findings: ['Finding'] }),
      },
    },
  },
  and: vi.fn(),
  eq: vi.fn(),
  slackInstallations: {},
  taskSlackReplyDetails: {},
}));
vi.mock('@roomote/slack', () => ({
  parseRoomoteSlackReplyToggleValue: () => ({
    taskId: 'task',
    detailId: 'detail',
    expanded: false,
  }),
  ROOMOTE_SLACK_REPLY_ACTIONS_BLOCK_ID: 'actions',
  ROOMOTE_THREAD_REPLY_QUOTE_BLOCK_ID: 'quote',
  buildRoomoteSlackReplyBlocks: () => [
    { type: 'markdown', text: 'Expanded details' },
  ],
  buildRoomoteSlackReplyFallbackText: () => 'Expanded details',
  SlackNotifier: class {
    getMessageBlocks = mocks.getBlocks;
    postMessage = mocks.post;
    deleteMessage = mocks.deleteMessage;
  },
  getSlackThreadReplyFooterMessageTs: async () => mocks.current,
  setSlackThreadReplyFooterMessageTs: mocks.setFooter,
  clearSlackThreadReplyFooterMessageTs: mocks.clearFooter,
  removeSlackThreadReplyFooter: mocks.remove,
  rememberSlackThreadFooterRefresh: async () => {},
  trackSlackBotReply: async () => {},
  getLatestSlackBotReply: async () => null,
  setLatestSlackBotReply: async () => {},
  withSlackThreadReplyFooterLock: async ({
    fn,
  }: {
    fn: (assertLock: () => Promise<void>) => Promise<unknown>;
  }) => {
    mocks.locked = true;
    try {
      return await fn(async () => {
        if (!mocks.owned) throw new Error('lease lost');
      });
    } finally {
      mocks.locked = false;
    }
  },
}));
import type { SlackInteractivePayload } from '@roomote/slack';
import { handleThreadReplyDetailsToggle } from './thread-reply-details-toggle';

const payload = {
  actions: [{ type: 'button', value: 'toggle' }],
  team: { id: 'team' },
  channel: { id: 'C' },
  message: { ts: 'old', thread_ts: 'T' },
} as unknown as SlackInteractivePayload;

describe('details-toggle footer serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.current = 'old';
    mocks.owned = true;
    mocks.locked = false;
    mocks.getBlocks.mockImplementation(async () => {
      expect(mocks.locked).toBe(true);
      return [
        { type: 'markdown', text: 'Old body' },
        { type: 'actions', block_id: 'actions' },
        {
          type: 'context',
          block_id: 'roomote_thread_reply_footer',
          elements: [],
        },
      ];
    });
    mocks.post.mockImplementation(async () => {
      expect(mocks.locked).toBe(true);
      return 'replacement';
    });
    mocks.deleteMessage.mockResolvedValue(true);
    mocks.remove.mockResolvedValue(undefined);
    mocks.setFooter.mockResolvedValue(undefined);
    mocks.clearFooter.mockResolvedValue(undefined);
  });

  it('holds the delivery lock from block read through pointer handoff and deletion', async () => {
    await handleThreadReplyDetailsToggle(payload);
    expect(mocks.setFooter).toHaveBeenCalledWith('C', 'T', 'replacement');
    expect(mocks.deleteMessage).toHaveBeenCalledWith({
      channel: 'C',
      ts: 'old',
    });
    expect(mocks.setFooter.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteMessage.mock.invocationCallOrder[0]!,
    );
  });

  it('does not move or clear a competing pointer when its provider post outlives the lease', async () => {
    mocks.post.mockImplementationOnce(async () => {
      mocks.owned = false;
      mocks.current = 'competitor';
      return 'replacement';
    });
    await handleThreadReplyDetailsToggle(payload);
    expect(mocks.setFooter).not.toHaveBeenCalled();
    expect(mocks.clearFooter).not.toHaveBeenCalled();
    expect(mocks.deleteMessage).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C',
        threadTs: 'T',
        messageTs: 'replacement',
      }),
    );
    expect(mocks.current).toBe('competitor');
  });

  it('does not resurrect an old footer when toggling a historical reply', async () => {
    mocks.current = 'competitor';
    await handleThreadReplyDetailsToggle(payload);
    expect(mocks.post.mock.calls[0]![0].blocks).not.toContainEqual(
      expect.objectContaining({ block_id: 'roomote_thread_reply_footer' }),
    );
    expect(mocks.setFooter).not.toHaveBeenCalled();
    expect(mocks.clearFooter).not.toHaveBeenCalled();
  });
});
