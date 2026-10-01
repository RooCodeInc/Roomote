'use client';

import { getModelFallbackNoticeFromMessageData } from '@roomote/types';

import { ArrowRightLeft } from '@/components/system';
import { Tool, ToolContent, ToolHeader } from '@/components/ai-elements';

export function ModelFallbackNoticeMessage({
  data,
}: {
  data: Record<string, unknown>;
}) {
  const notice = getModelFallbackNoticeFromMessageData(data);
  if (!notice) return null;

  return (
    <Tool defaultOpen={false} data-testid="model-fallback-notice">
      <ToolHeader
        action="Switching to fallback model"
        icon={ArrowRightLeft}
        state="output-available"
      />
      <ToolContent className="space-y-1 px-4 ml-1.5 mb-4 mt-2 border-l text-sm font-light text-muted-foreground">
        <p>Failed provider: {notice.fromProvider}</p>
        <p>Error: {notice.errorSummary}</p>
        <p>
          Switched to: {notice.toModelId}
          {notice.toReasoningEffort ? ` (${notice.toReasoningEffort})` : ''}
        </p>
      </ToolContent>
    </Tool>
  );
}
