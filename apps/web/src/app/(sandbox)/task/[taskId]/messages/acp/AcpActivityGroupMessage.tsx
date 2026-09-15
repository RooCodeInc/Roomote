'use client';

import type { ReactNode } from 'react';

import { Message, MessageContent, ToolHeader } from '@/components/ai-elements';
import {
  AlertCircle,
  ChevronRight,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Spinner,
} from '@/components/system';
import { sanitizeSandboxPathString } from '@/lib';
import { cn } from '@/lib/utils';

import type { AcpActivityGroupRenderBlock } from './activity-groups';
import type { AcpRenderBlock } from './render-blocks';
import { resolveToolPresentation } from './tool-presentation';
import { mcpIntegrationIconFor, toolIconForKey } from './tool-icons';
import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from './types';

interface AcpActivityGroupMessageProps {
  group: AcpActivityGroupRenderBlock;
  anchorIds?: string[];
  children: ReactNode;
}

export function AcpActivityGroupMessage({
  group,
  anchorIds = [],
  children,
}: AcpActivityGroupMessageProps) {
  const latestTool = group.latestToolMessage;
  const presentation = latestTool
    ? resolveToolPresentation(latestTool.data, latestTool.partial)
    : null;
  const ToolIcon = presentation
    ? presentation.phase === 'failed'
      ? AlertCircle
      : presentation.integrationIcon
        ? mcpIntegrationIconFor(presentation.integrationIcon)
        : toolIconForKey(presentation.iconKey)
    : null;
  const activityTools = getActivityToolMessages(group.blocks);

  return (
    <Collapsible
      defaultOpen={false}
      className="group group/acp-activity my-3"
      data-testid="acp-activity-group"
    >
      {anchorIds.map((anchorId) => (
        <div
          key={anchorId}
          id={anchorId}
          aria-hidden="true"
          className="h-0 overflow-hidden"
        />
      ))}
      {group.live ? (
        presentation && ToolIcon ? (
          <ToolHeader
            action={presentation.verb}
            object={sanitizeSandboxPathString(presentation.object ?? '')}
            suffix={presentation.providerLabel}
            icon={ToolIcon}
            state={
              presentation.phase === 'failed'
                ? 'output-error'
                : presentation.phase === 'running'
                  ? 'input-available'
                  : 'output-available'
            }
          />
        ) : (
          <CollapsibleTrigger
            className={cn(
              'flex cursor-default items-center gap-2 py-1 text-sm font-light text-muted-foreground transition-opacity hover:opacity-50',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            )}
          >
            <Spinner size="sm" />
            <span>Working</span>
          </CollapsibleTrigger>
        )
      ) : (
        <div className="flex items-center gap-3">
          <CollapsibleTrigger
            className={cn(
              'flex shrink-0 cursor-pointer items-center gap-1.5 text-sm font-light text-muted-foreground/50 transition-colors hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            )}
          >
            <ChevronRight className="size-4 transition-transform group-data-[state=open]/acp-activity:rotate-90" />
            <span>
              Worked for {formatWorkedDuration(group.endTs - group.ts)}
            </span>
          </CollapsibleTrigger>
          <div
            className="h-px min-w-8 flex-1 border-t border-border/20 relative top-px"
            aria-hidden="true"
          />
        </div>
      )}
      <CollapsibleContent className="mt-4 space-y-0 border-l border-border pl-4 ml-2 data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=open]:animate-in">
        {activityTools.length > 0 ? (
          <ul className="space-y-1">
            {activityTools.map((tool) => (
              <ActivityToolListItem key={tool.id} tool={tool} />
            ))}
          </ul>
        ) : (
          children
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function getActivityToolMessages(
  blocks: AcpRenderBlock[],
): Array<AcpToolCallUiMessage | AcpToolResultUiMessage> {
  const tools: Array<{
    message: AcpToolCallUiMessage | AcpToolResultUiMessage;
    order: number;
  }> = [];

  function collect(nestedBlocks: AcpRenderBlock[]) {
    for (const block of nestedBlocks) {
      if (block.kind === 'tool_group') {
        for (const item of block.items) {
          tools.push({ message: item.msg, order: tools.length });
        }
        continue;
      }

      if (block.msg.kind === 'tool_call' || block.msg.kind === 'tool_result') {
        tools.push({ message: block.msg, order: tools.length });
      }

      if (block.childBlocks) {
        collect(block.childBlocks);
      }
    }
  }

  collect(blocks);

  return tools
    .sort(
      (left, right) =>
        left.message.ts - right.message.ts || left.order - right.order,
    )
    .map(({ message }) => message);
}

function ActivityToolListItem({
  tool,
}: {
  tool: AcpToolCallUiMessage | AcpToolResultUiMessage;
}) {
  const presentation = resolveToolPresentation(tool.data, tool.partial);
  const ToolIcon =
    presentation.phase === 'failed'
      ? AlertCircle
      : presentation.integrationIcon
        ? mcpIntegrationIconFor(presentation.integrationIcon)
        : toolIconForKey(presentation.iconKey);

  return (
    <li>
      <ToolHeader
        action={presentation.verb}
        object={sanitizeSandboxPathString(presentation.object ?? '')}
        suffix={presentation.providerLabel}
        icon={ToolIcon}
        state={
          presentation.phase === 'failed'
            ? 'output-error'
            : presentation.phase === 'running'
              ? 'input-available'
              : 'output-available'
        }
        collapsible={false}
      />
    </li>
  );
}

export function AcpWorkingMessage() {
  return (
    <Message from="assistant" className="chat-reasoning-message">
      <MessageContent>
        <div className="flex cursor-default items-center gap-2 text-sm font-light text-muted-foreground">
          <Spinner size="sm" />
          <span>Working</span>
        </div>
      </MessageContent>
    </Message>
  );
}

function formatWorkedDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (totalSeconds < 13) {
    return 'a bit';
  }

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  return `${seconds}s`;
}
