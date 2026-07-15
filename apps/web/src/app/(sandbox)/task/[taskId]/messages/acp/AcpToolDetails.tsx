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
        className="rounded-xl border px-4 py-2 text-sm whitespace-pre-wrap text-foreground/80"
        style={{ maxHeight, overflow: 'auto' }}
      >
        {sanitizeSandboxPathString(subagentPrompt)}
      </div>
    );
  }

  return sanitizedText ? (
    <CodeBlock code={sanitizedText} language="bash" maxHeight={maxHeight} />
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
