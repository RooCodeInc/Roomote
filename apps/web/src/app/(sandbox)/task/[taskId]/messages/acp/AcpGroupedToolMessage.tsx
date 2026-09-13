import { sanitizeSandboxPathString } from '@/lib';

import {
  type LucideIcon,
  AlertCircle,
  Loader2,
  Telescope,
} from '@/components/system';
import { useTaskRobotIconContext } from '@/components/tasks/TaskRobotIcon';
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
import { resolveTaskToolReference } from './task-tool-reference';
import { useTaskToolIcon } from './task-tool-icon';
import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from './types';

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
    isExploration: group.action === 'Exploring',
  });
  const context = useTaskRobotIconContext();
  const references = group.items.map((item) =>
    resolveTaskToolReference(item.msg, context),
  );
  const firstReference = references[0];
  const uniformReference =
    firstReference?.taskId &&
    references.every((reference) => reference?.taskId === firstReference.taskId)
      ? firstReference
      : null;
  const taskIcon = useTaskToolIcon(uniformReference, hasFailed);

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
            {...taskIcon}
            state={toolState}
            collapsible={showExpandedDetails}
          />
          {showExpandedDetails ? (
            <ToolContent className="space-y-3 px-4 ml-1.5 mb-4 mt-2 border-l text-sm font-light text-muted-foreground">
              {group.items.map((item) => {
                const itemPresentation = resolveToolPresentation(
                  item.msg.data,
                  item.msg.partial,
                );
                const sectionTitle = sanitizeSandboxPathString(
                  itemPresentation.identity.toolName === 'manage_wakeups'
                    ? `${itemPresentation.verb} ${itemPresentation.object}`
                    : item.objectLabel,
                );
                const showItemDetails =
                  resolveToolPresentationPolicy(item.msg, {
                    showInternalMessages: showSubagentPayload,
                  }).detailMode === 'expandable';
                return (
                  <section key={item.msg.id} className="space-y-2">
                    <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground">
                      <GroupedToolItemIcon
                        msg={item.msg}
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
  hasFailed: boolean;
  isExploration: boolean;
}): LucideIcon {
  if (params.hasFailed) return AlertCircle;
  if (params.isExploration) return Telescope;
  return params.presentation.integrationIcon
    ? mcpIntegrationIconFor(params.presentation.integrationIcon)
    : toolIconForKey(params.presentation.iconKey);
}

function GroupedToolItemIcon({
  msg,
  className,
}: {
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage;
  className?: string;
}) {
  const presentation = resolveToolPresentation(msg.data, msg.partial);
  const context = useTaskRobotIconContext();
  const reference = resolveTaskToolReference(msg, context);
  const failed = presentation.phase === 'failed';
  const { iconElement, iconAction } = useTaskToolIcon(reference, failed);
  const Icon =
    reference && failed
      ? AlertCircle
      : presentation.integrationIcon
        ? mcpIntegrationIconFor(presentation.integrationIcon)
        : toolIconForKey(presentation.iconKey);
  if (iconElement) {
    return (
      <>
        {iconAction ? (
          <button
            type="button"
            aria-label={iconAction.label}
            onClick={iconAction.onClick}
            className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {iconElement}
          </button>
        ) : (
          iconElement
        )}
        {presentation.phase === 'running' ? (
          <Loader2
            aria-label="Running"
            className="size-3 shrink-0 animate-spin"
          />
        ) : null}
      </>
    );
  }
  return <Icon className={className} />;
}
