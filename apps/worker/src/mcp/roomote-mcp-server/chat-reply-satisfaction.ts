import fs from 'node:fs';
import path from 'node:path';

export const CHAT_REPLY_SATISFACTION_STATE_FILE_ENV =
  'ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE';

const SLACK_MESSAGE_TS_REGEX = /^\d+\.\d+$/;
const TELEGRAM_MESSAGE_ID_REGEX = /^\d+$/;

type ChatReplySatisfactionTool =
  | 'send_chat_reply'
  | 'send_chat_reaction_emoji'
  | 'add_reaction_to_slack_message';

export type ChatReplyPurpose =
  | 'ack'
  | 'progress'
  | 'closeout'
  | 'clarification';

interface ChatReplySatisfactionState {
  startedAtMs?: number;
  /**
   * Set at launch for late-bound automation execution tasks: the Stop hook
   * blocks silent completion, and the silence hook stamps post-closeout work
   * even though no inbound chat turn exists.
   */
  requiresTerminalCloseoutWithoutTurn?: boolean;
  parentThreadId?: string;
  currentTurnMessageTs?: string;
  currentTurnStartedAtMs?: number;
  currentTurnReactionsAllowed?: boolean;
  currentTurnRequiresInitialAck?: boolean;
  initialAckReminderAtMs?: number;
  messageTs?: string;
  tool?: ChatReplySatisfactionTool;
  replyPurpose?: ChatReplyPurpose;
  recordedAtMs?: number;
  satisfiedTurnMessageTs?: string;
  lastNonSlackWorkAfterSatisfactionAtMs?: number;
  terminalSatisfiedTurnMessageTs?: string;
  terminalSatisfiedAtMs?: number;
  terminalSatisfactionTool?: 'send_chat_reply';
  lastNonSlackWorkAfterTerminalAtMs?: number;
  lastSilenceReminderAtMs?: number;
  unsharedVisualProofArtifactIds?: string[];
  visualProofShareReminderPending?: boolean;
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isSlackMessageTs(value: unknown): boolean {
  return SLACK_MESSAGE_TS_REGEX.test(trimString(value));
}

function isTelegramMessageId(value: unknown): boolean {
  return TELEGRAM_MESSAGE_ID_REGEX.test(trimString(value));
}

function isTeamsActivityId(value: unknown): boolean {
  const trimmed = trimString(value);

  return Boolean(trimmed && !trimmed.startsWith('web:') && !/\s/.test(trimmed));
}

/** A turn id that identifies a chat message across supported chat surfaces. */
export function isChatTurnMessageTs(value: unknown): boolean {
  return (
    isSlackMessageTs(value) ||
    isTelegramMessageId(value) ||
    isTeamsActivityId(value)
  );
}

function getStateFilePath(explicitStateFilePath?: string): string | undefined {
  return (
    explicitStateFilePath ?? process.env[CHAT_REPLY_SATISFACTION_STATE_FILE_ENV]
  )?.trim();
}

function readState(stateFilePath: string): Partial<ChatReplySatisfactionState> {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) as
      | Partial<ChatReplySatisfactionState>
      | undefined;
    return parsed ?? {};
  } catch {
    return {};
  }
}

function writeState(
  stateFilePath: string,
  state: ChatReplySatisfactionState,
): void {
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  fs.writeFileSync(stateFilePath, JSON.stringify(state), 'utf8');
}

export function recordChatTurnStart(input: {
  turnMessageTs: string;
  allowReaction?: boolean;
  requireInitialAck?: boolean;
  sessionId?: string;
  stateFilePath?: string;
  nowMs?: number;
}): void {
  const stateFilePath = getStateFilePath(input.stateFilePath);
  const turnMessageTs = input.turnMessageTs.trim();

  if (!stateFilePath || !turnMessageTs) {
    return;
  }

  const existingState = readState(stateFilePath);
  const sessionId = trimString(input.sessionId);
  const isNewTurn =
    trimString(existingState.currentTurnMessageTs) !== turnMessageTs;
  const currentTurnReactionsAllowed = isNewTurn
    ? (input.allowReaction ?? true)
    : typeof existingState.currentTurnReactionsAllowed === 'boolean'
      ? existingState.currentTurnReactionsAllowed
      : (input.allowReaction ?? true);
  const currentTurnRequiresInitialAck = isNewTurn
    ? (input.requireInitialAck ?? true)
    : typeof existingState.currentTurnRequiresInitialAck === 'boolean'
      ? existingState.currentTurnRequiresInitialAck
      : (input.requireInitialAck ?? true);
  const state: ChatReplySatisfactionState = {
    ...existingState,
    ...(trimString(existingState.parentThreadId)
      ? {}
      : sessionId
        ? { parentThreadId: sessionId }
        : {}),
    currentTurnMessageTs: turnMessageTs,
    currentTurnStartedAtMs: input.nowMs ?? Date.now(),
    currentTurnReactionsAllowed,
    currentTurnRequiresInitialAck,
    ...(isNewTurn
      ? {
          initialAckReminderAtMs: undefined,
          satisfiedTurnMessageTs: undefined,
          lastNonSlackWorkAfterSatisfactionAtMs: undefined,
          terminalSatisfiedTurnMessageTs: undefined,
          terminalSatisfiedAtMs: undefined,
          terminalSatisfactionTool: undefined,
          lastNonSlackWorkAfterTerminalAtMs: undefined,
        }
      : {}),
  };

  writeState(stateFilePath, state);
}

export function recordChatReplySatisfaction(input: {
  messageTs: string;
  tool: ChatReplySatisfactionTool;
  replyPurpose?: ChatReplyPurpose;
  sessionId?: string;
  stateFilePath?: string;
  nowMs?: number;
}): void {
  const stateFilePath = getStateFilePath(input.stateFilePath);
  const messageTs = input.messageTs.trim();

  if (!stateFilePath || !messageTs) {
    return;
  }

  const existingState = readState(stateFilePath);
  const sessionId = trimString(input.sessionId);
  const parentThreadId = trimString(existingState.parentThreadId);

  if (parentThreadId && sessionId && sessionId !== parentThreadId) {
    return;
  }

  const currentTurnMessageTs = trimString(existingState.currentTurnMessageTs);
  const currentTurnReactionsAllowed =
    existingState.currentTurnReactionsAllowed !== false;
  const isCurrentTurnReactionTool =
    input.tool === 'send_chat_reaction_emoji' ||
    input.tool === 'add_reaction_to_slack_message';
  const satisfiesCurrentTurn =
    currentTurnMessageTs &&
    (isCurrentTurnReactionTool
      ? currentTurnReactionsAllowed &&
        isChatTurnMessageTs(currentTurnMessageTs) &&
        currentTurnMessageTs === messageTs
      : true);
  const nowMs = input.nowMs ?? Date.now();
  const state: ChatReplySatisfactionState = {
    ...existingState,
    messageTs,
    tool: input.tool,
    replyPurpose:
      input.tool === 'send_chat_reply' ? input.replyPurpose : undefined,
    recordedAtMs: nowMs,
    ...(satisfiesCurrentTurn
      ? {
          satisfiedTurnMessageTs: currentTurnMessageTs,
          lastNonSlackWorkAfterSatisfactionAtMs: undefined,
        }
      : {}),
    // A clarification reply is a terminal handoff like a closeout: the turn
    // ends waiting on the user's answer, so ending after one is not silence.
    ...(input.tool === 'send_chat_reply' &&
    (input.replyPurpose === 'closeout' ||
      input.replyPurpose === 'clarification') &&
    satisfiesCurrentTurn
      ? {
          terminalSatisfiedTurnMessageTs: currentTurnMessageTs,
          terminalSatisfiedAtMs: nowMs,
          terminalSatisfactionTool: 'send_chat_reply' as const,
          lastNonSlackWorkAfterTerminalAtMs: undefined,
        }
      : {}),
  };

  writeState(stateFilePath, state);
}

export function recordUnsharedVisualProofArtifact(input: {
  artifactId: string;
  stateFilePath?: string;
}): void {
  const stateFilePath = getStateFilePath(input.stateFilePath);
  const artifactId = input.artifactId.trim();

  if (!stateFilePath || !artifactId) {
    return;
  }

  const existingState = readState(stateFilePath);
  const artifactIds = new Set(
    existingState.unsharedVisualProofArtifactIds ?? [],
  );
  artifactIds.add(artifactId);

  writeState(stateFilePath, {
    ...existingState,
    unsharedVisualProofArtifactIds: [...artifactIds],
    visualProofShareReminderPending: true,
  });
}

export function recordSharedVisualProofArtifacts(input: {
  artifactIds: string[];
  stateFilePath?: string;
}): void {
  const stateFilePath = getStateFilePath(input.stateFilePath);
  const sharedArtifactIds = new Set(
    input.artifactIds.map((artifactId) => artifactId.trim()).filter(Boolean),
  );

  if (!stateFilePath || sharedArtifactIds.size === 0) {
    return;
  }

  const existingState = readState(stateFilePath);
  const unsharedArtifactIds = (
    existingState.unsharedVisualProofArtifactIds ?? []
  ).filter((artifactId) => !sharedArtifactIds.has(artifactId));

  writeState(stateFilePath, {
    ...existingState,
    unsharedVisualProofArtifactIds: unsharedArtifactIds,
    visualProofShareReminderPending:
      unsharedArtifactIds.length > 0 &&
      existingState.visualProofShareReminderPending === true,
  });
}
