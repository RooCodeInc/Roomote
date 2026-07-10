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
} from './subagent-tool';

export type ExplorationStepKind = 'list' | 'read' | 'search';

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

export interface GroupedToolCallItem {
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage;
  objectLabel: string;
  stepKind: ExplorationStepKind;
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
      stepKind: ExplorationStepKind | null;
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

  if (msg.data.kind === 'read') {
    return 'read';
  }

  return null;
}

function formatHumanList(values: string[]): string {
  if (values.length === 0) {
    return '';
  }

  if (values.length === 1) {
    return values[0]!;
  }

  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }

  const head = values.slice(0, -1).join(', ');
  const tail = values[values.length - 1];
  return `${head} and ${tail}`;
}

const TITLE_PREFIX_RE = /^(?:search|read|list|find)\s+(.+)$/i;

function extractObjectLabel(
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage,
  stepKind: ExplorationStepKind,
): string {
  const title = msg.data.title?.trim();

  if (title) {
    const match = TITLE_PREFIX_RE.exec(title);

    if (match?.[1]) {
      return match[1].trim();
    }

    const payloadLabel = extractLabelFromToolData(
      msg.data,
      STEP_KIND_DATA_KEYS[stepKind],
    );

    return payloadLabel ?? title;
  }

  return (
    extractLabelFromToolData(msg.data, STEP_KIND_DATA_KEYS[stepKind]) ?? 'Tool'
  );
}

function summarizeGroupObject(items: GroupedToolCallItem[]): string {
  const counts = new Map<ExplorationStepKind, number>();

  for (const item of items) {
    counts.set(item.stepKind, (counts.get(item.stepKind) ?? 0) + 1);
  }

  const summaryParts = STEP_KIND_ORDER.flatMap((stepKind) => {
    const count = counts.get(stepKind) ?? 0;

    if (count === 0) {
      return [];
    }

    const labels = STEP_KIND_LABELS[stepKind];
    return [`${count} ${count === 1 ? labels.singular : labels.plural}`];
  });

  return formatHumanList(summaryParts) || `${items.length} exploration steps`;
}

/**
 * Collapse the paired `tool_call` and `tool_result` messages for the same
 * invocation into a single group item so the exploration summary counts each
 * invocation once instead of twice. The `tool_result` is preferred when both
 * are present because it carries the populated title and output; the
 * `tool_call` is kept as a fallback for in-progress invocations that have not
 * yet produced a result. Items without a usable `toolCallId` are kept as-is.
 */
function dedupeGroupItemsByToolCallId(
  items: GroupedToolCallItem[],
): GroupedToolCallItem[] {
  const chosen = new Map<string, GroupedToolCallItem>();

  for (const item of items) {
    const key = extractToolCallIdKey(item.msg.data.toolCallId);

    if (key === null) {
      continue;
    }

    const existing = chosen.get(key);

    if (
      !existing ||
      (item.msg.kind === 'tool_result' && existing.msg.kind !== 'tool_result')
    ) {
      chosen.set(key, item);
    }
  }

  if (chosen.size === 0) {
    return items;
  }

  const emittedKeys = new Set<string>();
  const result: GroupedToolCallItem[] = [];

  for (const item of items) {
    const key = extractToolCallIdKey(item.msg.data.toolCallId);

    if (key === null) {
      result.push(item);
      continue;
    }

    if (emittedKeys.has(key)) {
      continue;
    }

    emittedKeys.add(key);
    result.push(chosen.get(key)!);
  }

  return result;
}

function extractToolCallIdKey(toolCallId: unknown): string | null {
  return typeof toolCallId === 'string' && toolCallId.length > 0
    ? toolCallId
    : null;
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
      stepKind: null,
    };
  }

  return {
    visibility: 'render',
    stepKind: resolveExplorationStepKind(msg),
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

    if (!currentState.stepKind || !isToolMessage(current)) {
      const currentMessage = dedupeRenderableMessageImages(
        current,
        seenImageUris,
      );

      if (isEmptyCompletedTextMessage(currentMessage)) {
        cursor += 1;
        continue;
      }

      state.hasRenderedVisibleBlock = true;
      const childMessages =
        subagentChildSessionLookup.parentMessageToChildMessages.get(
          current.id,
        ) ?? [];
      const childBlocks =
        childMessages.length > 0
          ? buildAcpRenderBlocksInScope(
              childMessages,
              options,
              subagentChildSessionLookup,
              seenImageUris,
              state,
              current.id,
            )
          : undefined;

      blocks.push({
        kind: 'message',
        msg: currentMessage,
        ...(childBlocks?.length ? { childBlocks } : {}),
      });
      cursor += 1;
      continue;
    }

    const items: GroupedToolCallItem[] = [
      {
        msg: current,
        objectLabel: extractObjectLabel(current, currentState.stepKind),
        stepKind: currentState.stepKind,
      },
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

      if (!nextState.stepKind || !isToolMessage(next)) {
        break;
      }

      items.push({
        msg: next,
        objectLabel: extractObjectLabel(next, nextState.stepKind),
        stepKind: nextState.stepKind,
      });
      runCursor += 1;
    }

    if (items.length < 2) {
      const currentMessage = dedupeRenderableMessageImages(
        current,
        seenImageUris,
      );

      if (isEmptyCompletedTextMessage(currentMessage)) {
        cursor += 1;
        continue;
      }

      blocks.push({ kind: 'message', msg: currentMessage });
      state.hasRenderedVisibleBlock = true;
      cursor += 1;
      continue;
    }

    const dedupedItems = dedupeGroupItemsByToolCallId(items);

    if (dedupedItems.length < 2) {
      const representativeMessage = dedupeRenderableMessageImages(
        dedupedItems[0]!.msg,
        seenImageUris,
      );

      if (isEmptyCompletedTextMessage(representativeMessage)) {
        cursor += 1;
        continue;
      }

      blocks.push({ kind: 'message', msg: representativeMessage });
      state.hasRenderedVisibleBlock = true;
      cursor = runCursor;
      continue;
    }

    blocks.push({
      kind: 'tool_group',
      id: items[0]!.msg.id,
      ts: items[0]!.msg.ts,
      action: 'Exploring',
      objectSummary: summarizeGroupObject(dedupedItems),
      items: dedupedItems,
    });
    state.hasRenderedVisibleBlock = true;

    cursor = runCursor;
  }

  return blocks;
}
