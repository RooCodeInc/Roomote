'use client';

import {
  CheckCircle2,
  Container,
  GitBranch,
  ListChecks,
  Plug,
  Zap,
  type LucideIcon,
} from '@/components/system';
import {
  Message,
  MessageContent,
  Tool,
  ToolHeader,
} from '@/components/ai-elements';

import type { AcpSetupReceiptUiMessage } from './types';

const ICONS: Record<string, LucideIcon> = {
  container: Container,
  'git-branch': GitBranch,
  'list-checks': ListChecks,
  plug: Plug,
  zap: Zap,
};

export function AcpSetupReceiptMessage({
  msg,
}: {
  msg: AcpSetupReceiptUiMessage;
}) {
  const presentation = msg.data.presentation;
  const Icon = ICONS[presentation?.iconKey ?? ''] ?? CheckCircle2;
  const label = presentation?.label ?? msg.text ?? 'Setup action completed';

  return (
    <Message from="assistant" className="chat-tool-use-message">
      <MessageContent>
        <Tool>
          <ToolHeader
            action={label}
            icon={Icon}
            state="output-available"
            collapsible={false}
          />
        </Tool>
      </MessageContent>
    </Message>
  );
}
