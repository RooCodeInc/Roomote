import {
  sanitizeSandboxPathsForDisplay,
  sanitizeSandboxPathString,
} from '@/lib';

import {
  CodeBlock,
  MessageResponse,
  ToolInput,
} from '@/components/ai-elements';
import {
  ChevronRight,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/system';

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
        className="space-y-3 text-sm font-light text-muted-foreground"
        style={{ maxHeight, overflow: 'auto' }}
      >
        {subagentLastMessage ? (
          <MessageResponse>
            {sanitizeSandboxPathString(subagentLastMessage)}
          </MessageResponse>
        ) : null}
        {subagentPrompt ? (
          <Collapsible
            defaultOpen={!subagentLastMessage}
            className="group/acp-subagent-prompt"
          >
            <CollapsibleTrigger className="flex cursor-pointer items-center gap-1.5 text-sm font-light text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
              <ChevronRight className="size-4 transition-transform group-data-[state=open]/acp-subagent-prompt:rotate-90" />
              <span>Prompt</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 ml-2 whitespace-pre-wrap border-l border-border pl-4 data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=open]:animate-in">
              {sanitizeSandboxPathString(subagentPrompt)}
            </CollapsibleContent>
          </Collapsible>
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
