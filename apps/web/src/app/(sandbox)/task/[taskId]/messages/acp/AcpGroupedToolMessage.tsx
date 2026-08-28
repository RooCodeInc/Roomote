import { sanitizeSandboxPathString } from '@/lib';

import { type LucideIcon, AlertCircle, Loader2 } from '@/components/system';
import {
  Message,
  MessageContent,
  Tool,
  ToolContent,
  ToolHeader,
} from '@/components/ai-elements';

import { messageAnchorId } from '../message-anchor';

import { AcpToolDetails } from './AcpToolDetails';
import type { GroupedToolCallRenderBlock } from './render-blocks';
import { mcpIntegrationIconFor, toolIconForKey } from './tool-icons';
import { resolveToolPresentation } from './tool-presentation';
import { resolveToolPresentationPolicy } from './tool-presentation-policy';

interface AcpGroupedToolMessageProps {
  group: GroupedToolCallRenderBlock;
  showSubagentPayload?: boolean;
}

const GROUPED_TOOL_ITEM_MAX_HEIGHT = 200;

export function AcpGroupedToolMessage({
  group,
  showSubagentPayload = false,
}: AcpGroupedToolMessageProps) {
  const anchorId = messageAnchorId(group.ts);
  const objectSummary = sanitizeSandboxPathString(group.objectSummary);
  const extraAnchors = group.items.slice(1).map((item) => ({
    id: messageAnchorId(item.msg.ts),
    key: item.msg.id,
  }));

  const hasFailed = group.items.some(
    (item) => item.msg.data.status === 'failed',
  );
  const hasRunning = group.items.some(
    (item) =>
      item.msg.partial === true || item.msg.data.status === 'in_progress',
  );
  const showExpandedDetails = group.items.some(
    (item) =>
      resolveToolPresentationPolicy(item.msg, {
        showInternalMessages: showSubagentPayload,
      }).detailMode === 'expandable',
  );

  const toolState = hasFailed
    ? 'output-error'
    : hasRunning
      ? 'input-available'
      : 'output-available';

  const firstPresentation = resolveToolPresentation(
    group.items[0]!.msg.data,
    group.items[0]!.msg.partial,
  );
  const ToolIcon = groupedToolIcon({
    presentation: firstPresentation,
    hasFailed,
    hasRunning,
  });

  return (
    <Message from="assistant" className="chat-tool-use-message">
      <MessageContent id={anchorId}>
        <Tool>
          {extraAnchors.map((anchor) => (
            <div
              key={`anchor-${anchor.key}`}
              id={anchor.id}
              aria-hidden="true"
              className="h-0 overflow-hidden"
            />
          ))}
          <ToolHeader
            action={group.action}
            object={objectSummary}
            icon={ToolIcon}
            state={toolState}
            collapsible={showExpandedDetails}
          />
          {showExpandedDetails ? (
            <ToolContent className="space-y-3 px-4 ml-1.5 mb-4 mt-2 border-l text-sm font-light text-muted-foreground">
              {group.items.map((item) => {
                const sectionTitle = sanitizeSandboxPathString(
                  item.objectLabel,
                );
                const showItemDetails =
                  resolveToolPresentationPolicy(item.msg, {
                    showInternalMessages: showSubagentPayload,
                  }).detailMode === 'expandable';
                const presentation = resolveToolPresentation(
                  item.msg.data,
                  item.msg.partial,
                );

                return (
                  <section key={item.msg.id} className="space-y-2">
                    <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground">
                      <GroupedToolItemIcon
                        presentation={presentation}
                        className="size-3 shrink-0"
                      />
                      <span className="truncate">{sectionTitle}</span>
                    </div>
                    {showItemDetails ? (
                      <AcpToolDetails
                        msg={item.msg}
                        maxHeight={GROUPED_TOOL_ITEM_MAX_HEIGHT}
                        showSubagentPayload={showSubagentPayload}
                      />
                    ) : null}
                  </section>
                );
              })}
            </ToolContent>
          ) : null}
        </Tool>
      </MessageContent>
    </Message>
  );
}

function groupedToolIcon(params: {
  presentation: ReturnType<typeof resolveToolPresentation>;
  hasRunning: boolean;
  hasFailed: boolean;
}): LucideIcon {
  if (params.hasFailed) return AlertCircle;
  if (params.hasRunning) return Loader2;
  return params.presentation.integrationIcon
    ? mcpIntegrationIconFor(params.presentation.integrationIcon)
    : toolIconForKey(params.presentation.iconKey);
}

function GroupedToolItemIcon({
  presentation,
  className,
}: {
  presentation: ReturnType<typeof resolveToolPresentation>;
  className?: string;
}) {
  const Icon = presentation.integrationIcon
    ? mcpIntegrationIconFor(presentation.integrationIcon)
    : toolIconForKey(presentation.iconKey);
  return <Icon className={className} />;
}
