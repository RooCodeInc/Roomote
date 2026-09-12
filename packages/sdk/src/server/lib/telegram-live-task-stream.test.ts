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
      text: 'Starting task…',
      htmlText: 'Starting task…',
      footerText: expect.stringMatching(/^Open in Roomote: .*task=task-1/),
      footerHtmlText: expect.stringMatching(
        /^<a href=".*task=task-1.*">Open in Roomote<\/a>/,
      ),
    });

    await start();
    expect(mocks.postMessage).toHaveBeenCalledOnce();
  });

  it('edits running progress with details HTML and a plain fallback', async () => {
    await start();

    await renderTelegramLiveTaskStream({
      taskId: 'task-1',
      status: 'in_progress',
      details: 'Running tests.\nChecking Telegram fallback behavior.',
    });

    expect(mocks.editMessageText).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '-1001',
        messageId: '88',
        text: 'Running tests.\n\nChecking Telegram fallback behavior.',
        htmlText:
          '<details><summary>Running tests.</summary>Checking Telegram fallback behavior.</details>',
        footerText: expect.stringMatching(/^Open in Roomote:/),
        footerHtmlText: expect.stringMatching(/^<a href=/),
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
        text: 'Waiting for your input…',
        footerText: expect.stringMatching(/^Open in Roomote:/),
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
      });

      const edit = mocks.editMessageText.mock.calls[0]?.[0] as {
        text: string;
        htmlText: string;
        footerText: string;
      };
      expect(`${edit.text}\n\n${edit.footerText}`).toMatch(
        new RegExp(
          `^${label === 'Completed' ? 'Completed\\.' : label === 'Failed' ? 'Task failed\\.' : 'Stopped\\.'}\\n\\nOpen in Roomote:`,
        ),
      );
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

  it('suppresses edits across later runs after a permanent message failure', async () => {
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

    mocks.editMessageText.mockResolvedValue(undefined);
    await expect(
      renderTelegramLiveTaskStream({
        taskId: 'task-1',
        status: 'in_progress',
        details: 'A later run is working',
      }),
    ).resolves.toEqual({ card: false, updated: false });
    expect(mocks.editMessageText).toHaveBeenCalledOnce();

    await start();
    expect(mocks.postMessage).toHaveBeenCalledOnce();
  });
});
