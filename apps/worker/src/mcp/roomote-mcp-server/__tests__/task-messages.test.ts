import { handleGetTaskMessages } from '../task-messages.js';
import * as tasksApiClient from '../tasks-api-client.js';
import type { RoomoteConfig } from '../types.js';

vi.mock('../tasks-api-client.js');

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://test-api.example.com',
};

describe('handleGetTaskMessages', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should return formatted messages when found', async () => {
    vi.mocked(tasksApiClient.getTaskMessages).mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-1',
          taskId: 'task-1',
          ts: 1700000000,
          eventType: 'roomote_runtime.assistant_text',
          role: 'assistant',
          text: 'Hello, I will help you fix this bug.',
          images: [],
          metadata: {},
        },
        {
          id: 'msg-2',
          taskId: 'task-1',
          ts: 1700000001,
          eventType: 'roomote_runtime.user_message',
          role: 'user',
          text: 'Should I also update the tests?',
          images: [],
          metadata: {},
        },
      ],
      returned: 2,
    });

    const result = await handleGetTaskMessages({ taskId: 'task-1' }, config);

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('2 message(s)');
    expect(text).toContain('Hello, I will help you fix this bug.');
    expect(text).toContain('Should I also update the tests?');
  });

  it('should pass limit and keep newest-first ordering when limit is specified', async () => {
    vi.mocked(tasksApiClient.getTaskMessages).mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-3',
          taskId: 'task-1',
          ts: 1700000002,
          eventType: 'roomote_runtime.assistant_text',
          role: 'assistant',
          text: 'Most recent message',
          images: [],
          metadata: {},
        },
      ],
      returned: 1,
    });

    const result = await handleGetTaskMessages(
      { taskId: 'task-1', limit: 5 },
      config,
    );

    expect(vi.mocked(tasksApiClient.getTaskMessages)).toHaveBeenCalledWith(
      config,
      'task-1',
      { limit: 5, order: 'desc' },
    );

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Latest 1 message(s)');
    expect(text).toContain('Most recent message');
  });

  it('should return a message when no messages found', async () => {
    vi.mocked(tasksApiClient.getTaskMessages).mockResolvedValueOnce({
      messages: [],
      returned: 0,
    });

    const result = await handleGetTaskMessages({ taskId: 'task-1' }, config);

    expect(result.content[0]?.text).toContain('No messages found');
  });

  it('should return error on failure', async () => {
    vi.mocked(tasksApiClient.getTaskMessages).mockRejectedValueOnce(
      new Error('Task not found'),
    );

    const result = await handleGetTaskMessages({ taskId: 'bad' }, config);

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Task not found');
    expect(text).toContain('"success":false');
  });

  it('should not render undefined labels when role is missing', async () => {
    vi.mocked(tasksApiClient.getTaskMessages).mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-1',
          taskId: 'task-1',
          ts: 1700000000,
          eventType: 'roomote_runtime.assistant_text',
          role: null,
          text: 'npm test',
          images: [],
          metadata: {},
        },
      ],
      returned: 1,
    });

    const result = await handleGetTaskMessages({ taskId: 'task-1' }, config);
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('[assistant] (roomote_runtime.assistant_text)');
    expect(text).not.toContain('null');
    expect(text).not.toContain('undefined');
  });

  it('includes transcript-hidden messages in the MCP output', async () => {
    vi.mocked(tasksApiClient.getTaskMessages).mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-hidden',
          taskId: 'task-1',
          ts: 1700000000,
          eventType: 'roomote_runtime.user_prompt',
          role: 'user',
          text: '$review-code',
          images: [],
          metadata: { visibleInTranscript: false },
          visibleInTranscript: false,
        },
      ],
      returned: 1,
    });

    const result = await handleGetTaskMessages({ taskId: 'task-1' }, config);
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('[user] (roomote_runtime.user_prompt)');
    expect(text).toContain('$review-code');
  });

  it('should fall back to unknown role for unmapped event types', async () => {
    vi.mocked(tasksApiClient.getTaskMessages).mockResolvedValueOnce({
      messages: [
        {
          id: 'msg-1',
          taskId: 'task-1',
          ts: 1700000000,
          eventType: 'custom.event',
          role: null,
          text: 'custom message',
          images: [],
          metadata: {},
        },
      ],
      returned: 1,
    });

    const result = await handleGetTaskMessages({ taskId: 'task-1' }, config);
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('[unknown] (custom.event)');
    expect(text).not.toContain('undefined');
  });
});
