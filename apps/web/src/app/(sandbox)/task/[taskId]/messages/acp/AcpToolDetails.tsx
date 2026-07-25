import {
  sanitizeSandboxPathsForDisplay,
  sanitizeSandboxPathString,
} from '@/lib';

import { CodeBlock, ToolInput } from '@/components/ai-elements';

import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from './types';
import { isSubagentToolPayload } from './subagent-tool';
import {
  getSubagentLastMessage,
  getSubagentPrompt,
  hidesExpandedToolResult,
} from './tool-detail-visibility';

interface AcpToolDetailsProps {
  msg: AcpToolCallUiMessage | AcpToolResultUiMessage;
  maxHeight?: number;
  showSubagentPayload?: boolean;
}

export function AcpToolDetails({
  msg,
  maxHeight = 400,
  showSubagentPayload = false,
}: AcpToolDetailsProps) {
  if (hidesExpandedToolResult(msg, { showSubagentPayload })) {
    return null;
  }

  const sanitizedToolData = sanitizeSandboxPathsForDisplay(msg.data);
  const sanitizedText = msg.text
    ? sanitizeSandboxPathString(msg.text)
    : msg.text;
  const isSubagent = isSubagentToolPayload(msg.data);
  const subagentPrompt = getSubagentPrompt(msg);
  const subagentLastMessage = getSubagentLastMessage(msg);

  if (isSubagent && showSubagentPayload) {
    return (
      <ToolInput
        input={sanitizedToolData}
        style={{
          maxHeight,
          overflow: 'auto',
        }}
      />
    );
  }

  if (isSubagent && (subagentPrompt || subagentLastMessage)) {
    return (
      <div
        className="space-y-4 text-sm font-light text-muted-foreground"
        style={{ maxHeight, overflow: 'auto' }}
      >
        {subagentPrompt ? (
          <div className="space-y-1">
            <div className="text-xs font-medium text-foreground">
              Initial prompt
            </div>
            <div className="whitespace-pre-wrap">
              {sanitizeSandboxPathString(subagentPrompt)}
            </div>
          </div>
        ) : null}
        {subagentLastMessage ? (
          <div className="space-y-1">
            <div className="text-xs font-medium text-foreground">
              Last message
            </div>
            <div className="whitespace-pre-wrap">
              {sanitizeSandboxPathString(subagentLastMessage)}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return sanitizedText ? (
    <CodeBlock
      code={sanitizedText}
      language="bash"
      maxHeight={maxHeight}
      variant="compact"
      highlight={false}
      className="[&>div]:rounded-none [&>div]:bg-transparent [&_pre]:px-0 [&_pre]:py-0"
    />
  ) : (
    <ToolInput
      input={sanitizedToolData}
      style={{
        maxHeight,
        overflow: 'auto',
      }}
    />
  );
}
