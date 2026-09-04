import type { TaskArtifact } from '@/types';

import {
  isInternalDebugToolCallMessage,
  shouldHideAcpMessage,
} from '../../message-visibility';
import { getDelegatedTaskDetails } from './delegated-task';
import {
  isSubagentSpawnRowMessage,
  isSubagentToolMessage,
} from './subagent-tool';
import { resolveShowWidgetForToolMessage } from './show-widget-tool-result';
import { resolveToolPresentation } from './tool-presentation';
import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from './types';
import { resolveVisualProofMediaForToolMessage } from './visual-proof-tool-result';

type ToolMessage = AcpToolCallUiMessage | AcpToolResultUiMessage;

interface ToolPresentationPolicyOptions {
  artifacts?: readonly TaskArtifact[] | null;
  delegatedTaskCardsEnabled?: boolean;
  displayMode?: 'default' | 'narration';
  showInternalMessages?: boolean;
}

interface ResolvedToolPolicy {
  rowVisibility: 'visible' | 'hidden' | 'debug-only';
  hiddenBehavior: 'boundary' | 'transparent';
  detailMode: 'none' | 'expandable' | 'preview';
  activityMode: 'collapsible' | 'keep-visible';
  renderAs: 'row' | 'delegated-task-card';
  groupingMode: 'groupable' | 'standalone';
}

const CONSEQUENTIAL_RECEIPTS = new Set([
  'launch_task',
  'review_pull_request',
  'cancel_task',
  'retry_task_start',
  'send_task_message',
  'send_chat_reply',
  'post_to_channel',
  'send_chat_reaction_emoji',
  'save_memory',
]);

export function resolveToolPresentationPolicy(
  msg: ToolMessage,
  options: ToolPresentationPolicyOptions = {},
): ResolvedToolPolicy {
  const presentation = resolveToolPresentation(msg.data, msg.partial);
  const delegatedTask = getDelegatedTaskDetails(msg);
  const renderAs =
    options.delegatedTaskCardsEnabled && delegatedTask
      ? 'delegated-task-card'
      : 'row';
  const isInternal =
    isSubagentToolMessage(msg) || isInternalDebugToolCallMessage(msg);
  const showWidget = resolveShowWidgetForToolMessage(msg) !== null;
  const visualProof =
    resolveVisualProofMediaForToolMessage(msg, options.artifacts).length > 0;
  const isArtifact = presentation.category === 'artifact';
  const hasPreview = showWidget || visualProof;
  const isRunning = msg.partial || msg.data.status === 'in_progress';
  const consequentialReceipt =
    presentation.identity.toolName !== null &&
    CONSEQUENTIAL_RECEIPTS.has(presentation.identity.toolName);
  const keepConsequentialReceiptVisible =
    consequentialReceipt &&
    (presentation.identity.toolName !== 'send_chat_reply' ||
      options.displayMode === 'narration' ||
      presentation.phase === 'failed');

  let rowVisibility: ResolvedToolPolicy['rowVisibility'] = 'visible';
  if (shouldHideAcpMessage(msg)) {
    rowVisibility = 'hidden';
  } else if (
    options.showInternalMessages === false &&
    isInternal &&
    !isSubagentSpawnRowMessage(msg)
  ) {
    rowVisibility = 'debug-only';
  } else if (
    options.displayMode === 'narration' &&
    !hasPreview &&
    !isSubagentToolMessage(msg) &&
    renderAs !== 'delegated-task-card' &&
    !consequentialReceipt &&
    !(options.showInternalMessages && isInternal)
  ) {
    rowVisibility = 'hidden';
  }

  const detailMode: ResolvedToolPolicy['detailMode'] =
    isSubagentToolMessage(msg) && hasSubagentSummary(msg)
      ? 'expandable'
      : hasPreview
        ? 'preview'
        : isInternalDebugToolCallMessage(msg) ||
            presentation.category === 'read' ||
            (isSubagentToolMessage(msg) &&
              !options.showInternalMessages &&
              !hasSubagentSummary(msg))
          ? 'none'
          : 'expandable';

  return {
    rowVisibility,
    hiddenBehavior: 'boundary',
    detailMode,
    activityMode:
      isRunning ||
      hasPreview ||
      isArtifact ||
      renderAs === 'delegated-task-card' ||
      keepConsequentialReceiptVisible
        ? 'keep-visible'
        : 'collapsible',
    renderAs,
    groupingMode:
      hasPreview ||
      isArtifact ||
      renderAs === 'delegated-task-card' ||
      consequentialReceipt
        ? 'standalone'
        : 'groupable',
  };
}

function hasSubagentSummary(msg: ToolMessage): boolean {
  const data = msg.data as unknown as Record<string, unknown>;
  const prompt = data.prompt;
  const rawInput =
    data.rawInput &&
    typeof data.rawInput === 'object' &&
    !Array.isArray(data.rawInput)
      ? (data.rawInput as Record<string, unknown>)
      : null;
  const rawPrompt = rawInput?.prompt;
  const output = msg.kind === 'tool_result' ? msg.data.output : null;
  const activity = data.subagentActivity;

  return Boolean(
    (typeof prompt === 'string' && prompt.trim()) ||
    (typeof rawPrompt === 'string' && rawPrompt.trim()) ||
    (typeof output === 'string' && output.trim()) ||
    (activity && typeof activity === 'object'),
  );
}
