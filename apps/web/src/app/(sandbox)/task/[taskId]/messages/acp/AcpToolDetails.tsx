import {
  sanitizeSandboxPathsForDisplay,
  sanitizeSandboxPathString,
} from '@/lib';

import { CodeBlock, ToolInput } from '@/components/ai-elements';

import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from './types';
import { isSubagentToolPayload } from './subagent-tool';
import {
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

  if (isSubagent && subagentPrompt) {
    return (
      <div
        className="whitespace-pre-wrap text-sm font-light text-muted-foreground"
        style={{ maxHeight, overflow: 'auto' }}
      >
        {sanitizeSandboxPathString(subagentPrompt)}
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
