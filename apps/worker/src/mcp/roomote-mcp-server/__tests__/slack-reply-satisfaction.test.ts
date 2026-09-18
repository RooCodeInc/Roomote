import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CHAT_REPLY_SATISFACTION_STATE_FILE_ENV as SLACK_REPLY_SATISFACTION_STATE_FILE_ENV,
  recordChatReplyDeliveryFailure,
  recordChatReplySatisfaction as recordSlackReplySatisfaction,
  recordChatTurnStart as recordSlackTurnStart,
} from '../chat-reply-satisfaction';

describe('Slack reply satisfaction state', () => {
  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];

  afterEach(() => {
    process.env = { ...originalEnv };

    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('records the current Slack turn when a Slack prompt starts', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');

    recordSlackTurnStart({
      stateFilePath,
      turnMessageTs: '222.333',
      nowMs: 1234,
    });

    expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
      currentTurnMessageTs: '222.333',
      currentTurnStartedAtMs: 1234,
      currentTurnReactionsAllowed: true,
      currentTurnRequiresInitialAck: true,
    });
  });

  it('records the parent session id on the first Slack turn start when provided', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');

    recordSlackTurnStart({
      stateFilePath,
      turnMessageTs: '222.333',
      sessionId: 'thread-parent',
      nowMs: 1234,
    });

    expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
      parentThreadId: 'thread-parent',
      currentTurnMessageTs: '222.333',
      currentTurnStartedAtMs: 1234,
      currentTurnReactionsAllowed: true,
      currentTurnRequiresInitialAck: true,
    });
  });

  it('records when a Slack turn explicitly skips the initial ack requirement', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');

    recordSlackTurnStart({
      stateFilePath,
      turnMessageTs: '222.333',
      requireInitialAck: false,
      nowMs: 1234,
    });

    expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
      currentTurnMessageTs: '222.333',
      currentTurnStartedAtMs: 1234,
      currentTurnReactionsAllowed: true,
      currentTurnRequiresInitialAck: false,
    });
  });

  it('records successful Slack replies with message timestamps', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    process.env[SLACK_REPLY_SATISFACTION_STATE_FILE_ENV] = stateFilePath;

    recordSlackReplySatisfaction({
      messageTs: '111.222',
      tool: 'send_chat_reply',
      nowMs: 1234,
    });

    expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
      messageTs: '111.222',
      tool: 'send_chat_reply',
      recordedAtMs: 1234,
    });
  });

  it('records Slack reply purpose when provided', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    process.env[SLACK_REPLY_SATISFACTION_STATE_FILE_ENV] = stateFilePath;

    recordSlackReplySatisfaction({
      messageTs: '111.222',
      tool: 'send_chat_reply',
      replyPurpose: 'closeout',
      nowMs: 1234,
    });

    expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
      messageTs: '111.222',
      tool: 'send_chat_reply',
      replyPurpose: 'closeout',
      recordedAtMs: 1234,
    });
  });

  it('records parent Session reports as terminal lifecycle satisfaction', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-session-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    process.env[SLACK_REPLY_SATISFACTION_STATE_FILE_ENV] = stateFilePath;

    recordSlackReplySatisfaction({
      messageTs: 'report-1',
      tool: 'report_to_parent_session',
      replyPurpose: 'closeout',
      nowMs: 1234,
    });

    expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
      messageTs: 'report-1',
      tool: 'report_to_parent_session',
      replyPurpose: 'closeout',
      recordedAtMs: 1234,
    });
  });

  it('records current-turn shortcut reactions with message timestamps', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    process.env[SLACK_REPLY_SATISFACTION_STATE_FILE_ENV] = stateFilePath;

    recordSlackReplySatisfaction({
      messageTs: '111.222',
      tool: 'send_chat_reaction_emoji',
      nowMs: 1234,
    });

    expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
      messageTs: '111.222',
      tool: 'send_chat_reaction_emoji',
      recordedAtMs: 1234,
    });
  });

  it('clears stale Slack reply purpose when a non-reply tool satisfies the turn', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    process.env[SLACK_REPLY_SATISFACTION_STATE_FILE_ENV] = stateFilePath;
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        messageTs: 'bot-111.222',
        tool: 'send_chat_reply',
        replyPurpose: 'progress',
      }),
      'utf8',
    );

    recordSlackReplySatisfaction({
      messageTs: 'user-333.444',
      tool: 'send_chat_reaction_emoji',
      nowMs: 1234,
    });

    expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
      messageTs: 'user-333.444',
      tool: 'send_chat_reaction_emoji',
      recordedAtMs: 1234,
    });
  });

  it('marks the current turn satisfied when the shortcut reaction targets that Slack message', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    process.env[SLACK_REPLY_SATISFACTION_STATE_FILE_ENV] = stateFilePath;
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: '111.222',
        currentTurnStartedAtMs: 1000,
      }),
      'utf8',
    );

    recordSlackReplySatisfaction({
      messageTs: '111.222',
      tool: 'send_chat_reaction_emoji',
      nowMs: 1234,
    });

    expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
      currentTurnMessageTs: '111.222',
      currentTurnStartedAtMs: 1000,
      messageTs: '111.222',
      tool: 'send_chat_reaction_emoji',
      recordedAtMs: 1234,
      satisfiedTurnMessageTs: '111.222',
    });
  });

  it('marks the current turn satisfied when the shortcut reaction targets that Teams activity', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    process.env[SLACK_REPLY_SATISFACTION_STATE_FILE_ENV] = stateFilePath;
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: 'activity-followup',
        currentTurnStartedAtMs: 1000,
      }),
      'utf8',
    );

    recordSlackReplySatisfaction({
      messageTs: 'activity-followup',
      tool: 'send_chat_reaction_emoji',
      nowMs: 1234,
    });

    expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
      currentTurnMessageTs: 'activity-followup',
      currentTurnStartedAtMs: 1000,
      messageTs: 'activity-followup',
      tool: 'send_chat_reaction_emoji',
      recordedAtMs: 1234,
      satisfiedTurnMessageTs: 'activity-followup',
    });
  });

  it('does not satisfy the current turn with a reaction when that turn disallows reactions', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    process.env[SLACK_REPLY_SATISFACTION_STATE_FILE_ENV] = stateFilePath;
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: '111.222',
        currentTurnStartedAtMs: 1000,
        currentTurnReactionsAllowed: false,
      }),
      'utf8',
    );

    recordSlackReplySatisfaction({
      messageTs: '111.222',
      tool: 'send_chat_reaction_emoji',
      nowMs: 1234,
    });

    expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
      currentTurnMessageTs: '111.222',
      currentTurnStartedAtMs: 1000,
      currentTurnReactionsAllowed: false,
      messageTs: '111.222',
      tool: 'send_chat_reaction_emoji',
      recordedAtMs: 1234,
    });
  });

  it('clears prior non-Slack-work markers when the current turn is satisfied again', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    process.env[SLACK_REPLY_SATISFACTION_STATE_FILE_ENV] = stateFilePath;
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: '111.222',
        currentTurnStartedAtMs: 1000,
        lastNonSlackWorkAfterSatisfactionAtMs: 1200,
      }),
      'utf8',
    );

    recordSlackReplySatisfaction({
      messageTs: '111.222',
      tool: 'send_chat_reaction_emoji',
      nowMs: 1234,
    });

    expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
      currentTurnMessageTs: '111.222',
      currentTurnStartedAtMs: 1000,
      messageTs: '111.222',
      tool: 'send_chat_reaction_emoji',
      recordedAtMs: 1234,
      satisfiedTurnMessageTs: '111.222',
    });
  });

  it('writes terminal closeout state when a current-turn closeout reply is recorded', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    process.env[SLACK_REPLY_SATISFACTION_STATE_FILE_ENV] = stateFilePath;
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: '111.222',
        currentTurnStartedAtMs: 1000,
      }),
      'utf8',
    );

    recordSlackReplySatisfaction({
      messageTs: 'bot-333.444',
      tool: 'send_chat_reply',
      replyPurpose: 'closeout',
      nowMs: 1200,
    });

    expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
      currentTurnMessageTs: '111.222',
      currentTurnStartedAtMs: 1000,
      satisfiedTurnMessageTs: '111.222',
      terminalSatisfiedTurnMessageTs: '111.222',
      terminalSatisfiedAtMs: 1200,
      terminalSatisfactionTool: 'send_chat_reply',
      messageTs: 'bot-333.444',
      tool: 'send_chat_reply',
      replyPurpose: 'closeout',
      recordedAtMs: 1200,
    });
  });

  it('writes terminal state when a current-turn clarification reply is recorded', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    process.env[SLACK_REPLY_SATISFACTION_STATE_FILE_ENV] = stateFilePath;
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: '111.222',
        currentTurnStartedAtMs: 1000,
      }),
      'utf8',
    );

    recordSlackReplySatisfaction({
      messageTs: 'bot-333.444',
      tool: 'send_chat_reply',
      replyPurpose: 'clarification',
      nowMs: 1200,
    });

    expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
      currentTurnMessageTs: '111.222',
      currentTurnStartedAtMs: 1000,
      satisfiedTurnMessageTs: '111.222',
      terminalSatisfiedTurnMessageTs: '111.222',
      terminalSatisfiedAtMs: 1200,
      terminalSatisfactionTool: 'send_chat_reply',
      messageTs: 'bot-333.444',
      tool: 'send_chat_reply',
      replyPurpose: 'clarification',
      recordedAtMs: 1200,
    });
  });

  it('does not write terminal state for ack or progress replies', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    process.env[SLACK_REPLY_SATISFACTION_STATE_FILE_ENV] = stateFilePath;
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: '111.222',
        currentTurnStartedAtMs: 1000,
      }),
      'utf8',
    );

    recordSlackReplySatisfaction({
      messageTs: 'bot-333.444',
      tool: 'send_chat_reply',
      replyPurpose: 'progress',
      nowMs: 1200,
    });

    const state = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
    expect(state.terminalSatisfiedTurnMessageTs).toBeUndefined();
    expect(state.terminalSatisfiedAtMs).toBeUndefined();
  });

  it('does not clobber terminal closeout state when a later reaction overwrites the latest tool markers', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    process.env[SLACK_REPLY_SATISFACTION_STATE_FILE_ENV] = stateFilePath;
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: '111.222',
        currentTurnStartedAtMs: 1000,
        satisfiedTurnMessageTs: '111.222',
        terminalSatisfiedTurnMessageTs: '111.222',
        terminalSatisfiedAtMs: 1200,
        terminalSatisfactionTool: 'send_chat_reply',
        messageTs: 'bot-333.444',
        tool: 'send_chat_reply',
        replyPurpose: 'closeout',
        recordedAtMs: 1200,
      }),
      'utf8',
    );

    recordSlackReplySatisfaction({
      messageTs: '111.222',
      tool: 'send_chat_reaction_emoji',
      nowMs: 1234,
    });

    expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
      currentTurnMessageTs: '111.222',
      currentTurnStartedAtMs: 1000,
      satisfiedTurnMessageTs: '111.222',
      terminalSatisfiedTurnMessageTs: '111.222',
      terminalSatisfiedAtMs: 1200,
      terminalSatisfactionTool: 'send_chat_reply',
      messageTs: '111.222',
      tool: 'send_chat_reaction_emoji',
      recordedAtMs: 1234,
    });
  });

  it('does not satisfy a non-Slack current turn even if a reaction records the same identifier', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    process.env[SLACK_REPLY_SATISFACTION_STATE_FILE_ENV] = stateFilePath;
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: 'web:client-1',
        currentTurnStartedAtMs: 1000,
      }),
      'utf8',
    );

    recordSlackReplySatisfaction({
      messageTs: 'web:client-1',
      tool: 'send_chat_reaction_emoji',
      nowMs: 1234,
    });

    expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
      currentTurnMessageTs: 'web:client-1',
      currentTurnStartedAtMs: 1000,
      messageTs: 'web:client-1',
      tool: 'send_chat_reaction_emoji',
      recordedAtMs: 1234,
    });
  });

  it('does not create state for missing message timestamps', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    process.env[SLACK_REPLY_SATISFACTION_STATE_FILE_ENV] = stateFilePath;

    recordSlackReplySatisfaction({
      messageTs: '   ',
      tool: 'send_chat_reply',
      nowMs: 1234,
    });

    expect(fs.existsSync(stateFilePath)).toBe(false);
  });

  it('preserves Slack task start state when recording a successful reply', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    process.env[SLACK_REPLY_SATISFACTION_STATE_FILE_ENV] = stateFilePath;
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        startedAtMs: 1000,
        currentTurnMessageTs: '222.333',
        currentTurnStartedAtMs: 1500,
        lastSilenceReminderAtMs: 2000,
      }),
      'utf8',
    );

    recordSlackReplySatisfaction({
      messageTs: '333.444',
      tool: 'send_chat_reply',
      replyPurpose: 'progress',
      nowMs: 3000,
    });

    expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
      startedAtMs: 1000,
      currentTurnMessageTs: '222.333',
      currentTurnStartedAtMs: 1500,
      lastSilenceReminderAtMs: 2000,
      messageTs: '333.444',
      tool: 'send_chat_reply',
      replyPurpose: 'progress',
      recordedAtMs: 3000,
      satisfiedTurnMessageTs: '222.333',
    });
  });

  it('ignores non-parent thread satisfaction writes when the parent thread is known', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    process.env[SLACK_REPLY_SATISFACTION_STATE_FILE_ENV] = stateFilePath;
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        parentThreadId: 'thread-parent',
        currentTurnMessageTs: '222.333',
        currentTurnStartedAtMs: 1500,
      }),
      'utf8',
    );

    recordSlackReplySatisfaction({
      messageTs: '333.444',
      sessionId: 'thread-child',
      tool: 'send_chat_reply',
      replyPurpose: 'progress',
      nowMs: 3000,
    });

    expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
      parentThreadId: 'thread-parent',
      currentTurnMessageTs: '222.333',
      currentTurnStartedAtMs: 1500,
    });
  });

  it('records terminal closeout state for the current turn and clears stale post-closeout work markers', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    process.env[SLACK_REPLY_SATISFACTION_STATE_FILE_ENV] = stateFilePath;
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: 'web:client-1',
        currentTurnStartedAtMs: 1000,
        lastNonSlackWorkAfterTerminalAtMs: 2000,
      }),
      'utf8',
    );

    recordSlackReplySatisfaction({
      messageTs: 'bot-333.444',
      tool: 'send_chat_reply',
      replyPurpose: 'closeout',
      nowMs: 3000,
    });

    expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
      currentTurnMessageTs: 'web:client-1',
      currentTurnStartedAtMs: 1000,
      messageTs: 'bot-333.444',
      tool: 'send_chat_reply',
      replyPurpose: 'closeout',
      recordedAtMs: 3000,
      satisfiedTurnMessageTs: 'web:client-1',
      terminalSatisfiedTurnMessageTs: 'web:client-1',
      terminalSatisfiedAtMs: 3000,
      terminalSatisfactionTool: 'send_chat_reply',
    });
  });

  it('clears previous-turn terminal satisfaction when a new Slack turn starts', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');

    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: 'slack:111.222',
        currentTurnStartedAtMs: 1000,
        initialAckReminderAtMs: 1200,
        satisfiedTurnMessageTs: 'slack:111.222',
        terminalSatisfiedTurnMessageTs: 'slack:111.222',
        terminalSatisfiedAtMs: 1500,
        terminalSatisfactionTool: 'send_chat_reply',
        lastNonSlackWorkAfterTerminalAtMs: 1600,
      }),
      'utf8',
    );

    recordSlackTurnStart({
      stateFilePath,
      turnMessageTs: 'web:client-2',
      nowMs: 2000,
    });

    expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
      currentTurnMessageTs: 'web:client-2',
      currentTurnStartedAtMs: 2000,
      currentTurnReactionsAllowed: true,
      currentTurnRequiresInitialAck: true,
    });
  });

  it('preserves the current-turn reminder marker when recording a Slack ack', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    process.env[SLACK_REPLY_SATISFACTION_STATE_FILE_ENV] = stateFilePath;
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: '111.222',
        currentTurnStartedAtMs: 1000,
        initialAckReminderAtMs: 1100,
      }),
      'utf8',
    );

    recordSlackReplySatisfaction({
      messageTs: '111.222',
      tool: 'send_chat_reaction_emoji',
      nowMs: 1234,
    });

    expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
      currentTurnMessageTs: '111.222',
      currentTurnStartedAtMs: 1000,
      initialAckReminderAtMs: 1100,
      messageTs: '111.222',
      tool: 'send_chat_reaction_emoji',
      recordedAtMs: 1234,
      satisfiedTurnMessageTs: '111.222',
    });
  });

  describe('recordChatReplyDeliveryFailure', () => {
    function writeStateFile(state: Record<string, unknown>): string {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-slack-'));
      tempDirs.push(tempDir);
      const stateFilePath = path.join(tempDir, 'reply-state.json');
      fs.writeFileSync(stateFilePath, JSON.stringify(state), 'utf8');
      return stateFilePath;
    }

    it('counts a retryable failure without stamping a terminal outcome', () => {
      const stateFilePath = writeStateFile({ startedAtMs: 1000 });

      const result = recordChatReplyDeliveryFailure({
        stateFilePath,
        retryable: true,
        nowMs: 2000,
      });

      expect(result).toEqual({ terminalDeliveryFailure: false });
      expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
        startedAtMs: 1000,
        deliveryFailureCount: 1,
        lastDeliveryFailureAtMs: 2000,
      });
    });

    it('stamps a terminal outcome on a non-retryable failure', () => {
      const stateFilePath = writeStateFile({ startedAtMs: 1000 });

      const result = recordChatReplyDeliveryFailure({
        stateFilePath,
        retryable: false,
        providerErrorCode: 'not_in_channel',
        nowMs: 2000,
      });

      expect(result).toEqual({ terminalDeliveryFailure: true });
      expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
        startedAtMs: 1000,
        deliveryFailureCount: 1,
        lastDeliveryFailureAtMs: 2000,
        lastDeliveryFailureCode: 'not_in_channel',
        terminalDeliveryFailureAtMs: 2000,
      });
    });

    it('stamps a terminal outcome when the bounded retry budget is spent', () => {
      const stateFilePath = writeStateFile({
        startedAtMs: 1000,
        deliveryFailureCount: 2,
        lastDeliveryFailureAtMs: 1900,
      });

      const result = recordChatReplyDeliveryFailure({
        stateFilePath,
        retryable: true,
        nowMs: 2000,
      });

      expect(result).toEqual({ terminalDeliveryFailure: true });
      expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
        startedAtMs: 1000,
        deliveryFailureCount: 3,
        lastDeliveryFailureAtMs: 2000,
        terminalDeliveryFailureAtMs: 2000,
      });
    });

    it('keeps the earliest terminal stamp across later failures', () => {
      const stateFilePath = writeStateFile({
        startedAtMs: 1000,
        deliveryFailureCount: 3,
        lastDeliveryFailureAtMs: 2000,
        terminalDeliveryFailureAtMs: 2000,
      });

      const result = recordChatReplyDeliveryFailure({
        stateFilePath,
        retryable: true,
        nowMs: 3000,
      });

      expect(result).toEqual({ terminalDeliveryFailure: true });
      const state = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
      expect(state.terminalDeliveryFailureAtMs).toBe(2000);
      expect(state.deliveryFailureCount).toBe(4);
    });

    it('ignores failures reported from non-parent sessions', () => {
      const stateFilePath = writeStateFile({
        startedAtMs: 1000,
        parentThreadId: 'thread-parent',
      });

      const result = recordChatReplyDeliveryFailure({
        stateFilePath,
        retryable: false,
        sessionId: 'thread-subagent',
        nowMs: 2000,
      });

      expect(result).toEqual({ terminalDeliveryFailure: false });
      expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toEqual({
        startedAtMs: 1000,
        parentThreadId: 'thread-parent',
      });
    });

    it('is not cleared by a successful reaction', () => {
      const stateFilePath = writeStateFile({
        startedAtMs: 1000,
        currentTurnMessageTs: '111.222',
        deliveryFailureCount: 3,
        lastDeliveryFailureCode: 'not_in_channel',
        terminalDeliveryFailureAtMs: 2000,
      });

      recordSlackReplySatisfaction({
        stateFilePath,
        messageTs: '111.222',
        tool: 'send_chat_reaction_emoji',
        nowMs: 3000,
      });

      const state = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
      expect(state.deliveryFailureCount).toBe(3);
      expect(state.lastDeliveryFailureCode).toBe('not_in_channel');
      expect(state.terminalDeliveryFailureAtMs).toBe(2000);
    });

    it('is cleared by a later successful post', () => {
      const stateFilePath = writeStateFile({
        startedAtMs: 1000,
        deliveryFailureCount: 3,
        lastDeliveryFailureAtMs: 2000,
        lastDeliveryFailureCode: 'not_in_channel',
        terminalDeliveryFailureAtMs: 2000,
      });

      recordSlackReplySatisfaction({
        stateFilePath,
        messageTs: '111.222',
        tool: 'send_chat_reply',
        replyPurpose: 'closeout',
        nowMs: 3000,
      });

      const state = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
      expect(state.deliveryFailureCount).toBeUndefined();
      expect(state.lastDeliveryFailureAtMs).toBeUndefined();
      expect(state.lastDeliveryFailureCode).toBeUndefined();
      expect(state.terminalDeliveryFailureAtMs).toBeUndefined();
      expect(state.messageTs).toBe('111.222');
    });

    it('is reset by a new inbound turn', () => {
      const stateFilePath = writeStateFile({
        currentTurnMessageTs: '111.222',
        deliveryFailureCount: 3,
        lastDeliveryFailureAtMs: 2000,
        terminalDeliveryFailureAtMs: 2000,
      });

      recordSlackTurnStart({
        stateFilePath,
        turnMessageTs: '333.444',
        nowMs: 3000,
      });

      const state = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
      expect(state.deliveryFailureCount).toBeUndefined();
      expect(state.terminalDeliveryFailureAtMs).toBeUndefined();
      expect(state.currentTurnMessageTs).toBe('333.444');
    });
  });
});
