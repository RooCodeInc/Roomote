import {
  ACP_ENVELOPE_EVENT_TYPES,
  extractVisibleAcpPromptText,
  normalizeTranscriptUserText,
} from '@roomote/types';

import {
  isInternalDebugToolCallMessage,
  shouldHideAcpMessage,
} from '../../message-visibility';

import type {
  AcpToolCallUiMessage,
  AcpToolResultUiMessage,
  AcpUiMessage,
} from './types';
import {
  isSubagentSpawnRowMessage,
  isSubagentToolMessage,
  isSubagentToolPayload,
} from './subagent-tool';
import { resolveShowWidgetForToolMessage } from './show-widget-tool-result';

export type ExplorationStepKind = 'list' | 'read' | 'search';

export type GroupedToolDisplayKind =
  | ExplorationStepKind
  | 'execute'
  | 'edit'
  | 'tool';

const EXPLORATION_TOOL_NAMES: Record<ExplorationStepKind, Set<string>> = {
  search: new Set(['search', 'search_file', 'search_files']),
  list: new Set(['glob', 'list', 'list_dir', 'list_directory', 'list_files']),
  read: new Set(['read', 'read_file']),
};

const STEP_KIND_ORDER: ExplorationStepKind[] = ['search', 'list', 'read'];

const STEP_KIND_LABELS: Record<
  ExplorationStepKind,
  { singular: string; plural: string }
> = {
  search: { singular: 'search', plural: 'searches' },
  list: { singular: 'listing', plural: 'listings' },
  read: { singular: 'file', plural: 'files' },
};

const STEP_KIND_DATA_KEYS: Record<ExplorationStepKind, string[]> = {
  search: [
    'query',
    'pattern',
    'search',
    'searchTerm',
    'search_term',
    'term',
    'needle',
  ],
  list: ['path', 'directory', 'dir', 'cwd', 'root', 'folder', 'target'],
  read: ['path', 'filePath', 'file_path', 'filename', 'file', 'uri'],
};

const GENERIC_TOOL_DATA_KEYS = [
  'path',
  'filePath',
  'file_path',
  'filename',
  'file',
  'uri',
  'query',
  'pattern',
  'search',
  'directory',
  'dir',
  'cwd',
  'target',
  'command',
];

/** Minimum completed/failed same-type tool invocations before collapsing. */
const TOOL_GROUP_MIN_SETTLED = 2;

export interface GroupedToolCallItem {
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage;
  objectLabel: string;
  groupKey: string;
  displayKind: GroupedToolDisplayKind;
  /** @deprecated Prefer displayKind; kept for exploration-item icons. */
  stepKind: ExplorationStepKind | null;
}

interface SingleAcpRenderBlock {
  kind: 'message';
  msg: AcpUiMessage;
  childBlocks?: AcpRenderBlock[];
}

export interface GroupedToolCallRenderBlock {
  kind: 'tool_group';
  id: string;
  ts: number;
  action: string;
  objectSummary: string;
  groupKey: string;
  displayKind: GroupedToolDisplayKind;
  items: GroupedToolCallItem[];
}

export type AcpRenderBlock = SingleAcpRenderBlock | GroupedToolCallRenderBlock;

interface BuildAcpRenderBlocksOptions {
  displayMode?: 'default' | 'narration';
  initialPrompt?: Pick<AcpUiMessage, 'text' | 'images'> | null;
  shouldHideFirstMessage?: boolean;
  showInternalMessages?: boolean;
  suppressedMessageIds?: ReadonlySet<string>;
}

interface SubagentChildSessionLookup {
  childSessionToParentMessageId: Map<string, string>;
  parentMessageToChildMessages: Map<string, AcpUiMessage[]>;
}

function dedupeRenderableMessageImages(
  msg: AcpUiMessage,
  seenImageUris: Set<string>,
): AcpUiMessage {
  if (msg.role !== 'user' || !msg.images?.length) {
    return msg;
  }

  const nextImages: string[] = [];
  let didChange = false;

  for (const image of msg.images) {
    if (seenImageUris.has(image)) {
      didChange = true;
      continue;
    }

    seenImageUris.add(image);
    nextImages.push(image);
  }

  if (!didChange) {
    return msg;
  }

  return {
    ...msg,
    ...(nextImages.length > 0 ? { images: nextImages } : { images: undefined }),
  };
}

type HiddenBehavior = 'boundary' | 'transparent';

type MessageRenderState =
  | {
      visibility: 'render';
      groupKey: string | null;
    }
  | {
      visibility: 'hidden';
      behavior: HiddenBehavior;
      consumedFirstUserPrompt?: boolean;
    };

function isToolMessage(
  msg: AcpUiMessage,
): msg is AcpToolCallUiMessage | AcpToolResultUiMessage {
  return msg.kind === 'tool_call' || msg.kind === 'tool_result';
}

function getSubagentChildSessionIds(msg: AcpUiMessage): string[] {
  if (!isSubagentToolMessage(msg)) {
    return [];
  }

  const childSessionIds = msg.data.receiverThreadIds;

  if (!Array.isArray(childSessionIds) || childSessionIds.length === 0) {
    return [];
  }

  return [...new Set(childSessionIds.filter(Boolean))];
}

function buildSubagentChildSessionLookup(
  messages: AcpUiMessage[],
): SubagentChildSessionLookup {
  const childSessionToParentMessageId = new Map<string, string>();
  const messagesBySessionId = new Map<string, AcpUiMessage[]>();
  const messageOrder = new Map<string, number>();

  messages.forEach((msg, index) => {
    messageOrder.set(msg.id, index);

    if (!msg.sessionId) {
      return;
    }

    const sessionMessages = messagesBySessionId.get(msg.sessionId) ?? [];
    sessionMessages.push(msg);
    messagesBySessionId.set(msg.sessionId, sessionMessages);
  });

  for (const msg of messages) {
    for (const childSessionId of getSubagentChildSessionIds(msg)) {
      if (!childSessionToParentMessageId.has(childSessionId)) {
        childSessionToParentMessageId.set(childSessionId, msg.id);
      }
    }
  }

  const parentMessageToChildMessages = new Map<string, AcpUiMessage[]>();

  for (const [
    childSessionId,
    parentMessageId,
  ] of childSessionToParentMessageId) {
    const childMessages = messagesBySessionId.get(childSessionId);

    if (!childMessages?.length) {
      continue;
    }

    const nextMessages = [
      ...(parentMessageToChildMessages.get(parentMessageId) ?? []),
      ...childMessages,
    ].sort(
      (left, right) =>
        (messageOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (messageOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    );

    parentMessageToChildMessages.set(parentMessageId, nextMessages);
  }

  return {
    childSessionToParentMessageId,
    parentMessageToChildMessages,
  };
}

function extractStringByKeys(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function extractLabelFromToolData(
  data: AcpToolCallUiMessage['data'] | AcpToolResultUiMessage['data'],
  keys: string[],
): string | null {
  const raw = data as unknown as Record<string, unknown>;
  const topLevelMatch = extractStringByKeys(raw, keys);

  if (topLevelMatch) {
    return topLevelMatch;
  }

  const rawInput = raw.rawInput;

  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return null;
  }

  const argumentsRecord = (rawInput as Record<string, unknown>).arguments;

  if (
    !argumentsRecord ||
    typeof argumentsRecord !== 'object' ||
    Array.isArray(argumentsRecord)
  ) {
    return null;
  }

  return extractStringByKeys(argumentsRecord as Record<string, unknown>, keys);
}

function isExecuteToolMessage(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
): boolean {
  const data = msg.data as unknown as Record<string, unknown>;
  return (
    msg.data.kind === 'execute' ||
    msg.data.kind === 'execute_command' ||
    data.isExecute === true
  );
}

function resolveExplorationStepKind(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
): ExplorationStepKind | null {
  const toolName = (msg.data.toolName ?? msg.data.mcpToolName ?? '')
    .trim()
    .toLowerCase();

  for (const stepKind of STEP_KIND_ORDER) {
    if (toolName && EXPLORATION_TOOL_NAMES[stepKind].has(toolName)) {
      return stepKind;
    }
  }

  if (msg.data.kind === 'search') {
    return 'search';
  }

  if (msg.data.kind === 'list') {
    return 'list';
  }

  if (msg.data.kind === 'read') {
    return 'read';
  }

  return null;
}

/**
 * Stable identity for consecutive same-type collapsing. Different tools never
 * share a key, even when both are MCP exploration-style helpers.
 */
function resolveToolGroupKey(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
): string | null {
  // Subagent rows own nested child-session output and should stay standalone.
  if (isSubagentToolPayload(msg.data)) {
    return null;
  }

  if (isExecuteToolMessage(msg)) {
    return 'execute';
  }

  const toolName = (msg.data.toolName ?? msg.data.mcpToolName ?? '')
    .trim()
    .toLowerCase();
  const serverName = (msg.data.serverName ?? msg.data.mcpServerName ?? '')
    .trim()
    .toLowerCase();

  if (toolName) {
    return serverName ? `mcp:${serverName}:${toolName}` : `tool:${toolName}`;
  }

  const kind = (msg.data.kind ?? '').trim().toLowerCase();

  if (kind && kind !== 'mcp') {
    return `kind:${kind}`;
  }

  return null;
}

function resolveGroupedToolDisplayKind(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
  groupKey: string,
): GroupedToolDisplayKind {
  if (groupKey === 'execute' || isExecuteToolMessage(msg)) {
    return 'execute';
  }

  const explorationStep = resolveExplorationStepKind(msg);

  if (explorationStep) {
    return explorationStep;
  }

  if (msg.data.kind === 'edit') {
    return 'edit';
  }

  return 'tool';
}

function isSettledToolMessage(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
): boolean {
  if (msg.partial === true) {
    return false;
  }

  return msg.data.status === 'completed' || msg.data.status === 'failed';
}

function formatGenericToolLabel(value: string): string {
  return value.split(/[_-]+/).filter(Boolean).join(' ').toLowerCase();
}

const TITLE_PREFIX_RE =
  /^(?:search|read|list|find|run|using|used|ran|running)\s+(.+)$/i;

function extractObjectLabel(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
  displayKind: GroupedToolDisplayKind,
): string {
  if (displayKind === 'execute') {
    const command = msg.data.command?.trim();
    if (command) {
      return command;
    }
  }

  const title = msg.data.title?.trim();
  const dataKeys =
    displayKind === 'search' || displayKind === 'list' || displayKind === 'read'
      ? STEP_KIND_DATA_KEYS[displayKind]
      : GENERIC_TOOL_DATA_KEYS;

  if (title) {
    const match = TITLE_PREFIX_RE.exec(title);

    if (match?.[1]) {
      return match[1].trim();
    }

    const payloadLabel = extractLabelFromToolData(msg.data, dataKeys);

    return payloadLabel ?? title;
  }

  return extractLabelFromToolData(msg.data, dataKeys) ?? 'Tool';
}

function summarizeSameTypeGroup(
  items: GroupedToolCallItem[],
  displayKind: GroupedToolDisplayKind,
  groupKey: string,
): { action: string; objectSummary: string } {
  const count = items.length;

  if (displayKind === 'execute') {
    return {
      action: 'Ran',
      objectSummary: `${count} ${count === 1 ? 'command' : 'commands'}`,
    };
  }

  if (
    displayKind === 'search' ||
    displayKind === 'list' ||
    displayKind === 'read'
  ) {
    const labels = STEP_KIND_LABELS[displayKind];
    return {
      action: 'Exploring',
      objectSummary: `${count} ${count === 1 ? labels.singular : labels.plural}`,
    };
  }

  if (displayKind === 'edit') {
    return {
      action: 'Edited',
      objectSummary: `${count} ${count === 1 ? 'file' : 'files'}`,
    };
  }

  const toolNameMatch = /^(?:mcp:[^:]+:|tool:)(.+)$/.exec(groupKey);
  const toolLabel = toolNameMatch?.[1]
    ? formatGenericToolLabel(toolNameMatch[1])
    : null;

  if (toolLabel) {
    return {
      action: 'Used',
      objectSummary:
        count === 1 ? `1 ${toolLabel}` : `${count} ${toolLabel} calls`,
    };
  }

  return {
    action: 'Used',
    objectSummary: `${count} ${count === 1 ? 'tool' : 'tools'}`,
  };
}

function buildGroupedToolItem(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
  groupKey: string,
): GroupedToolCallItem {
  const displayKind = resolveGroupedToolDisplayKind(msg, groupKey);
  const stepKind =
    displayKind === 'search' || displayKind === 'list' || displayKind === 'read'
      ? displayKind
      : null;

  return {
    msg,
    groupKey,
    displayKind,
    stepKind,
    objectLabel: extractObjectLabel(msg, displayKind),
  };
}

/**
 * Collapse the paired `tool_call` and `tool_result` messages for the same
 * invocation into a single group item so the collapsed summary counts each
 * invocation once instead of twice. The `tool_result` is preferred when both
 * are present because it carries the populated title and output; the
 * `tool_call` is kept as a fallback for in-progress invocations that have not
 * yet produced a result.
 *
 * Items with a `toolCallId` are matched globally by that id. Items without one
 * only merge a consecutive `tool_call` + `tool_result` pair that share the same
 * payload signature, so two legitimate repeated operations stay distinct.
 */
function dedupeGroupItemsByToolCallId(
  items: GroupedToolCallItem[],
): GroupedToolCallItem[] {
  const preferredByToolCallId = new Map<string, GroupedToolCallItem>();

  for (const item of items) {
    const toolCallId = extractToolCallIdKey(item.msg.data.toolCallId);

    if (!toolCallId) {
      continue;
    }

    const existing = preferredByToolCallId.get(toolCallId);

    if (
      !existing ||
      (item.msg.kind === 'tool_result' && existing.msg.kind !== 'tool_result')
    ) {
      preferredByToolCallId.set(toolCallId, item);
    }
  }

  const result: GroupedToolCallItem[] = [];
  const emittedToolCallIds = new Set<string>();
  let index = 0;

  while (index < items.length) {
    const item = items[index]!;
    const toolCallId = extractToolCallIdKey(item.msg.data.toolCallId);

    if (toolCallId) {
      if (!emittedToolCallIds.has(toolCallId)) {
        emittedToolCallIds.add(toolCallId);
        result.push(preferredByToolCallId.get(toolCallId)!);
      }

      index += 1;
      continue;
    }

    const next = items[index + 1];
    const signature = extractPayloadSignature(item);
    const nextToolCallId = next
      ? extractToolCallIdKey(next.msg.data.toolCallId)
      : null;

    if (
      next &&
      nextToolCallId === null &&
      item.msg.kind === 'tool_call' &&
      next.msg.kind === 'tool_result' &&
      signature !== null &&
      signature === extractPayloadSignature(next)
    ) {
      // Prefer the settled result for a single unpaired call/result stream.
      result.push(next);
      index += 2;
      continue;
    }

    result.push(item);
    index += 1;
  }

  return result;
}

function extractToolCallIdKey(toolCallId: unknown): string | null {
  return typeof toolCallId === 'string' && toolCallId.length > 0
    ? toolCallId
    : null;
}

function extractPayloadSignature(item: GroupedToolCallItem): string | null {
  const title = item.msg.data.title?.trim() ?? '';
  const command = item.msg.data.command?.trim() ?? '';
  const label = item.objectLabel.trim();

  if (!title && !command && !label) {
    return null;
  }

  return `${item.groupKey}|${title}|${command}|${label}`;
}

function isEmptyCompletedTextMessage(msg: AcpUiMessage): boolean {
  return (
    msg.kind === 'text' &&
    !msg.partial &&
    (msg.text ?? '') === '' &&
    !msg.images?.length
  );
}

function resolveHiddenBehavior(msg: AcpUiMessage): HiddenBehavior {
  if (msg.kind === 'tool_call' || msg.kind === 'tool_result') {
    return 'boundary';
  }

  return 'transparent';
}

function isInitialTranscriptUserPrompt(msg: AcpUiMessage): boolean {
  return (
    msg.role === 'user' &&
    msg.updateType === ACP_ENVELOPE_EVENT_TYPES.UserPrompt
  );
}

function normalizePromptText(text: string | undefined): string | null {
  const normalizedTranscriptText = normalizeTranscriptUserText(
    text,
    ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
  )?.trim();

  if (!normalizedTranscriptText) {
    return null;
  }

  const normalized =
    normalizedTranscriptText.startsWith('<request>') &&
    normalizedTranscriptText.includes('</request>')
      ? extractVisibleAcpPromptText(normalizedTranscriptText)
      : normalizedTranscriptText;

  return normalized.trim() || null;
}

function hasMatchingImages(
  left: string[] | undefined,
  right: string[] | undefined,
): boolean {
  const normalizedLeft = left ?? [];
  const normalizedRight = right ?? [];

  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }

  return normalizedLeft.every(
    (image, index) => image === normalizedRight[index],
  );
}

function isDuplicateInitialUserPrompt(
  msg: AcpUiMessage,
  initialPrompt: BuildAcpRenderBlocksOptions['initialPrompt'],
): boolean {
  if (!initialPrompt || !isInitialTranscriptUserPrompt(msg)) {
    return false;
  }

  return (
    normalizePromptText(msg.text) === normalizePromptText(initialPrompt.text) &&
    hasMatchingImages(msg.images, initialPrompt.images)
  );
}

// Check order matters: specific overrides (suppressed, plan) before general
// visibility rules, so a suppressed plan is caught as "suppressed" not "plan".
function resolveMessageRenderState(
  msg: AcpUiMessage,
  options: BuildAcpRenderBlocksOptions,
  hideCurrentFirstUserPrompt: boolean,
): MessageRenderState {
  const shouldShowInternalMessageInNarration =
    options.showInternalMessages === true &&
    (isSubagentToolMessage(msg) || isInternalDebugToolCallMessage(msg));
  const shouldShowWidgetInNarration =
    isToolMessage(msg) && resolveShowWidgetForToolMessage(msg) !== null;

  if (options.suppressedMessageIds?.has(msg.id)) {
    return {
      visibility: 'hidden',
      behavior: 'boundary',
    };
  }

  if (msg.kind === 'plan') {
    return {
      visibility: 'hidden',
      behavior: 'boundary',
    };
  }

  if (
    options.showInternalMessages === false &&
    (isSubagentToolMessage(msg) || isInternalDebugToolCallMessage(msg)) &&
    // Spawn rows render inline even without debug UI. Keyed on the stable
    // payload shape, never on live-only activity data: activity does not
    // survive a transcript rebuild, and a row that vanishes on refresh reads
    // as a lost subagent.
    !isSubagentSpawnRowMessage(msg)
  ) {
    return {
      visibility: 'hidden',
      behavior: 'boundary',
    };
  }

  if (
    options.displayMode === 'narration' &&
    isToolMessage(msg) &&
    !shouldShowInternalMessageInNarration &&
    !shouldShowWidgetInNarration &&
    !isSubagentToolMessage(msg)
  ) {
    return {
      visibility: 'hidden',
      behavior: 'boundary',
    };
  }

  if (isEmptyCompletedTextMessage(msg)) {
    return {
      visibility: 'hidden',
      behavior: 'transparent',
    };
  }

  if (shouldHideAcpMessage(msg)) {
    return {
      visibility: 'hidden',
      behavior: resolveHiddenBehavior(msg),
    };
  }

  if (hideCurrentFirstUserPrompt) {
    return {
      visibility: 'hidden',
      behavior: resolveHiddenBehavior(msg),
      consumedFirstUserPrompt: true,
    };
  }

  if (!isToolMessage(msg)) {
    return {
      visibility: 'render',
      groupKey: null,
    };
  }

  return {
    visibility: 'render',
    groupKey: resolveToolGroupKey(msg),
  };
}

export function buildAcpRenderBlocks(
  messages: AcpUiMessage[],
  options: BuildAcpRenderBlocksOptions = {},
): AcpRenderBlock[] {
  const subagentChildSessionLookup = buildSubagentChildSessionLookup(messages);
  const seenImageUris = new Set(options.initialPrompt?.images ?? []);

  return buildAcpRenderBlocksInScope(
    messages,
    options,
    subagentChildSessionLookup,
    seenImageUris,
    { consumedFirstUserPrompt: false, hasRenderedVisibleBlock: false },
    null,
  );
}

function buildAcpRenderBlocksInScope(
  messages: AcpUiMessage[],
  options: BuildAcpRenderBlocksOptions,
  subagentChildSessionLookup: SubagentChildSessionLookup,
  seenImageUris: Set<string>,
  state: {
    consumedFirstUserPrompt: boolean;
    hasRenderedVisibleBlock: boolean;
  },
  scopeParentMessageId: string | null,
): AcpRenderBlock[] {
  const blocks: AcpRenderBlock[] = [];
  let cursor = 0;

  const pushSingleMessage = (msg: AcpUiMessage): boolean => {
    const currentMessage = dedupeRenderableMessageImages(msg, seenImageUris);

    if (isEmptyCompletedTextMessage(currentMessage)) {
      return false;
    }

    state.hasRenderedVisibleBlock = true;
    const childMessages =
      subagentChildSessionLookup.parentMessageToChildMessages.get(
        currentMessage.id,
      ) ?? [];
    const childBlocks =
      childMessages.length > 0
        ? buildAcpRenderBlocksInScope(
            childMessages,
            options,
            subagentChildSessionLookup,
            seenImageUris,
            state,
            currentMessage.id,
          )
        : undefined;

    blocks.push({
      kind: 'message',
      msg: currentMessage,
      ...(childBlocks?.length ? { childBlocks } : {}),
    });
    return true;
  };

  while (cursor < messages.length) {
    const current = messages[cursor]!;
    const currentParentMessageId = current.sessionId
      ? (subagentChildSessionLookup.childSessionToParentMessageId.get(
          current.sessionId,
        ) ?? null)
      : null;

    if (currentParentMessageId !== scopeParentMessageId) {
      cursor += 1;
      continue;
    }

    const currentState = resolveMessageRenderState(
      current,
      options,
      Boolean(options.shouldHideFirstMessage) &&
        !state.hasRenderedVisibleBlock &&
        !state.consumedFirstUserPrompt &&
        isDuplicateInitialUserPrompt(current, options.initialPrompt),
    );

    if (currentState.visibility !== 'render') {
      state.consumedFirstUserPrompt =
        state.consumedFirstUserPrompt ||
        currentState.consumedFirstUserPrompt === true;
      cursor += 1;
      continue;
    }

    if (!currentState.groupKey || !isToolMessage(current)) {
      pushSingleMessage(current);
      cursor += 1;
      continue;
    }

    const runGroupKey = currentState.groupKey;
    const items: GroupedToolCallItem[] = [
      buildGroupedToolItem(current, runGroupKey),
    ];
    let runCursor = cursor + 1;

    while (runCursor < messages.length) {
      const next = messages[runCursor]!;

      if (next.sessionId !== current.sessionId) {
        break;
      }

      const nextState = resolveMessageRenderState(
        next,
        options,
        Boolean(options.shouldHideFirstMessage) &&
          !state.hasRenderedVisibleBlock &&
          !state.consumedFirstUserPrompt &&
          isDuplicateInitialUserPrompt(next, options.initialPrompt),
      );

      if (nextState.visibility === 'hidden') {
        state.consumedFirstUserPrompt =
          state.consumedFirstUserPrompt ||
          nextState.consumedFirstUserPrompt === true;
        if (nextState.behavior === 'boundary') {
          break;
        }

        runCursor += 1;
        continue;
      }

      // Only collapse identical tool types consecutively.
      if (
        !nextState.groupKey ||
        nextState.groupKey !== runGroupKey ||
        !isToolMessage(next)
      ) {
        break;
      }

      items.push(buildGroupedToolItem(next, nextState.groupKey));
      runCursor += 1;
    }

    if (items.length < 2) {
      pushSingleMessage(current);
      cursor += 1;
      continue;
    }

    const dedupedItems = dedupeGroupItemsByToolCallId(items);
    const settledCount = dedupedItems.filter((item) =>
      isSettledToolMessage(item.msg),
    ).length;

    // Keep individuals until the second same-type call has completed. Once the
    // threshold is met, the whole consecutive same-type run collapses — including
    // trailing in-progress invocations so later completions append into the same
    // multi-call entry instead of spawning a new separate row.
    if (dedupedItems.length < 2 || settledCount < TOOL_GROUP_MIN_SETTLED) {
      for (const item of dedupedItems) {
        pushSingleMessage(item.msg);
      }

      cursor = runCursor;
      continue;
    }

    const displayKind = dedupedItems[0]!.displayKind;
    const summary = summarizeSameTypeGroup(
      dedupedItems,
      displayKind,
      runGroupKey,
    );

    blocks.push({
      kind: 'tool_group',
      id: items[0]!.msg.id,
      ts: items[0]!.msg.ts,
      action: summary.action,
      objectSummary: summary.objectSummary,
      groupKey: runGroupKey,
      displayKind,
      items: dedupedItems,
    });
    state.hasRenderedVisibleBlock = true;

    cursor = runCursor;
  }

  return blocks;
}
