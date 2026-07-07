import type { ReactNode } from 'react';

import {
  sanitizeSandboxPathsForDisplay,
  sanitizeSandboxPathString,
} from '@/lib';

import {
  type LucideIcon,
  AlertCircle,
  Bot,
  Eye,
  Loader2,
  SquarePen,
  Terminal,
  Search,
  Wrench,
} from '@/components/system';
import {
  Message,
  MessageContent,
  Tool,
  ToolContent,
  ToolHeader,
} from '@/components/ai-elements';

import { messageAnchorId } from '../message-anchor';

import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from './types';
import { AcpToolDetails } from './AcpToolDetails';
import { hidesExpandedToolResult } from './tool-detail-visibility';

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
  const anchorId = messageAnchorId(msg.ts);
  const kind = msg.data.kind;
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

  const ToolIcon = toolKindIcon({ kind, isRunning, isFailed });

  const isMcp = msg.data.isMcp;
  const isMcpLabelPresent = Boolean(msg.data.toolName || msg.data.serverName);
  const showExpandedDetails = !hidesExpandedToolResult(msg, {
    showSubagentPayload,
  });
  const showNestedActivity = Boolean(children);
  const showToolContent = showExpandedDetails || showNestedActivity;

  const subagentActivity = readSubagentActivity(
    msg.data as unknown as Record<string, unknown>,
  );
  // Running: agent name · current action · elapsed. Settled: agent name ·
  // spawn title · total elapsed + call count (the receipt).
  const showSubagentRow = kind === 'subagent' && subagentActivity !== null;

  const action = showSubagentRow
    ? (subagentActivity.agentType ?? title)
    : isMcp && isMcpLabelPresent
      ? isRunning
        ? 'Using'
        : 'Used'
      : title;

  const object = showSubagentRow
    ? isRunning
      ? sanitizeSandboxPathString(subagentActivity.lastAction ?? 'starting…')
      : title
    : isMcp && isMcpLabelPresent
      ? formatToolPart(msg.data.toolName ?? msg.data.serverName ?? '')
      : undefined;

  const suffix = showSubagentRow
    ? formatSubagentElapsed(subagentActivity)
    : msg.data.isMcp && msg.data.toolName && msg.data.serverName
      ? formatToolPart(msg.data.serverName)
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
            collapsible={showToolContent}
          />
          {showToolContent ? (
            <ToolContent className="mt-2">
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

/** Format a raw tool/server identifier into a human-readable label. */
function formatToolPart(str: string): string {
  return str
    .replace(/[.]/g, ' ')
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function toolKindIcon(params: {
  kind: string | null;
  isRunning: boolean;
  isFailed: boolean;
}): LucideIcon {
  if (params.isRunning) return Loader2;
  if (params.isFailed) return AlertCircle;
  if (params.kind === 'subagent') return Bot;
  if (params.kind === 'read') return Eye;
  if (params.kind === 'execute') return Terminal;
  if (params.kind === 'search') return Search;
  if (params.kind === 'edit') return SquarePen;
  return Wrench;
}
