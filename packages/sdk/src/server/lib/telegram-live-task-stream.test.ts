const mocks = vi.hoisted(() => ({
  redis: new Map<string, string>(),
  getSessionForTask: vi.fn(),
  postMessage: vi.fn(),
  editMessageText: vi.fn(),
  createProvider: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    get: async (key: string) => mocks.redis.get(key) ?? null,
    set: async (key: string, value: string) => {
      mocks.redis.set(key, value);
      return 'OK';
    },
  }),
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  getSessionForTask: mocks.getSessionForTask,
}));

vi.mock('./telegram-communication', () => ({
  createTelegramCommunicationProviderFromRuntimeCredentials:
    mocks.createProvider,
}));

import { RunStatus } from '@roomote/types';

import {
  renderTelegramLiveTaskStream,
  settleTelegramLiveTaskStreamForRun,
  startTelegramLiveTaskStream,
} from './telegram-live-task-stream';

describe('Telegram live task stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redis.clear();
    mocks.getSessionForTask.mockResolvedValue({ id: 'session-1' });
    mocks.postMessage.mockResolvedValue({
      provider: 'telegram',
      channelId: '-1001',
      threadId: '77',
      messageId: '88',
    });
    mocks.editMessageText.mockResolvedValue(undefined);
    mocks.createProvider.mockResolvedValue({
      editMessageText: mocks.editMessageText,
    });
  });

  async function start() {
    await startTelegramLiveTaskStream({
      provider: {
        postMessage: mocks.postMessage,
        editMessageText: mocks.editMessageText,
      },
      taskRun: { id: 42, taskId: 'task-1' },
      prompt: 'Implement Telegram live updates',
      taskUrl: 'https://roomote.example/tasks/task-1',
      channelId: '-1001',
      threadId: '77',
    });
  }

  it('posts one pending message in the owning topic with the selected task link', async () => {
    await start();

    expect(mocks.postMessage).toHaveBeenCalledWith({
      channelId: '-1001',
      threadId: '77',
      text: expect.stringContaining('Roomote task\nRunning · 0s'),
      buttons: [
        [
          {
            text: 'Open in Roomote',
            url: expect.stringContaining('task=task-1'),
          },
        ],
      ],
    });

    await start();
    expect(mocks.postMessage).toHaveBeenCalledOnce();
  });

  it('edits running progress with expandable HTML and a plain fallback', async () => {
    await start();

    await renderTelegramLiveTaskStream({
      taskId: 'task-1',
      status: 'in_progress',
      details: 'Running tests.\nChecking Telegram fallback behavior.',
      taskTitle: 'Telegram live task prototype',
    });

    expect(mocks.editMessageText).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '-1001',
        messageId: '88',
        text: expect.stringContaining(
          'Progress\nRunning tests.\nChecking Telegram fallback behavior.',
        ),
        htmlText: expect.stringContaining('<blockquote expandable>'),
        buttons: [[{ text: 'Open in Roomote', url: expect.any(String) }]],
      }),
    );
  });

  it('renders the shared input prompt as a waiting state', async () => {
    await start();
    mocks.editMessageText.mockClear();

    await renderTelegramLiveTaskStream({
      taskId: 'task-1',
      status: 'in_progress',
      details: 'Waiting for your input…',
    });

    expect(mocks.editMessageText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Waiting for input'),
      }),
    );
  });

  it.each([
    ['complete', 'Authoritative final response.', 'Completed'],
    ['error', 'Stopped because of an error.', 'Failed'],
    ['error', 'Stopped.', 'Stopped'],
  ] as const)(
    'renders %s as a terminal status-only edit',
    async (status, output, label) => {
      await start();
      mocks.editMessageText.mockClear();

      await renderTelegramLiveTaskStream({
        taskId: 'task-1',
        status,
        ...(output ? { output } : {}),
        taskTitle: 'Telegram live task prototype',
      });

      const edit = mocks.editMessageText.mock.calls[0]?.[0] as {
        text: string;
        htmlText: string;
      };
      expect(edit.text).toContain(label);
      expect(edit.text).not.toContain('Result');
      expect(edit.text).not.toContain('Authoritative final response.');
      expect(edit.text).not.toContain('Stopped because of an error.');
    },
  );

  it('settles control-plane cancellation paths without throwing', async () => {
    await start();
    mocks.editMessageText.mockClear();

    await settleTelegramLiveTaskStreamForRun({
      taskId: 'task-1',
      payload: { liveTaskStream: true },
      status: RunStatus.Canceled,
    });

    expect(mocks.editMessageText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Stopped') }),
    );
  });

  it('suppresses later edits after Telegram reports a permanently missing message', async () => {
    await start();
    mocks.editMessageText.mockRejectedValue(
      new Error(
        'Telegram editMessageText failed (400): message to edit not found',
      ),
    );

    await expect(
      renderTelegramLiveTaskStream({
        taskId: 'task-1',
        status: 'in_progress',
        details: 'Working',
      }),
    ).resolves.toEqual({ card: false, updated: false });
  });
});
