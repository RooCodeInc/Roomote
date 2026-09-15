import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SLACK_SILENCE_HOOK_SCRIPT } from '../slack-silence-hook-script';

describe('SLACK_SILENCE_HOOK_SCRIPT', () => {
  const tempDirs: string[] = [];
  const initialAckReminder =
    'Before starting work that will not post to chat on this turn, send a quick chat-visible ack. When the latest user turn itself came from chat, reactions are allowed on that message, and a lightweight acknowledgement is enough, start with send_chat_reaction_emoji. Otherwise use send_chat_reply. Do not use request_user_input as a generic opening acknowledgement; only use it when you genuinely require structured input from the user. If the needed chat reply/post tool is not visible, use tool_search first. If context is still too thin to say anything concrete and the turn does not allow reactions, keep the text ack short and non-speculative. After that, continue the work you were doing.';
  const subagentSlackPostDenial =
    'chat-posting tools are reserved for the parent agent session. This subagent session must not post to chat directly. Return your findings in your final report to the parent agent instead; the parent agent will relay any chat-visible update.';

  function writeHook(): string {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-silence-hook-'),
    );
    tempDirs.push(tempDir);
    const hookPath = path.join(tempDir, 'hook.cjs');
    fs.writeFileSync(hookPath, SLACK_SILENCE_HOOK_SCRIPT, 'utf8');
    return hookPath;
  }

  function runHook(
    options: { env?: Record<string, string>; input?: unknown } = {},
  ) {
    const hookPath = writeHook();
    return spawnSync(process.execPath, [hookPath], {
      encoding: 'utf8',
      input: JSON.stringify(options.input ?? {}),
      env: {
        ...process.env,
        ROOMOTE_SLACK_HOOK_DEBUG: undefined,
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: undefined,
        ROOMOTE_COMMUNICATION_PROVIDER: undefined,
        ROOMOTE_SLACK_CHANNEL: undefined,
        ROOMOTE_FAST_AGENT_CHILD: undefined,
        ROOMOTE_FAST_AGENT_CHILD_CHAT_RELAY: undefined,
        ...options.env,
      },
    });
  }

  function writeState(state: Record<string, unknown>): string {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-silence-state-'),
    );
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'state.json');
    fs.writeFileSync(stateFilePath, JSON.stringify(state), 'utf8');
    return stateFilePath;
  }

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does nothing when Slack reply satisfaction is not configured', () => {
    const result = runHook();

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('does nothing when configured state needs no event-driven action', () => {
    const stateFilePath = writeState({ startedAtMs: Date.now() });

    const result = runHook({
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('skips enforcement when a PR-review child has no parent report tool', () => {
    const stateFilePath = writeState({
      startedAtMs: Date.now() - 8 * 60_000,
    });

    const result = runHook({
      env: {
        ROOMOTE_FAST_AGENT_CHILD: 'true',
        ROOMOTE_FAST_AGENT_CHILD_CHAT_RELAY: 'false',
        ROOMOTE_SLACK_HOOK_DEBUG: 'true',
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('decision="allow"');
    expect(result.stderr).toContain('reason="parent_session_report_disabled"');
  });

  it.each(['PreToolUse', 'PostToolUse'])(
    'does not enforce elapsed-time follow-through on %s',
    (hookEventName) => {
      const stateFilePath = writeState({
        recordedAtMs: Date.now() - 8 * 60_000,
        messageTs: 'bot-111.222',
      });

      const result = runHook({
        input: { hook_event_name: hookEventName, tool_name: 'shell' },
        env: {
          ROOMOTE_SLACK_HOOK_DEBUG: 'true',
          ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('decision="allow"');
      expect(result.stderr).toContain('reason="event_driven_checks_complete"');
    },
  );

  it('keeps terminal-closeout bookkeeping for coding tasks', () => {
    const stateFilePath = writeState({
      recordedAtMs: Date.now() - 60_000,
      messageTs: 'bot-111.222',
      tool: 'report_to_parent_session',
      replyPurpose: 'closeout',
      satisfiedTurnMessageTs: 'web:client-1',
      currentTurnMessageTs: 'web:client-1',
      terminalSatisfiedTurnMessageTs: 'web:client-1',
      terminalSatisfiedAtMs: Date.now() - 60_000,
      terminalSatisfactionTool: 'report_to_parent_session',
    });

    const result = runHook({
      input: { hook_event_name: 'PostToolUse', tool_name: 'shell' },
      env: {
        ROOMOTE_FAST_AGENT_CHILD: 'true',
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(
      JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))
        .lastNonSlackWorkAfterTerminalAtMs,
    ).toEqual(expect.any(Number));
  });

  it('allows non-posting tools for non-parent subagent threads', () => {
    const stateFilePath = writeState({
      parentThreadId: 'thread-parent',
      currentTurnMessageTs: 'user-111.222',
      currentTurnStartedAtMs: Date.now() - 10_000,
      recordedAtMs: Date.now() - 10_000,
    });

    const result = runHook({
      input: {
        hook_event_name: 'PreToolUse',
        threadId: 'thread-subagent',
        tool_name: 'shell',
      },
      env: {
        ROOMOTE_SLACK_HOOK_DEBUG: '1',
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('decision="allow"');
    expect(result.stderr).toContain('reason="non_parent_thread"');
  });

  it.each([
    'mcp__roomote__send_chat_reply',
    'roomote_send_chat_reply',
    'mcp__roomote__report_to_parent_session',
    'mcp__roomote__send_chat_reaction_emoji',
    'roomote_reply_to_slack_thread',
  ])('denies %s from non-parent subagent threads', (toolName) => {
    const stateFilePath = writeState({
      parentThreadId: 'thread-parent',
      currentTurnMessageTs: 'user-111.222',
      currentTurnStartedAtMs: Date.now() - 10_000,
      recordedAtMs: Date.now() - 10_000,
    });

    const result = runHook({
      input: {
        hook_event_name: 'PreToolUse',
        threadId: 'thread-subagent',
        tool_name: toolName,
      },
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      decision: 'block',
      permissionDecision: 'deny',
      reason: subagentSlackPostDenial,
    });
    expect(result.stderr).toContain('decision="deny"');
    expect(result.stderr).toContain('reason="subagent_slack_post"');
  });

  it('does not hard-deny subagent Slack posts on PostToolUse', () => {
    const stateFilePath = writeState({
      parentThreadId: 'thread-parent',
      currentTurnMessageTs: 'user-111.222',
      currentTurnStartedAtMs: Date.now() - 10_000,
      recordedAtMs: Date.now() - 10_000,
    });

    const result = runHook({
      input: {
        hook_event_name: 'PostToolUse',
        threadId: 'thread-subagent',
        tool_name: 'mcp__roomote__send_chat_reply',
      },
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('allows send_chat_reply from the parent thread', () => {
    const stateFilePath = writeState({
      parentThreadId: 'thread-parent',
      currentTurnMessageTs: 'user-111.222',
      currentTurnStartedAtMs: Date.now() - 10_000,
      recordedAtMs: Date.now() - 10_000,
    });

    const result = runHook({
      input: {
        hook_event_name: 'PreToolUse',
        threadId: 'thread-parent',
        tool_name: 'mcp__roomote__send_chat_reply',
      },
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('allows request_user_input from non-parent subagent threads', () => {
    const stateFilePath = writeState({
      parentThreadId: 'thread-parent',
      currentTurnMessageTs: 'user-111.222',
      currentTurnStartedAtMs: Date.now() - 10_000,
      recordedAtMs: Date.now() - 10_000,
    });

    const result = runHook({
      input: {
        hook_event_name: 'PreToolUse',
        threadId: 'thread-subagent',
        tool_name: 'request_user_input',
      },
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('nudges once before work without a Slack reply starts on an unacknowledged Slack turn', () => {
    const stateFilePath = writeState({
      currentTurnMessageTs: 'user-111.222',
      currentTurnStartedAtMs: Date.now() - 10_000,
      recordedAtMs: Date.now() - 10_000,
    });

    const result = runHook({
      input: { hook_event_name: 'PreToolUse', tool_name: 'shell' },
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      decision: 'block',
      reason: initialAckReminder,
    });
    expect(
      JSON.parse(fs.readFileSync(stateFilePath, 'utf8')).initialAckReminderAtMs,
    ).toEqual(expect.any(Number));
    expect(result.stderr).toContain('reason="initial_slack_ack_missing"');
  });

  it('continues blocking work without a Slack reply until a Slack-visible ack is recorded', () => {
    const stateFilePath = writeState({
      currentTurnMessageTs: 'user-111.222',
      currentTurnStartedAtMs: Date.now() - 10_000,
      recordedAtMs: Date.now() - 10_000,
      initialAckReminderAtMs: Date.now() - 5_000,
    });

    const result = runHook({
      input: { hook_event_name: 'PreToolUse', tool_name: 'shell' },
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      decision: 'block',
      reason: initialAckReminder,
    });
    expect(result.stderr).toContain('reason="initial_slack_ack_missing"');
  });

  it('blocks update_plan before the current Slack turn has been acknowledged', () => {
    const stateFilePath = writeState({
      currentTurnMessageTs: 'user-111.222',
      currentTurnStartedAtMs: Date.now() - 10_000,
      recordedAtMs: Date.now() - 10_000,
    });

    const result = runHook({
      input: {
        hook_event_name: 'PreToolUse',
        tool_name: 'functions.update_plan',
      },
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      decision: 'block',
      reason: initialAckReminder,
    });
    expect(result.stderr).toContain('tool="functions.update_plan"');
  });

  it('allows work before the first reply when the current turn skips the initial ack requirement', () => {
    const stateFilePath = writeState({
      currentTurnMessageTs: 'user-111.222',
      currentTurnStartedAtMs: Date.now() - 10_000,
      currentTurnRequiresInitialAck: false,
    });

    const result = runHook({
      input: { hook_event_name: 'PreToolUse', tool_name: 'shell' },
      env: {
        ROOMOTE_SLACK_HOOK_DEBUG: '1',
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('decision="allow"');
    expect(result.stderr).toContain('reason="event_driven_checks_complete"');
    expect(
      JSON.parse(fs.readFileSync(stateFilePath, 'utf8')),
    ).not.toHaveProperty('initialAckReminderAtMs');
  });

  it('allows late-bound automation work before the first reply', () => {
    const stateFilePath = writeState({
      startedAtMs: Date.now() - 8 * 60_000,
      currentTurnRequiresInitialAck: false,
    });

    const result = runHook({
      input: { hook_event_name: 'PreToolUse', tool_name: 'shell' },
      env: {
        ROOMOTE_SLACK_HOOK_DEBUG: '1',
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('decision="allow"');
    expect(result.stderr).toContain('reason="event_driven_checks_complete"');
  });

  it.each(['ack', 'progress'])(
    'rejects %s replies from late-bound automation tasks',
    (purpose) => {
      const stateFilePath = writeState({
        startedAtMs: Date.now(),
        currentTurnRequiresInitialAck: false,
        requiresTerminalCloseoutWithoutTurn: true,
      });

      const result = runHook({
        input: {
          hook_event_name: 'PreToolUse',
          tool_name: 'roomote_send_chat_reply',
          tool_args: { purpose },
        },
        env: {
          ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
        },
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        decision: 'block',
        permissionDecision: 'deny',
      });
    },
  );

  it('allows a terminal reply from a late-bound automation task', () => {
    const stateFilePath = writeState({
      startedAtMs: Date.now(),
      currentTurnRequiresInitialAck: false,
      requiresTerminalCloseoutWithoutTurn: true,
    });

    const result = runHook({
      input: {
        hook_event_name: 'PreToolUse',
        tool_name: 'roomote_send_chat_reply',
        tool_args: { purpose: 'closeout' },
      },
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('allows a clarification from a late-bound automation task', () => {
    const stateFilePath = writeState({
      startedAtMs: Date.now(),
      currentTurnRequiresInitialAck: false,
      requiresTerminalCloseoutWithoutTurn: true,
    });

    const result = runHook({
      input: {
        hook_event_name: 'PreToolUse',
        tool_name: 'roomote_send_chat_reply',
        tool_args: { purpose: 'clarification' },
      },
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('allows tool_search before the current Slack turn has been acknowledged', () => {
    const stateFilePath = writeState({
      currentTurnMessageTs: 'user-111.222',
      currentTurnStartedAtMs: Date.now() - 10_000,
      recordedAtMs: Date.now() - 10_000,
    });

    const result = runHook({
      input: {
        hook_event_name: 'PreToolUse',
        tool_name: 'tool_search.tool_search_tool',
      },
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('stands down entirely when delivery to the bound channel has permanently failed', () => {
    const stateFilePath = writeState({
      startedAtMs: Date.now(),
      deliveryFailureCount: 5,
      lastDeliveryFailureCode: 'not_in_channel',
      terminalDeliveryFailureAtMs: Date.now() - 5_000,
    });

    const result = runHook({
      input: { hook_event_name: 'PostToolUse', tool_name: 'shell' },
      env: {
        ROOMOTE_SLACK_HOOK_DEBUG: '1',
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('decision="allow"');
    expect(result.stderr).toContain('reason="terminal_delivery_failure"');
  });

  it('blocks the current-turn Slack reaction shortcut for a web-originated turn', () => {
    const stateFilePath = writeState({
      currentTurnMessageTs: 'web:client-1',
      currentTurnStartedAtMs: Date.now() - 10_000,
      recordedAtMs: Date.now() - 10_000,
    });

    const result = runHook({
      input: {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__roomote__send_chat_reaction_emoji',
      },
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      decision: 'block',
      reason: initialAckReminder,
    });
    expect(result.stderr).toContain('reason="initial_slack_ack_missing"');
  });

  it('records non-Slack work after a terminal closeout on PostToolUse', () => {
    const stateFilePath = writeState({
      recordedAtMs: Date.now() - 60_000,
      messageTs: 'bot-111.222',
      tool: 'send_chat_reply',
      replyPurpose: 'closeout',
      satisfiedTurnMessageTs: 'web:client-1',
      currentTurnMessageTs: 'web:client-1',
      terminalSatisfiedTurnMessageTs: 'web:client-1',
      terminalSatisfiedAtMs: Date.now() - 60_000,
      terminalSatisfactionTool: 'send_chat_reply',
    });

    const result = runHook({
      input: { hook_event_name: 'PostToolUse', tool_name: 'shell' },
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(
      JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))
        .lastNonSlackWorkAfterTerminalAtMs,
    ).toEqual(expect.any(Number));
  });

  it('records non-Slack work after a no-turn automation closeout on PostToolUse', () => {
    const stateFilePath = writeState({
      startedAtMs: Date.now() - 120_000,
      requiresTerminalCloseoutWithoutTurn: true,
      recordedAtMs: Date.now() - 60_000,
      messageTs: '1781240291.069569',
      tool: 'send_chat_reply',
      replyPurpose: 'closeout',
    });

    const result = runHook({
      input: { hook_event_name: 'PostToolUse', tool_name: 'shell' },
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(
      JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))
        .lastNonSlackWorkAfterTerminalAtMs,
    ).toEqual(expect.any(Number));
  });

  it('does not record post-closeout work for no-turn tasks without the automation flag', () => {
    const stateFilePath = writeState({
      startedAtMs: Date.now() - 120_000,
      recordedAtMs: Date.now() - 60_000,
      messageTs: '1781240291.069569',
      tool: 'send_chat_reply',
      replyPurpose: 'closeout',
    });

    const result = runHook({
      input: { hook_event_name: 'PostToolUse', tool_name: 'shell' },
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(
      JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))
        .lastNonSlackWorkAfterTerminalAtMs,
    ).toBeUndefined();
  });

  it('ignores update_plan bookkeeping after a terminal closeout on PostToolUse', () => {
    const stateFilePath = writeState({
      recordedAtMs: Date.now() - 60_000,
      messageTs: 'bot-111.222',
      tool: 'send_chat_reply',
      replyPurpose: 'closeout',
      satisfiedTurnMessageTs: 'web:client-1',
      currentTurnMessageTs: 'web:client-1',
      terminalSatisfiedTurnMessageTs: 'web:client-1',
      terminalSatisfiedAtMs: Date.now() - 60_000,
      terminalSatisfactionTool: 'send_chat_reply',
    });

    const result = runHook({
      input: {
        hook_event_name: 'PostToolUse',
        tool_name: 'functions.update_plan',
      },
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(
      JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))
        .lastNonSlackWorkAfterTerminalAtMs,
    ).toBeUndefined();
  });

  it.each(['todowrite', 'todoread'])(
    'ignores %s todo bookkeeping after a terminal closeout on PostToolUse',
    (toolName) => {
      const stateFilePath = writeState({
        recordedAtMs: Date.now() - 60_000,
        messageTs: 'bot-111.222',
        tool: 'send_chat_reply',
        replyPurpose: 'closeout',
        satisfiedTurnMessageTs: 'web:client-1',
        currentTurnMessageTs: 'web:client-1',
        terminalSatisfiedTurnMessageTs: 'web:client-1',
        terminalSatisfiedAtMs: Date.now() - 60_000,
        terminalSatisfactionTool: 'send_chat_reply',
      });

      const result = runHook({
        input: {
          hook_event_name: 'PostToolUse',
          tool_name: toolName,
        },
        env: {
          ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(
        JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))
          .lastNonSlackWorkAfterTerminalAtMs,
      ).toBeUndefined();
    },
  );

  it.each(['request_user_input', 'request_user_input_handoff'])(
    'ignores %s bookkeeping after a terminal closeout on PostToolUse',
    (toolName) => {
      const stateFilePath = writeState({
        recordedAtMs: Date.now() - 60_000,
        messageTs: 'bot-111.222',
        tool: 'send_chat_reply',
        replyPurpose: 'closeout',
        satisfiedTurnMessageTs: 'web:client-1',
        currentTurnMessageTs: 'web:client-1',
        terminalSatisfiedTurnMessageTs: 'web:client-1',
        terminalSatisfiedAtMs: Date.now() - 60_000,
        terminalSatisfactionTool: 'send_chat_reply',
      });

      const result = runHook({
        input: {
          hook_event_name: 'PostToolUse',
          tool_name: toolName,
        },
        env: {
          ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(
        JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))
          .lastNonSlackWorkAfterTerminalAtMs,
      ).toBeUndefined();
    },
  );

  it('emits debug allow logs when hook debug logging is enabled', () => {
    const stateFilePath = writeState({
      recordedAtMs: Date.now() - 60_000,
      messageTs: 'bot-111.222',
    });

    const result = runHook({
      input: { hook_event_name: 'PreToolUse', tool_name: 'shell' },
      env: {
        ROOMOTE_SLACK_HOOK_DEBUG: '1',
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('INFO [SlackHook] Hook decision');
    expect(result.stderr).toContain('decision="allow"');
    expect(result.stderr).toContain('reason="event_driven_checks_complete"');
  });
});
