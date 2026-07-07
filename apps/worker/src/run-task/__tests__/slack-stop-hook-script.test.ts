import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SLACK_STOP_HOOK_SCRIPT } from '../slack-stop-hook-script';

describe('SLACK_STOP_HOOK_SCRIPT', () => {
  const tempDirs: string[] = [];
  const reminder =
    'Before finalizing, post a terminal Slack-visible reply for the current turn: use send_chat_reply with purpose "closeout" for the answer, result, blocker, or handoff. Use request_user_input only when you genuinely require structured input from the user. Do not continue other work first.';

  function writeHook(): string {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-stop-hook-'),
    );
    tempDirs.push(tempDir);
    const hookPath = path.join(tempDir, 'hook.cjs');
    fs.writeFileSync(hookPath, SLACK_STOP_HOOK_SCRIPT, 'utf8');
    return hookPath;
  }

  function runHook(
    options: {
      input?: unknown;
      env?: Record<string, string>;
    } = {},
  ) {
    const hookPath = writeHook();
    return spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(options.input ?? {}),
      encoding: 'utf8',
      env: {
        ...process.env,
        ROOMOTE_SLACK_HOOK_DEBUG: undefined,
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: undefined,
        ...options.env,
      },
    });
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

  it('does nothing when OpenCode says the stop hook is already active', () => {
    const result = runHook({
      input: { stop_hook_active: true },
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: '/tmp/roomote-state.json',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('allows Stop for non-parent subagent threads', () => {
    const stateFilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-stop-state-')),
      'state.json',
    );
    tempDirs.push(path.dirname(stateFilePath));
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        parentThreadId: 'thread-parent',
        currentTurnMessageTs: 'user-111.222',
      }),
      'utf8',
    );

    const result = runHook({
      input: { threadId: 'thread-subagent' },
      env: {
        ROOMOTE_SLACK_HOOK_DEBUG: 'true',
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('decision="allow"');
    expect(result.stderr).toContain('reason="non_parent_thread"');
  });

  it('blocks Stop when Slack reply satisfaction is configured and no successful reply has been recorded', () => {
    const result = runHook({
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: '/tmp/roomote-state.json',
      },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      decision: 'block',
      reason: reminder,
    });
    expect(result.stderr).toContain('INFO [SlackHook] Hook decision');
    expect(result.stderr).toContain('hook="slack-stop"');
    expect(result.stderr).toContain('trigger="Stop"');
    expect(result.stderr).toContain('decision="block"');
    expect(result.stderr).toContain('reason="current_turn_unsatisfied"');
  });

  it('allows Stop for Slack-capable tasks before any Slack turn starts', () => {
    const stateFilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-stop-state-')),
      'state.json',
    );
    tempDirs.push(path.dirname(stateFilePath));
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        startedAtMs: Date.now(),
      }),
      'utf8',
    );

    const result = runHook({
      env: {
        ROOMOTE_SLACK_HOOK_DEBUG: 'true',
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('decision="allow"');
    expect(result.stderr).toContain('reason="no_current_slack_turn"');
  });

  it('blocks Stop when an automation-started task has not posted its closeout', () => {
    const stateFilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-stop-state-')),
      'state.json',
    );
    tempDirs.push(path.dirname(stateFilePath));
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        startedAtMs: Date.now(),
        requiresTerminalCloseoutWithoutTurn: true,
      }),
      'utf8',
    );

    const result = runHook({
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    const decision = JSON.parse(result.stdout);
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain(
      'This automation-started task has not posted its Slack closeout yet.',
    );
    expect(decision.reason).toContain('send_chat_reply purpose "closeout"');
    expect(decision.reason).toContain(
      'what the automation asked you to investigate and the concrete outcome (PR link, no-op or deferred reason, or blocker).',
    );
    expect(decision.reason).not.toContain('trusting the result');
    expect(decision.reason).not.toContain("changes the user's next step");
    expect(result.stderr).toContain(
      'reason="automation_missing_terminal_closeout"',
    );
  });

  it('allows Stop when an automation-started task posted its closeout without an inbound turn', () => {
    const stateFilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-stop-state-')),
      'state.json',
    );
    tempDirs.push(path.dirname(stateFilePath));
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        startedAtMs: Date.now() - 60_000,
        requiresTerminalCloseoutWithoutTurn: true,
        messageTs: '1781240291.069569',
        tool: 'send_chat_reply',
        replyPurpose: 'closeout',
        recordedAtMs: Date.now() - 31_000,
      }),
      'utf8',
    );

    const result = runHook({
      env: {
        ROOMOTE_SLACK_HOOK_DEBUG: 'true',
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('decision="allow"');
    expect(result.stderr).toContain('reason="terminal_reply_satisfied"');
  });

  it('blocks Stop when non-Slack work happened after a no-turn automation closeout', () => {
    const closeoutAtMs = Date.now() - 60_000;
    const stateFilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-stop-state-')),
      'state.json',
    );
    tempDirs.push(path.dirname(stateFilePath));
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        startedAtMs: closeoutAtMs - 60_000,
        requiresTerminalCloseoutWithoutTurn: true,
        messageTs: '1781240291.069569',
        tool: 'send_chat_reply',
        replyPurpose: 'closeout',
        recordedAtMs: closeoutAtMs,
        lastNonSlackWorkAfterTerminalAtMs: closeoutAtMs + 30_000,
      }),
      'utf8',
    );

    const result = runHook({
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      decision: 'block',
      reason: reminder,
    });
    expect(result.stderr).toContain(
      'reason="current_turn_terminal_reply_stale"',
    );
  });

  it('allows Stop when the current Slack turn has a terminal closeout reply older than 30 seconds', () => {
    const stateFilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-stop-state-')),
      'state.json',
    );
    tempDirs.push(path.dirname(stateFilePath));
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: 'user-111.222',
        satisfiedTurnMessageTs: 'user-111.222',
        terminalSatisfiedTurnMessageTs: 'user-111.222',
        terminalSatisfiedAtMs: Date.now() - 60_000,
        terminalSatisfactionTool: 'send_chat_reply',
        messageTs: 'bot-333.444',
        tool: 'send_chat_reply',
        replyPurpose: 'closeout',
        recordedAtMs: Date.now() - 60_000,
      }),
      'utf8',
    );

    const result = runHook({
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('allows Stop for legacy successful replies without recorded purpose', () => {
    const stateFilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-stop-state-')),
      'state.json',
    );
    tempDirs.push(path.dirname(stateFilePath));
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: 'user-111.222',
        satisfiedTurnMessageTs: 'user-111.222',
        messageTs: 'bot-333.444',
        tool: 'send_chat_reply',
        recordedAtMs: Date.now(),
      }),
      'utf8',
    );

    const result = runHook({
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it.each(['ack', 'progress', 'clarification'])(
    'blocks Stop when the recent send_chat_reply purpose is %s',
    (replyPurpose) => {
      const stateFilePath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-stop-state-')),
        'state.json',
      );
      tempDirs.push(path.dirname(stateFilePath));
      fs.writeFileSync(
        stateFilePath,
        JSON.stringify({
          currentTurnMessageTs: 'user-111.222',
          satisfiedTurnMessageTs: 'user-111.222',
          messageTs: 'bot-333.444',
          tool: 'send_chat_reply',
          replyPurpose,
          recordedAtMs: Date.now(),
        }),
        'utf8',
      );

      const result = runHook({
        env: {
          ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
        },
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        decision: 'block',
        reason: reminder,
      });
      expect(result.stderr).toContain('decision="block"');
      expect(result.stderr).toContain(
        'reason="current_turn_nonterminal_reply"',
      );
      expect(result.stderr).toContain(`replyPurpose="${replyPurpose}"`);
    },
  );

  it('blocks Stop when the current Slack turn only has a recent successful reaction', () => {
    const stateFilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-stop-state-')),
      'state.json',
    );
    tempDirs.push(path.dirname(stateFilePath));
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: 'user-111.222',
        satisfiedTurnMessageTs: 'user-111.222',
        messageTs: 'user-111.222',
        tool: 'add_reaction_to_slack_message',
        recordedAtMs: Date.now(),
      }),
      'utf8',
    );

    const result = runHook({
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      decision: 'block',
      reason: reminder,
    });
    expect(result.stderr).toContain('decision="block"');
    expect(result.stderr).toContain(
      'reason="current_turn_nonterminal_reaction"',
    );
  });

  it('blocks Stop when the current Slack turn only has a recent shortcut reaction', () => {
    const stateFilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-stop-state-')),
      'state.json',
    );
    tempDirs.push(path.dirname(stateFilePath));
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: 'user-111.222',
        satisfiedTurnMessageTs: 'user-111.222',
        messageTs: 'user-111.222',
        tool: 'send_chat_reaction_emoji',
        recordedAtMs: Date.now(),
      }),
      'utf8',
    );

    const result = runHook({
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      decision: 'block',
      reason: reminder,
    });
    expect(result.stderr).toContain('decision="block"');
    expect(result.stderr).toContain(
      'reason="current_turn_nonterminal_reaction"',
    );
  });

  it('allows Stop when a valid terminal closeout exists for the current turn and a later reaction was recorded', () => {
    const stateFilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-stop-state-')),
      'state.json',
    );
    tempDirs.push(path.dirname(stateFilePath));
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: 'user-111.222',
        satisfiedTurnMessageTs: 'user-111.222',
        terminalSatisfiedTurnMessageTs: 'user-111.222',
        terminalSatisfiedAtMs: Date.now() - 60_000,
        terminalSatisfactionTool: 'send_chat_reply',
        messageTs: 'user-111.222',
        tool: 'send_chat_reaction_emoji',
        recordedAtMs: Date.now(),
      }),
      'utf8',
    );

    const result = runHook({
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('blocks Stop when only a previous Slack turn has a recent successful reply', () => {
    const stateFilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-stop-state-')),
      'state.json',
    );
    tempDirs.push(path.dirname(stateFilePath));
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: 'user-222.333',
        satisfiedTurnMessageTs: 'user-111.222',
        messageTs: 'bot-333.444',
        recordedAtMs: Date.now(),
      }),
      'utf8',
    );

    const result = runHook({
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      decision: 'block',
      reason: reminder,
    });
    expect(result.stderr).toContain('decision="block"');
  });

  it('blocks Stop when legacy state marks the turn satisfied via request_user_input', () => {
    const stateFilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-stop-state-')),
      'state.json',
    );
    tempDirs.push(path.dirname(stateFilePath));
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: 'user-111.222',
        satisfiedTurnMessageTs: 'user-111.222',
        messageTs: 'bot-333.444',
        tool: 'request_user_input',
        recordedAtMs: Date.now(),
      }),
      'utf8',
    );

    const result = runHook({
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      decision: 'block',
      reason: reminder,
    });
    expect(result.stderr).toContain('decision="block"');
    expect(result.stderr).toContain('reason="current_turn_unsatisfied"');
  });

  it('blocks Stop when non-Slack work happened after a terminal closeout', () => {
    const stateFilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-stop-state-')),
      'state.json',
    );
    tempDirs.push(path.dirname(stateFilePath));
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: 'user-111.222',
        satisfiedTurnMessageTs: 'user-111.222',
        terminalSatisfiedTurnMessageTs: 'user-111.222',
        terminalSatisfiedAtMs: 1_000,
        terminalSatisfactionTool: 'send_chat_reply',
        lastNonSlackWorkAfterTerminalAtMs: 2_000,
        messageTs: 'bot-333.444',
        tool: 'send_chat_reply',
        replyPurpose: 'closeout',
        recordedAtMs: 1_000,
      }),
      'utf8',
    );

    const result = runHook({
      env: {
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      decision: 'block',
      reason: reminder,
    });
    expect(result.stderr).toContain('decision="block"');
    expect(result.stderr).toContain(
      'reason="current_turn_terminal_reply_stale"',
    );
  });

  it('emits debug allow logs when hook debug logging is enabled', () => {
    const stateFilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-stop-state-')),
      'state.json',
    );
    tempDirs.push(path.dirname(stateFilePath));
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: 'user-111.222',
        satisfiedTurnMessageTs: 'user-111.222',
        terminalSatisfiedTurnMessageTs: 'user-111.222',
        terminalSatisfiedAtMs: Date.now() - 60_000,
        terminalSatisfactionTool: 'send_chat_reply',
        messageTs: 'bot-333.444',
        tool: 'send_chat_reply',
        replyPurpose: 'closeout',
        recordedAtMs: Date.now() - 60_000,
      }),
      'utf8',
    );

    const result = runHook({
      env: {
        ROOMOTE_SLACK_HOOK_DEBUG: 'true',
        ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE: stateFilePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('INFO [SlackHook] Hook decision');
    expect(result.stderr).toContain('decision="allow"');
    expect(result.stderr).toContain('reason="terminal_reply_satisfied"');
  });
});
