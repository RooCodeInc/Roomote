import {
  sanitizeSandboxPathsForDisplay,
  sanitizeSandboxPathString,
} from '@/lib';

import { CodeBlock, ToolInput } from '@/components/ai-elements';

import type { AcpToolCallUiMessage, AcpToolResultUiMessage } from './types';
import { isSubagentToolPayload } from './subagent-tool';
import { hidesExpandedToolResult } from './tool-detail-visibility';

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
  const shouldShowToolInput =
    showSubagentPayload && isSubagentToolPayload(msg.data);

  return !shouldShowToolInput && sanitizedText ? (
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
