import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { addReactionToChatMessage } from '../chat-api-client.js';
import { handleAddReactionToSlackMessage } from '../add-reaction-to-slack-message.js';
import type { RoomoteConfig } from '../types.js';

vi.mock('../chat-api-client.js');

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://platform.example.com',
};

describe('handleAddReactionToSlackMessage', () => {
  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();

    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function writeState(state: Record<string, unknown>): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    fs.writeFileSync(stateFilePath, JSON.stringify(state), 'utf8');
    return stateFilePath;
  }

  it('requires a channel', async () => {
    const result = await handleAddReactionToSlackMessage(
      { channel: '   ', messageTs: '111.222', name: 'eyes' },
      config,
    );

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: false,
      error: 'channel is required',
    });
  });

  it('requires a message timestamp', async () => {
    const result = await handleAddReactionToSlackMessage(
      { channel: '#eng', messageTs: '   ', name: 'eyes' },
      config,
    );

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: false,
      error: 'messageTs is required',
    });
  });

  it('requires a valid reaction name', async () => {
    const result = await handleAddReactionToSlackMessage(
      { channel: '#eng', messageTs: '111.222', name: '   ' },
      config,
    );

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: false,
      error:
        'name must be a Slack emoji name without surrounding colons, for example eyes or white_check_mark',
    });
  });

  it('normalizes channel mentions, lowercase IDs, and colon-wrapped emoji names', async () => {
    vi.mocked(addReactionToChatMessage).mockResolvedValueOnce({
      channelId: 'C123ABC456',
      messageTs: '111.222',
      name: 'white_check_mark',
    });

    const result = await handleAddReactionToSlackMessage(
      {
        channel: '<#c123abc456|eng>',
        messageTs: '111.222',
        name: ':white_check_mark:',
      },
      config,
    );

    expect(addReactionToChatMessage).toHaveBeenCalledWith(config, {
      channel: 'C123ABC456',
      messageTs: '111.222',
      name: 'white_check_mark',
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: true,
      channelId: 'C123ABC456',
      messageTs: '111.222',
      name: 'white_check_mark',
    });
  });

  it('returns an error result when the API call fails', async () => {
    vi.mocked(addReactionToChatMessage).mockRejectedValueOnce(
      new Error('forbidden'),
    );

    const result = await handleAddReactionToSlackMessage(
      { channel: '#eng', messageTs: '111.222', name: 'eyes' },
      config,
    );

    expect(result.content[0]?.text).toContain('"success":false');
    expect(result.content[0]?.text).toContain('forbidden');
  });

  it('rejects reacting to the current Slack turn when that first turn disallows reactions', async () => {
    process.env.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE = writeState({
      currentTurnMessageTs: '111.222',
      currentTurnReactionsAllowed: false,
    });

    const result = await handleAddReactionToSlackMessage(
      { channel: '#eng', messageTs: '111.222', name: 'eyes' },
      config,
    );

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: false,
      error:
        'emoji reactions are not allowed on the first Slack turn of a task; use send_chat_reply instead',
    });
  });
});
