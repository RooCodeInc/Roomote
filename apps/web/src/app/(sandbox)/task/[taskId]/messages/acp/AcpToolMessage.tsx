'use client';

import type { ReactNode } from 'react';

import {
  sanitizeSandboxPathsForDisplay,
  sanitizeSandboxPathString,
} from '@/lib';

import { AlertCircle, Loader2 } from '@/components/system';
import {
  Message,
  MessageContent,
  Tool,
  ToolContent,
  ToolHeader,
} from '@/components/ai-elements';

import { useArtifactLink } from '../../hooks';
import { messageAnchorId } from '../message-anchor';

import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from './types';
import { AcpToolDetails } from './AcpToolDetails';
import { isSubagentToolPayload } from './subagent-tool';
import { ShowWidgetPreview } from './ShowWidgetPreview';
import { resolveShowWidgetForToolMessage } from './show-widget-tool-result';
import { VisualProofToolPreview } from './VisualProofToolPreview';
import { resolveVisualProofMediaForToolMessage } from './visual-proof-tool-result';
import { resolveToolPresentation } from './tool-presentation';
import { mcpIntegrationIconFor, toolIconForKey } from './tool-icons';
import { resolveToolPresentationPolicy } from './tool-presentation-policy';

interface AcpToolMessageProps {
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage;
  showSubagentPayload?: boolean;
  children?: ReactNode;
}

export function AcpToolMessage({
  msg,
  showSubagentPayload = false,
  children,
}: AcpToolMessageProps) {
  const artifactLink = useArtifactLink();
  const anchorId = messageAnchorId(msg.ts);
  const title = sanitizeSandboxPathString(msg.data.title ?? 'Tool use');
  const sanitizedToolData = sanitizeSandboxPathsForDisplay(msg.data);

  const status = msg.data.status;
  const isRunning = status === 'in_progress' || msg.partial;
  const isFailed = status === 'failed';

  const toolState = isFailed
    ? 'output-error'
    : isRunning
      ? 'input-available'
      : 'output-available';

  const presentation = resolveToolPresentation(msg.data, msg.partial);
  const ToolIcon = isFailed
    ? AlertCircle
    : isRunning
      ? Loader2
      : presentation.integrationIcon
        ? mcpIntegrationIconFor(presentation.integrationIcon)
        : toolIconForKey(presentation.iconKey);

  const visualProofMedia = resolveVisualProofMediaForToolMessage(
    msg,
    artifactLink?.artifacts,
  );
  const showVisualProofPreview = visualProofMedia.length > 0;
  const showWidget = resolveShowWidgetForToolMessage(msg);
  const showWidgetPreview = showWidget !== null;
  const isSubagentRow = isSubagentToolPayload(msg.data);
  const policy = resolveToolPresentationPolicy(msg, {
    artifacts: artifactLink?.artifacts,
    showInternalMessages: showSubagentPayload,
  });
  // Direct manage_artifacts / show_widget rows collapse to just the preview;
  // subagent rows keep their collapsible prompt/result details alongside it.
  const showExpandedDetails =
    (isSubagentRow || (!showVisualProofPreview && !showWidgetPreview)) &&
    policy.detailMode === 'expandable';
  const showNestedActivity = Boolean(children);
  const showCollapsibleContent = showExpandedDetails || showNestedActivity;

  const subagentActivity = readSubagentActivity(
    msg.data as unknown as Record<string, unknown>,
  );
  // Running: agent name · current action · elapsed. Settled: agent name ·
  // spawn title · total elapsed + call count (the receipt).
  const showSubagentRow = presentation.category === 'subagent';

  const action = showSubagentRow
    ? (subagentActivity?.agentType ?? msg.data.agentType ?? title)
    : presentation.verb;

  const object = showSubagentRow
    ? isRunning
      ? sanitizeSandboxPathString(subagentActivity?.lastAction ?? 'starting…')
      : title
    : presentation.object;

  const suffix = showSubagentRow
    ? subagentActivity
      ? formatSubagentElapsed(subagentActivity)
      : undefined
    : presentation.identity.providerKind === 'mcp'
      ? presentation.providerLabel
      : undefined;
  const suffixPrefix = showSubagentRow ? '·' : 'from';

  return (
    <Message from="assistant" className="chat-tool-use-message">
      <MessageContent id={anchorId}>
        <Tool>
          <ToolHeader
            action={action}
            object={object}
            suffix={suffix}
            suffixPrefix={suffixPrefix}
            icon={ToolIcon}
            state={toolState}
            params={sanitizedToolData}
            collapsible={showCollapsibleContent}
          />
          {showVisualProofPreview ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {visualProofMedia.map((media) => (
                <VisualProofToolPreview key={media.artifactId} media={media} />
              ))}
            </div>
          ) : null}
          {showWidgetPreview && showWidget ? (
            <ShowWidgetPreview widget={showWidget} />
          ) : null}
          {showCollapsibleContent ? (
            <ToolContent className="px-4 ml-1.5 mb-4 mt-2 border-l text-sm font-light text-muted-foreground">
              {showExpandedDetails ? (
                <AcpToolDetails
                  msg={msg}
                  showSubagentPayload={showSubagentPayload}
                />
              ) : null}
              {showNestedActivity ? (
                <div className="mt-4 space-y-4 border-l border-border/60 pl-4">
                  {children}
                </div>
              ) : null}
            </ToolContent>
          ) : null}
        </Tool>
      </MessageContent>
    </Message>
  );
}

interface SubagentActivity {
  agentType?: string | null;
  lastAction?: string | null;
  toolCallCount?: number;
  startedAtMs?: number;
  elapsedMs?: number;
}

function readSubagentActivity(
  data: Record<string, unknown>,
): SubagentActivity | null {
  const value = data.subagentActivity;

  if (!value || typeof value !== 'object') {
    return null;
  }

  return value as SubagentActivity;
}

function formatSubagentElapsed(activity: SubagentActivity): string | undefined {
  const elapsedMs = activity.elapsedMs;

  if (typeof elapsedMs !== 'number' || elapsedMs < 0) {
    return undefined;
  }

  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const elapsed = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  const count = activity.toolCallCount;

  return typeof count === 'number' && count > 0
    ? `${elapsed} · ${count} ${count === 1 ? 'call' : 'calls'}`
    : elapsed;
}
