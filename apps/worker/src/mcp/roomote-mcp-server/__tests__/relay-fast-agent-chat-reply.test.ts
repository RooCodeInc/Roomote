import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ relay: vi.fn() }));

vi.mock('@roomote/sdk/client', () => ({
  sdk: { taskRuns: { relayFastAgentChildChatReply: mocks.relay } },
}));

import { handleRelayFastAgentChatReply } from '../relay-fast-agent-chat-reply';

describe('handleRelayFastAgentChatReply', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.relay.mockResolvedValue({ relayed: true });
    tempDir = mkdtempSync(join(tmpdir(), 'roomote-fast-relay-'));
  });

  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  it('relays lifecycle text without posting to a communication provider', async () => {
    const result = await handleRelayFastAgentChatReply(
      {
        runId: 42,
        taskId: 'task-1',
        purpose: 'progress',
        message: 'The implementation is ready for validation.',
        relayStateDirectory: tempDir,
      },
      {
        token: 'token',
        platformApiUrl: 'https://api.roomote.example',
      },
    );

    expect(mocks.relay).toHaveBeenCalledWith({
      runId: 42,
      taskId: 'task-1',
      messageId: expect.any(String),
      purpose: 'progress',
      message: 'The implementation is ready for validation.',
    });
    expect(result.content[0]?.text).toContain('"relayed":true');
    expect(result.content[0]?.text).toContain('"relayId":');
  });

  it('does not mark an update successful when the Fast parent is unavailable', async () => {
    mocks.relay.mockResolvedValueOnce({ relayed: false });

    const result = await handleRelayFastAgentChatReply(
      {
        runId: 42,
        taskId: 'task-1',
        purpose: 'progress',
        message: 'Still working.',
        relayStateDirectory: tempDir,
      },
      {
        token: 'token',
        platformApiUrl: 'https://api.roomote.example',
      },
    );

    expect(result.content[0]?.text).toContain('"success":false');
  });

  it('reuses the pending delivery key after a lost relay response', async () => {
    mocks.relay
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ relayed: true });
    const input = {
      runId: 42,
      taskId: 'task-1',
      purpose: 'progress' as const,
      message: 'The targeted tests are running.',
      relayStateDirectory: tempDir,
    };

    await handleRelayFastAgentChatReply(input, {
      token: 'token',
      platformApiUrl: 'https://api.roomote.example',
    });
    await handleRelayFastAgentChatReply(input, {
      token: 'token',
      platformApiUrl: 'https://api.roomote.example',
    });

    expect(mocks.relay).toHaveBeenCalledTimes(2);
    expect(mocks.relay.mock.calls[0]?.[0]?.messageId).toBe(
      mocks.relay.mock.calls[1]?.[0]?.messageId,
    );
  });
});
