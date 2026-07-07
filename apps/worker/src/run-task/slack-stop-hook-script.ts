export const SLACK_STOP_HOOK_SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const REMINDER = [
  'Before finalizing, post a terminal Slack-visible reply for the current turn:',
  'use send_chat_reply with purpose "closeout" for the answer, result, blocker, or handoff.',
  'Use request_user_input only when you genuinely require structured input from the user.',
  'Do not continue other work first.',
].join(' ');
const AUTOMATION_CLOSEOUT_REMINDER = [
  'This automation-started task has not posted its Slack closeout yet.',
  'Before finalizing, post one self-contained Slack message with send_chat_reply purpose "closeout" that explains',
  'what the automation asked you to investigate and the concrete outcome (PR link, no-op or deferred reason, or blocker).',
  'Do not start new work first.',
].join(' ');
const HOOK_NAME = 'slack-stop';
const HOOK_DEBUG_ENV = 'ROOMOTE_SLACK_HOOK_DEBUG';

function isHookDebugEnabled() {
  const value = process.env[HOOK_DEBUG_ENV];
  return value === '1' || value === 'true';
}

function formatLogFieldValue(value) {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }

  if (value === null) {
    return 'null';
  }

  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string'
      ? serialized
      : JSON.stringify(String(value));
  } catch {
    return JSON.stringify(String(value));
  }
}

function formatLogFields(fields) {
  return Object.entries(fields)
    .filter(([, value]) => typeof value !== 'undefined')
    .map(([key, value]) => \`\${key}=\${formatLogFieldValue(value)}\`)
    .join(' ');
}

function logHook(level, message, fields) {
  const suffix = formatLogFields(fields);
  const line = \`\${level} [SlackHook] \${message}\${suffix ? \` \${suffix}\` : ''}\\n\`;
  process.stderr.write(line);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });
}

function parseHookInput(rawInput) {
  try {
    return JSON.parse(rawInput || '{}');
  } catch {
    return {};
  }
}

function isStopHookActive(rawInput) {
  try {
    const input = JSON.parse(rawInput || '{}');
    return input.stop_hook_active === true;
  } catch {
    return false;
  }
}

function readState(stateFilePath) {
  if (!stateFilePath) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(stateFilePath, state) {
  if (!stateFilePath) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(stateFilePath), {
      recursive: true,
    });
    fs.writeFileSync(stateFilePath, JSON.stringify(state), 'utf8');
  } catch {
    // Ignore hook bookkeeping failures and fall back to the existing behavior.
  }
}

function logBlock(fields) {
  logHook('INFO', 'Hook decision', {
    hook: HOOK_NAME,
    trigger: 'Stop',
    decision: 'block',
    ...fields,
  });
}

function logAllow(fields) {
  if (!isHookDebugEnabled()) {
    return;
  }

  logHook('INFO', 'Hook decision', {
    hook: HOOK_NAME,
    trigger: 'Stop',
    decision: 'allow',
    ...fields,
  });
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecordedRequestUserInputTool(tool) {
  return tool === 'request_user_input' || tool === 'request_user_input_handoff';
}

function getHookThreadId(input) {
  if (!input || typeof input !== 'object') {
    return '';
  }

  const threadId =
    typeof input.thread_id === 'string'
      ? input.thread_id
      : typeof input.threadId === 'string'
        ? input.threadId
        : '';

  return trimString(threadId);
}

function readFiniteMs(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function ensureParentThreadState(stateFilePath, state, hookThreadId) {
  if (!hookThreadId) {
    return state;
  }

  const parentThreadId = trimString(state && state.parentThreadId);
  if (parentThreadId) {
    return state;
  }

  const nextState = {
    ...(state && typeof state === 'object' ? state : {}),
    parentThreadId: hookThreadId,
  };
  writeState(stateFilePath, nextState);
  return nextState;
}

function isNonParentThread(state, hookThreadId) {
  if (!hookThreadId) {
    return false;
  }

  const parentThreadId = trimString(state && state.parentThreadId);
  return Boolean(parentThreadId) && parentThreadId !== hookThreadId;
}

function isCurrentTurnSatisfied(state) {
  const tool = trimString(state && state.tool);
  if (isRecordedRequestUserInputTool(tool)) {
    return false;
  }

  const messageTs = trimString(state && state.messageTs);
  if (!messageTs) {
    return false;
  }

  const currentTurnMessageTs = trimString(state && state.currentTurnMessageTs);
  if (!currentTurnMessageTs) {
    return true;
  }

  return trimString(state && state.satisfiedTurnMessageTs) === currentTurnMessageTs;
}

function getLegacyTerminalSatisfaction(state, currentTurnMessageTs) {
  const tool = trimString(state && state.tool);
  if (tool !== 'send_chat_reply') {
    return null;
  }

  const replyPurpose = trimString(state && state.replyPurpose);
  if (replyPurpose && replyPurpose !== 'closeout') {
    return null;
  }

  if (trimString(state && state.satisfiedTurnMessageTs) !== currentTurnMessageTs) {
    return null;
  }

  const recordedAtMs = readFiniteMs(state && state.recordedAtMs);
  if (recordedAtMs === null) {
    return null;
  }

  return {
    turnMessageTs: currentTurnMessageTs,
    atMs: recordedAtMs,
    source: 'legacy',
  };
}

function getCurrentTurnTerminalSatisfaction(state) {
  const currentTurnMessageTs = trimString(state && state.currentTurnMessageTs);
  if (!currentTurnMessageTs) {
    const tool = trimString(state && state.tool);
    if (tool !== 'send_chat_reply') {
      return null;
    }

    const replyPurpose = trimString(state && state.replyPurpose);
    if (replyPurpose && replyPurpose !== 'closeout') {
      return null;
    }

    const recordedAtMs = readFiniteMs(state && state.recordedAtMs);
    if (recordedAtMs === null) {
      return null;
    }

    return {
      turnMessageTs: '',
      atMs: recordedAtMs,
      source: 'legacy-without-turn',
    };
  }

  const terminalTurnMessageTs = trimString(
    state && state.terminalSatisfiedTurnMessageTs,
  );
  const terminalSatisfiedAtMs = readFiniteMs(
    state && state.terminalSatisfiedAtMs,
  );

  if (
    terminalTurnMessageTs === currentTurnMessageTs &&
    terminalSatisfiedAtMs !== null
  ) {
    return {
      turnMessageTs: terminalTurnMessageTs,
      atMs: terminalSatisfiedAtMs,
      source: 'recorded',
    };
  }

  return getLegacyTerminalSatisfaction(state, currentTurnMessageTs);
}

function hasConfiguredSlackReplyStateWithoutTurn(state) {
  if (!state || typeof state !== 'object') {
    return false;
  }

  return (
    readFiniteMs(state.startedAtMs) !== null &&
    !trimString(state.currentTurnMessageTs) &&
    !trimString(state.messageTs)
  );
}

function hasNonSlackWorkAfterTerminalSatisfaction(state, terminalSatisfaction) {
  if (!terminalSatisfaction) {
    return false;
  }

  const lastNonSlackWorkAfterTerminalAtMs = readFiniteMs(
    state && state.lastNonSlackWorkAfterTerminalAtMs,
  );

  return (
    lastNonSlackWorkAfterTerminalAtMs !== null &&
    lastNonSlackWorkAfterTerminalAtMs > terminalSatisfaction.atMs
  );
}

function getTerminalCurrentTurnFailureReason(state) {
  const terminalSatisfaction = getCurrentTurnTerminalSatisfaction(state);
  if (terminalSatisfaction) {
    return hasNonSlackWorkAfterTerminalSatisfaction(state, terminalSatisfaction)
      ? 'current_turn_terminal_reply_stale'
      : null;
  }

  const tool = trimString(state && state.tool);
  if (isRecordedRequestUserInputTool(tool)) {
    return 'current_turn_nonterminal_request_user_input';
  }

  if (
    tool === 'send_chat_reaction_emoji' ||
    tool === 'add_reaction_to_slack_message'
  ) {
    return 'current_turn_nonterminal_reaction';
  }

  if (!tool || tool !== 'send_chat_reply') {
    return null;
  }

  const replyPurpose = trimString(state && state.replyPurpose);
  if (replyPurpose && replyPurpose !== 'closeout') {
    return 'current_turn_nonterminal_reply';
  }

  return 'current_turn_missing_terminal_reply';
}

(async () => {
  const stateFilePath = process.env.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE;
  if (!stateFilePath) {
    logAllow({ reason: 'slack_reply_satisfaction_not_configured' });
    process.exit(0);
  }

  const rawInput = await readStdin();
  const hookInput = parseHookInput(rawInput);
  if (isStopHookActive(rawInput)) {
    logAllow({ reason: 'stop_hook_already_active' });
    process.exit(0);
  }

  const hookThreadId = getHookThreadId(hookInput);
  let state = ensureParentThreadState(
    stateFilePath,
    readState(stateFilePath),
    hookThreadId,
  );
  if (isNonParentThread(state, hookThreadId)) {
    logAllow({ reason: 'non_parent_thread', hookThreadId });
    process.exit(0);
  }

  if (hasConfiguredSlackReplyStateWithoutTurn(state)) {
    if (state && state.requiresTerminalCloseoutWithoutTurn === true) {
      logBlock({
        reason: 'automation_missing_terminal_closeout',
        stateFilePath,
      });
      process.stdout.write(
        JSON.stringify({ decision: 'block', reason: AUTOMATION_CLOSEOUT_REMINDER }),
      );
      process.exit(0);
    }

    logAllow({ reason: 'no_current_slack_turn' });
    process.exit(0);
  }

  if (!isCurrentTurnSatisfied(state)) {
    logBlock({
      reason: 'current_turn_unsatisfied',
      stateFilePath,
      currentTurnMessageTs: trimString(state && state.currentTurnMessageTs),
      satisfiedTurnMessageTs: trimString(state && state.satisfiedTurnMessageTs),
    });
    process.stdout.write(JSON.stringify({ decision: 'block', reason: REMINDER }));
    process.exit(0);
  }

  const terminalFailureReason = getTerminalCurrentTurnFailureReason(state);
  if (terminalFailureReason) {
    logBlock({
      reason: terminalFailureReason,
      stateFilePath,
      tool: trimString(state && state.tool),
      replyPurpose: trimString(state && state.replyPurpose),
      currentTurnMessageTs: trimString(state && state.currentTurnMessageTs),
      satisfiedTurnMessageTs: trimString(state && state.satisfiedTurnMessageTs),
      terminalSatisfiedTurnMessageTs: trimString(
        state && state.terminalSatisfiedTurnMessageTs,
      ),
      terminalSatisfiedAtMs: readFiniteMs(state && state.terminalSatisfiedAtMs),
      lastNonSlackWorkAfterTerminalAtMs: readFiniteMs(
        state && state.lastNonSlackWorkAfterTerminalAtMs,
      ),
    });
    process.stdout.write(JSON.stringify({ decision: 'block', reason: REMINDER }));
    process.exit(0);
  }

  logAllow({ reason: 'terminal_reply_satisfied' });
  process.exit(0);
})().catch(() => {
  logHook('ERROR', 'Hook failure', {
    hook: HOOK_NAME,
    trigger: 'Stop',
    decision: 'block',
    reason: 'unexpected_exception',
  });
  process.stdout.write(JSON.stringify({ decision: 'block', reason: REMINDER }));
});
`;
