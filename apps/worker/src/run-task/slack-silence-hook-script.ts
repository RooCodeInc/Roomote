import { SLACK_POSTING_TOOL_BASENAMES } from './slack-posting-tools';

export const SLACK_SILENCE_HOOK_SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

// Kept in sync with the config-level subagent exclusions through
// slack-posting-tools.ts. This hook deny is the default-closed backstop for
// sessions whose agent config does not already exclude the tools.
const SUBAGENT_RESTRICTED_SLACK_POSTING_TOOLS = ${JSON.stringify([
  ...SLACK_POSTING_TOOL_BASENAMES,
])};

// Mirrors the Roomote MCP server's getChatReplySurfaceLabel so reminders name
// the surface the task actually replies to instead of hardcoding Slack.
function getChatSurfaceLabel() {
  const provider = (process.env.ROOMOTE_COMMUNICATION_PROVIDER || '').trim();
  if (provider === 'teams') {
    return 'Teams';
  }
  if (provider === 'telegram') {
    return 'Telegram';
  }
  if (provider === 'discord') {
    return 'Discord';
  }
  return (process.env.ROOMOTE_SLACK_CHANNEL || '').trim() ? 'Slack' : 'chat';
}

const SURFACE_LABEL = getChatSurfaceLabel();
const REMINDER = [
  'The originating ' +
    SURFACE_LABEL +
    ' thread has not received a visible update for this turn. Your next action',
  'must be a ' +
    SURFACE_LABEL +
    '-visible update to the originating thread using',
  'send_chat_reply',
  'or use send_chat_reaction_emoji only when the latest user turn itself came',
  'from ' + SURFACE_LABEL + ' and that message can receive a reaction.',
  'If a successful visual-proof capture returned screenshot artifact IDs that',
  'are not yet visible in the thread and the update mentions or relies on that',
  'proof, include those IDs in the same reply via imageArtifactIds.',
  'Use request_user_input only when you genuinely require structured input',
  'from the user.',
  'Normal assistant messages do not count.',
  'Do not run more tools first.',
  'The only exception is tool_search when the needed ' +
    SURFACE_LABEL +
    ' reply/post tool is',
  'not visible.',
  'After sending the ' +
    SURFACE_LABEL +
    ' update, continue the work you were doing.',
].join(' ');
const INITIAL_ACK_REMINDER = [
  'Before starting work that will not post to ' +
    SURFACE_LABEL +
    ' on this turn, send a',
  'quick ' + SURFACE_LABEL + '-visible ack.',
  'When the latest user turn itself came from ' +
    SURFACE_LABEL +
    ', reactions are allowed on',
  'that message, and a lightweight acknowledgement is enough, start with',
  'send_chat_reaction_emoji.',
  'Otherwise use send_chat_reply.',
  'Do not use request_user_input as a generic opening acknowledgement;',
  'only use it when you genuinely require structured input from the user.',
  'If the needed ' +
    SURFACE_LABEL +
    ' reply/post tool is not visible, use tool_search first.',
  'If context is still too thin to say anything concrete and the turn does',
  'not allow reactions, keep the text ack short and non-speculative.',
  'After that, continue the work you were doing.',
].join(' ');
const SUBAGENT_SLACK_POST_DENIAL = [
  SURFACE_LABEL + '-posting tools are reserved for the parent agent session.',
  'This subagent session must not post to ' + SURFACE_LABEL + ' directly.',
  'Return your findings in your final report to the parent agent instead;',
  'the parent agent will relay any ' + SURFACE_LABEL + '-visible update.',
].join(' ');
const MAX_SILENCE_MS = 7 * 60 * 1000;
const HOOK_NAME = 'slack-silence';
const HOOK_DEBUG_ENV = 'ROOMOTE_SLACK_HOOK_DEBUG';
const SLACK_MESSAGE_TS_REGEX = /^\\d+\\.\\d+$/;

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
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseHookInput(rawInput) {
  try {
    return JSON.parse(rawInput || '{}');
  } catch {
    return {};
  }
}

function getHookEventName(input) {
  return input && input.hook_event_name === 'PreToolUse'
    ? 'PreToolUse'
    : 'PostToolUse';
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

function matchesToolBasename(input, basename) {
  const toolName =
    input && typeof input.tool_name === 'string' ? input.tool_name : '';

  return toolName.endsWith(basename) || toolName.includes('/' + basename);
}

function isSlackReactionShortcutTool(input) {
  return matchesToolBasename(input, 'send_chat_reaction_emoji');
}

function isSlackReplyToolDiscoveryTool(input) {
  const toolName =
    input && typeof input.tool_name === 'string' ? input.tool_name : '';

  return (
    toolName.endsWith('tool_search_tool') ||
    toolName.includes('/tool_search_tool') ||
    toolName.includes('.tool_search_tool')
  );
}

function isRecordedRequestUserInputTool(tool) {
  return tool === 'request_user_input' || tool === 'request_user_input_handoff';
}

function isSendChatReplyTool(input) {
  return matchesToolBasename(input, 'send_chat_reply');
}

function getSendChatReplyPurpose(input) {
  if (!input || typeof input !== 'object') {
    return '';
  }

  const toolArgs = input.tool_args;
  if (!toolArgs || typeof toolArgs !== 'object') {
    return '';
  }

  return trimString(toolArgs.purpose);
}

function isPrematureAutomationReply(input, state) {
  if (
    state?.requiresTerminalCloseoutWithoutTurn !== true ||
    trimString(state.currentTurnMessageTs)
  ) {
    return false;
  }

  if (!isSendChatReplyTool(input)) {
    return SUBAGENT_RESTRICTED_SLACK_POSTING_TOOLS.some((basename) =>
      matchesToolBasename(input, basename),
    );
  }

  const purpose = getSendChatReplyPurpose(input);
  return purpose !== 'closeout' && purpose !== 'clarification';
}

// Slack-posting tools that only the parent session may use. Subagent (child)
// sessions must return their report to the parent instead of posting.
function isSubagentRestrictedSlackPostingTool(input) {
  return SUBAGENT_RESTRICTED_SLACK_POSTING_TOOLS.some((basename) =>
    matchesToolBasename(input, basename),
  );
}

function isSlackSatisfactionTool(input, state) {
  const toolName =
    input && typeof input.tool_name === 'string' ? input.tool_name : '';
  const currentTurnMessageTs = trimString(state && state.currentTurnMessageTs);
  const currentTurnSupportsReactionShortcut =
    SLACK_MESSAGE_TS_REGEX.test(currentTurnMessageTs) &&
    (!state || state.currentTurnReactionsAllowed !== false);

  return (
    isSendChatReplyTool(input) ||
    toolName.endsWith('add_reaction_to_slack_message') ||
    toolName.includes('/add_reaction_to_slack_message') ||
    (isSlackReactionShortcutTool(input) && currentTurnSupportsReactionShortcut)
  );
}

function isCloseoutBookkeepingTool(input) {
  const toolName =
    input && typeof input.tool_name === 'string' ? input.tool_name : '';

  // Todo bookkeeping (OpenCode's todowrite/todoread, legacy update_plan) does
  // not add user-visible outcome, so it must not stale a terminal reply and
  // force a redundant follow-up closeout.
  return (
    toolName.endsWith('update_plan') ||
    toolName.includes('/update_plan') ||
    toolName.includes('.update_plan') ||
    toolName.endsWith('todowrite') ||
    toolName.endsWith('todoread')
  );
}

function isRequestUserInputTool(input) {
  const toolName =
    input && typeof input.tool_name === 'string' ? input.tool_name : '';

  return (
    toolName.endsWith('request_user_input') ||
    toolName.endsWith('request_user_input_handoff') ||
    toolName.includes('/request_user_input') ||
    toolName.includes('/request_user_input_handoff') ||
    toolName.includes('.request_user_input') ||
    toolName.includes('.request_user_input_handoff')
  );
}

function readState(stateFilePath) {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
  } catch {
    return null;
  }
}

function getToolName(input) {
  return input && typeof input.tool_name === 'string' ? input.tool_name : undefined;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readFiniteMs(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function hasCurrentTurnSlackAck(state) {
  if (!state || typeof state !== 'object') {
    return false;
  }

  if (isRecordedRequestUserInputTool(trimString(state.tool))) {
    return false;
  }

  const currentTurnMessageTs = trimString(state.currentTurnMessageTs);
  if (!currentTurnMessageTs) {
    return false;
  }

  return (
    trimString(state.satisfiedTurnMessageTs) === currentTurnMessageTs &&
    readFiniteMs(state.recordedAtMs) !== null
  );
}

function hasCurrentTurnInitialAckReminder(state) {
  if (!state || typeof state !== 'object') {
    return false;
  }

  return readFiniteMs(state.initialAckReminderAtMs) !== null;
}

function doesCurrentTurnRequireInitialAck(state) {
  if (!state || typeof state !== 'object') {
    return true;
  }

  return state.currentTurnRequiresInitialAck !== false;
}

function hasCurrentTurnTerminalCloseout(state) {
  if (!state || typeof state !== 'object') {
    return false;
  }

  if (isRecordedRequestUserInputTool(trimString(state.tool))) {
    return false;
  }

  const currentTurnMessageTs = trimString(state.currentTurnMessageTs);
  if (!currentTurnMessageTs) {
    return false;
  }

  const terminalSatisfiedTurnMessageTs = trimString(
    state.terminalSatisfiedTurnMessageTs,
  );
  const terminalSatisfiedAtMs = readFiniteMs(state.terminalSatisfiedAtMs);

  if (
    terminalSatisfiedTurnMessageTs === currentTurnMessageTs &&
    terminalSatisfiedAtMs !== null
  ) {
    return true;
  }

  const tool = trimString(state.tool);
  if (tool !== 'send_chat_reply') {
    return false;
  }

  // Clarification is a terminal handoff like closeout: the turn ends waiting
  // on the user's answer (kept in sync with the stop hook's policy).
  const replyPurpose = trimString(state.replyPurpose);
  if (
    replyPurpose &&
    replyPurpose !== 'closeout' &&
    replyPurpose !== 'clarification'
  ) {
    return false;
  }

  return (
    trimString(state.satisfiedTurnMessageTs) === currentTurnMessageTs &&
    readFiniteMs(state.recordedAtMs) !== null
  );
}

// Late-bound automation execution tasks have no inbound Slack turn, so the
// current-turn helpers above never match; their terminal closeout is the
// recorded send_chat_reply itself.
function hasNoTurnAutomationTerminalCloseout(state) {
  if (!state || typeof state !== 'object') {
    return false;
  }

  if (state.requiresTerminalCloseoutWithoutTurn !== true) {
    return false;
  }

  if (trimString(state.currentTurnMessageTs)) {
    return false;
  }

  if (trimString(state.tool) !== 'send_chat_reply') {
    return false;
  }

  const replyPurpose = trimString(state.replyPurpose);
  if (replyPurpose && replyPurpose !== 'closeout') {
    return false;
  }

  return readFiniteMs(state.recordedAtMs) !== null;
}

function writeState(stateFilePath, state) {
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  fs.writeFileSync(stateFilePath, JSON.stringify(state), 'utf8');
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

function logDecision(level, fields) {
  logHook(level, 'Hook decision', {
    hook: HOOK_NAME,
    ...fields,
  });
}

function logAllow(fields) {
  if (!isHookDebugEnabled()) {
    return;
  }

  logDecision('INFO', {
    decision: 'allow',
    ...fields,
  });
}

function getLastActivityMs(state) {
  if (!state || typeof state !== 'object') {
    return null;
  }

  const currentTurnRequiresInitialAck =
    state.currentTurnRequiresInitialAck !== false;
  const currentTurnMessageTs = trimString(state.currentTurnMessageTs);
  const satisfiedTurnMessageTs = trimString(state.satisfiedTurnMessageTs);
  const recordedAtMs = readFiniteMs(state.recordedAtMs);

  if (
    !currentTurnRequiresInitialAck &&
    !currentTurnMessageTs &&
    recordedAtMs === null
  ) {
    return null;
  }

  if (
    currentTurnMessageTs &&
    satisfiedTurnMessageTs !== currentTurnMessageTs &&
    readFiniteMs(state.currentTurnStartedAtMs) !== null
  ) {
    return state.currentTurnStartedAtMs;
  }

  const lastNonSlackWorkAfterTerminalAtMs = readFiniteMs(
    state.lastNonSlackWorkAfterTerminalAtMs,
  );
  if (lastNonSlackWorkAfterTerminalAtMs !== null) {
    return lastNonSlackWorkAfterTerminalAtMs;
  }

  if (recordedAtMs !== null) {
    return recordedAtMs;
  }

  const startedAtMs = readFiniteMs(state.startedAtMs);
  if (startedAtMs !== null) {
    return startedAtMs;
  }

  return null;
}

function writeReminderState(stateFilePath, state, nowMs) {
  const nextState = {
    ...(state && typeof state === 'object' ? state : {}),
    lastSilenceReminderAtMs: nowMs,
  };

  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  fs.writeFileSync(stateFilePath, JSON.stringify(nextState), 'utf8');
}

function writeInitialAckReminderState(stateFilePath, state, nowMs) {
  const nextState = {
    ...(state && typeof state === 'object' ? state : {}),
    initialAckReminderAtMs: nowMs,
  };

  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  fs.writeFileSync(stateFilePath, JSON.stringify(nextState), 'utf8');
}

(() => {
  const hookInput = parseHookInput(readStdin());
  const hookEventName = getHookEventName(hookInput);

  const stateFilePath = process.env.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE;
  if (!stateFilePath) {
    logAllow({
      trigger: hookEventName,
      reason: 'slack_reply_satisfaction_not_configured',
      tool: getToolName(hookInput),
    });
    process.exit(0);
  }

  const nowMs = Date.now();
  const hookThreadId = getHookThreadId(hookInput);
  let state = ensureParentThreadState(
    stateFilePath,
    readState(stateFilePath),
    hookThreadId,
  );
  if (isNonParentThread(state, hookThreadId)) {
    if (
      hookEventName === 'PreToolUse' &&
      isSubagentRestrictedSlackPostingTool(hookInput)
    ) {
      logDecision('INFO', {
        trigger: hookEventName,
        decision: 'deny',
        tool: getToolName(hookInput),
        reason: 'subagent_slack_post',
        hookThreadId,
      });
      process.stdout.write(
        JSON.stringify({
          decision: 'block',
          permissionDecision: 'deny',
          reason: SUBAGENT_SLACK_POST_DENIAL,
        }),
      );
      process.exit(0);
    }

    logAllow({
      trigger: hookEventName,
      reason: 'non_parent_thread',
      tool: getToolName(hookInput),
      hookThreadId,
    });
    process.exit(0);
  }

  if (
    hookEventName === 'PreToolUse' &&
    isPrematureAutomationReply(hookInput, state)
  ) {
    logDecision('INFO', {
      trigger: hookEventName,
      decision: 'deny',
      tool: getToolName(hookInput),
      reason: 'automation_premature_slack_reply',
      hookThreadId,
    });
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        permissionDecision: 'deny',
        reason:
          'Automation-started tasks must stay silent until they have a final result, durable blocker, or required user input. Do not send an opening acknowledgement or progress update; use a closeout or clarification only when that outcome is ready.',
      }),
    );
    process.exit(0);
  }

  if (
    hookEventName === 'PostToolUse' &&
    !isSlackSatisfactionTool(hookInput, state) &&
    !isRequestUserInputTool(hookInput) &&
    !isCloseoutBookkeepingTool(hookInput) &&
    (hasCurrentTurnSlackAck(state) ||
      hasNoTurnAutomationTerminalCloseout(state))
  ) {
    state = {
      ...(state && typeof state === 'object' ? state : {}),
      lastNonSlackWorkAfterSatisfactionAtMs: nowMs,
      ...(hasCurrentTurnTerminalCloseout(state) ||
      hasNoTurnAutomationTerminalCloseout(state)
        ? { lastNonSlackWorkAfterTerminalAtMs: nowMs }
        : {}),
    };
    writeState(stateFilePath, state);
  }

  if (
    hookEventName === 'PreToolUse' &&
    !isSlackSatisfactionTool(hookInput, state) &&
    !isSlackReplyToolDiscoveryTool(hookInput) &&
    trimString(state && state.currentTurnMessageTs) &&
    doesCurrentTurnRequireInitialAck(state) &&
    !hasCurrentTurnSlackAck(state)
  ) {
    if (!hasCurrentTurnInitialAckReminder(state)) {
      writeInitialAckReminderState(stateFilePath, state, nowMs);
    }
    logDecision('INFO', {
      trigger: hookEventName,
      decision: 'block',
      tool: getToolName(hookInput),
      reason: 'initial_slack_ack_missing',
      stateFilePath,
    });
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason: INITIAL_ACK_REMINDER,
      }),
    );
    process.exit(0);
  }

  const lastActivityMs = getLastActivityMs(state);
  if (lastActivityMs === null) {
    logAllow({
      trigger: hookEventName,
      reason: 'missing_activity_timestamp',
      tool: getToolName(hookInput),
    });
    process.exit(0);
  }

  const silenceMs = nowMs - lastActivityMs;
  if (silenceMs < MAX_SILENCE_MS) {
    logAllow({
      trigger: hookEventName,
      reason: 'silence_below_threshold',
      tool: getToolName(hookInput),
      silenceMs,
      thresholdMs: MAX_SILENCE_MS,
    });
    process.exit(0);
  }

  if (
    hookEventName === 'PreToolUse' &&
    (isSlackSatisfactionTool(hookInput, state) ||
      isSlackReplyToolDiscoveryTool(hookInput))
  ) {
    logAllow({
      trigger: hookEventName,
      reason: isSlackReplyToolDiscoveryTool(hookInput)
        ? 'reply_tool_discovery_allowed_while_over_threshold'
        : 'reply_tool_allowed_while_over_threshold',
      tool: getToolName(hookInput),
      silenceMs,
      thresholdMs: MAX_SILENCE_MS,
    });
    process.exit(0);
  }

  writeReminderState(stateFilePath, state, nowMs);
  logDecision('INFO', {
    trigger: hookEventName,
    decision: 'block',
    tool: getToolName(hookInput),
    reason: 'slack_update_overdue',
    silenceMs,
    thresholdMs: MAX_SILENCE_MS,
    stateFilePath,
  });
  if (hookEventName === 'PreToolUse') {
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason: REMINDER,
      }),
    );
    process.exit(0);
  }

  process.stdout.write(
    JSON.stringify({
      continue: false,
      decision: 'block',
      reason: REMINDER,
      stopReason: REMINDER,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: REMINDER,
      },
    }),
  );
})();
`;
