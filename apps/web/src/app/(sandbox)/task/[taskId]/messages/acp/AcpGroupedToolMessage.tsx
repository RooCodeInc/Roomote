import { sanitizeSandboxPathString } from '@/lib';

import {
  type LucideIcon,
  AlertCircle,
  File as FileIcon,
  FolderIcon,
  Loader2,
  Search,
} from '@/components/system';
import {
  Message,
  MessageContent,
  Tool,
  ToolContent,
  ToolHeader,
} from '@/components/ai-elements';

import { messageAnchorId } from '../message-anchor';

import { AcpToolDetails } from './AcpToolDetails';
import { hidesExpandedToolResult } from './tool-detail-visibility';
import type {
  ExplorationStepKind,
  GroupedToolCallRenderBlock,
} from './render-blocks';

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
  const showExpandedDetails = group.items.length > 0;

  const toolState = hasFailed
    ? 'output-error'
    : hasRunning
      ? 'input-available'
      : 'output-available';

  const ToolIcon = groupedToolIcon({ hasFailed, hasRunning });

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
            <ToolContent className="mt-2 space-y-4">
              {group.items.map((item) => {
                const sectionTitle = sanitizeSandboxPathString(
                  item.objectLabel,
                );
                const showItemDetails = !hidesExpandedToolResult(item.msg, {
                  showSubagentPayload,
                });

                return (
                  <section key={item.msg.id} className="space-y-2">
                    <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground">
                      <GroupedToolItemIcon
                        stepKind={item.stepKind}
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
  hasRunning: boolean;
  hasFailed: boolean;
}): LucideIcon {
  if (params.hasRunning) return Loader2;
  if (params.hasFailed) return AlertCircle;
  return Search;
}

function GroupedToolItemIcon({
  stepKind,
  className,
}: {
  stepKind: ExplorationStepKind;
  className?: string;
}) {
  if (stepKind === 'search') {
    return <Search className={className} />;
  }

  if (stepKind === 'list') {
    return <FolderIcon className={className} />;
  }

  return <FileIcon className={className} />;
}
