import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { addReactionToChatMessage } from '../chat-api-client.js';
import { handleSendChatReactionEmoji } from '../send-chat-reaction-emoji.js';
import type { RoomoteConfig } from '../types.js';

vi.mock('../chat-api-client.js');

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://platform.example.com',
};

describe('handleSendChatReactionEmoji', () => {
  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.mocked(addReactionToChatMessage).mockReset();
    delete process.env.ROOMOTE_SLACK_CHANNEL;
    delete process.env.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE;
    delete process.env.ROOMOTE_COMMUNICATION_PROVIDER;
    delete process.env.ROOMOTE_COMMUNICATION_CHANNEL_ID;
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

  it('requires the active Slack channel context', async () => {
    const result = await handleSendChatReactionEmoji({ name: 'eyes' }, config);

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: false,
      error:
        'no chat channel is configured for this task (ROOMOTE_SLACK_CHANNEL or communication provider context)',
    });
  });

  it('requires a current Slack turn message timestamp', async () => {
    process.env.ROOMOTE_SLACK_CHANNEL = 'C123ABC456';

    const result = await handleSendChatReactionEmoji({ name: 'eyes' }, config);

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: false,
      error: 'current chat turn message timestamp is unavailable for this task',
    });
  });

  it('rejects non-Slack current-turn identifiers', async () => {
    process.env.ROOMOTE_SLACK_CHANNEL = 'C123ABC456';
    process.env.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE = writeState({
      currentTurnMessageTs: 'web:client-1',
    });

    const result = await handleSendChatReactionEmoji({ name: 'eyes' }, config);

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: false,
      error:
        'current turn did not originate from a chat message; use send_chat_reply instead',
    });
  });

  it('reacts to the active Slack turn without requiring lookup parameters', async () => {
    process.env.ROOMOTE_SLACK_CHANNEL = 'C123ABC456';
    process.env.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE = writeState({
      currentTurnMessageTs: '111.222',
    });
    vi.mocked(addReactionToChatMessage).mockResolvedValueOnce({
      channelId: 'C123ABC456',
      messageTs: '111.222',
      name: 'eyes',
    });

    const result = await handleSendChatReactionEmoji(
      { name: ':eyes:' },
      config,
    );

    expect(addReactionToChatMessage).toHaveBeenCalledWith(config, {
      channel: 'C123ABC456',
      messageTs: '111.222',
      name: 'eyes',
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: true,
      channelId: 'C123ABC456',
      messageTs: '111.222',
      name: 'eyes',
    });
  });

  it('reacts to the active Telegram turn using the communication context', async () => {
    process.env.ROOMOTE_COMMUNICATION_PROVIDER = 'telegram';
    process.env.ROOMOTE_COMMUNICATION_CHANNEL_ID = '8846357662';
    process.env.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE = writeState({
      currentTurnMessageTs: '456',
    });
    vi.mocked(addReactionToChatMessage).mockResolvedValueOnce({
      channelId: '8846357662',
      messageTs: '456',
      name: 'eyes',
    });

    const result = await handleSendChatReactionEmoji({ name: 'eyes' }, config);

    expect(addReactionToChatMessage).toHaveBeenCalledWith(config, {
      channel: '8846357662',
      messageTs: '456',
      name: 'eyes',
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: true,
      channelId: '8846357662',
      messageTs: '456',
      name: 'eyes',
    });
  });

  it('reacts to the active Teams turn using the raw Teams conversation id', async () => {
    process.env.ROOMOTE_COMMUNICATION_PROVIDER = 'teams';
    process.env.ROOMOTE_COMMUNICATION_CHANNEL_ID =
      '19:conversation@thread.v2;messageid=activity-root';
    process.env.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE = writeState({
      currentTurnMessageTs: 'activity-followup',
    });
    vi.mocked(addReactionToChatMessage).mockResolvedValueOnce({
      channelId: '19:conversation@thread.v2;messageid=activity-root',
      messageTs: 'activity-followup',
      name: 'eyes',
    });

    const result = await handleSendChatReactionEmoji(
      { name: ':eyes:' },
      config,
    );

    expect(addReactionToChatMessage).toHaveBeenCalledWith(config, {
      channel: '19:conversation@thread.v2;messageid=activity-root',
      messageTs: 'activity-followup',
      name: 'eyes',
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: true,
      channelId: '19:conversation@thread.v2;messageid=activity-root',
      messageTs: 'activity-followup',
      name: 'eyes',
    });
  });

  it('reacts to the active Discord turn using the task thread context', async () => {
    process.env.ROOMOTE_COMMUNICATION_PROVIDER = 'discord';
    process.env.ROOMOTE_COMMUNICATION_CHANNEL_ID = 'channel-1';
    process.env.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE = writeState({
      currentTurnMessageTs: 'message-1',
    });
    vi.mocked(addReactionToChatMessage).mockResolvedValueOnce({
      channelId: 'channel-1',
      messageTs: 'message-1',
      name: 'eyes',
    });

    const result = await handleSendChatReactionEmoji({ name: 'eyes' }, config);

    expect(addReactionToChatMessage).toHaveBeenCalledWith(config, {
      channel: 'channel-1',
      messageTs: 'message-1',
      name: 'eyes',
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: true,
      channelId: 'channel-1',
      messageTs: 'message-1',
      name: 'eyes',
    });
  });

  it('rejects invalid reaction names in communication contexts', async () => {
    process.env.ROOMOTE_COMMUNICATION_PROVIDER = 'teams';
    process.env.ROOMOTE_COMMUNICATION_CHANNEL_ID = '19:conversation@thread.v2';
    process.env.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE = writeState({
      currentTurnMessageTs: 'activity-followup',
    });

    const result = await handleSendChatReactionEmoji(
      { name: 'white check mark' },
      config,
    );

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: false,
      error:
        'name must be an emoji name without surrounding colons, for example eyes or white_check_mark',
    });
    expect(addReactionToChatMessage).not.toHaveBeenCalled();
  });

  it('rejects emoji reactions on the first Slack turn of a task', async () => {
    process.env.ROOMOTE_SLACK_CHANNEL = 'C123ABC456';
    process.env.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE = writeState({
      currentTurnMessageTs: '111.222',
      currentTurnReactionsAllowed: false,
    });

    const result = await handleSendChatReactionEmoji({ name: 'eyes' }, config);

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      success: false,
      error:
        'emoji reactions are not allowed on the first chat turn of a task; use send_chat_reply instead',
    });
  });
});
