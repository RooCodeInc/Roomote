'use client';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { AcpGroupedToolMessage } from './AcpGroupedToolMessage';
import type { GroupedToolCallRenderBlock } from './render-blocks';
import type { AcpToolResultUiMessage } from './types';

const startedAt = Date.now();

function commandResult(
  id: string,
  command: string,
  output: string,
  status: 'completed' | 'in_progress',
): AcpToolResultUiMessage {
  return {
    id,
    ts: startedAt,
    startedAt,
    role: 'tool',
    partial: status === 'in_progress',
    sessionId: 'storybook-session',
    updateType: 'roomote_runtime.tool_result',
    kind: 'tool_result',
    text: output,
    data: {
      toolCallId: id,
      kind: 'execute_command',
      title: command,
      isExecute: true,
      isMcp: false,
      mcpServerName: null,
      mcpToolName: null,
      command,
      exitCode: status === 'completed' ? 0 : null,
      output,
      status,
    },
  };
}

const group: GroupedToolCallRenderBlock = {
  kind: 'tool_group',
  id: 'grouped-commands',
  ts: startedAt,
  action: 'Running',
  objectSummary: '2 commands',
  groupKey: 'execute:storybook',
  displayKind: 'execute',
  items: [
    {
      objectLabel: 'pnpm install',
      groupKey: 'execute:storybook',
      displayKind: 'execute',
      stepKind: null,
      msg: commandResult(
        'install-command',
        'pnpm install',
        'Packages: +1842\nDone in 12.4s',
        'completed',
      ),
    },
    {
      objectLabel: 'pnpm check-types',
      groupKey: 'execute:storybook',
      displayKind: 'execute',
      stepKind: null,
      msg: commandResult(
        'typecheck-command',
        'pnpm check-types',
        'Packages in scope: 29\nRunning check-types in 29 packages...',
        'in_progress',
      ),
    },
  ],
};

const meta: Meta<typeof AcpGroupedToolMessage> = {
  title: 'Surfaces/Task Workspace/ACP/GroupedToolMessage',
  component: AcpGroupedToolMessage,
  parameters: {
    layout: 'padded',
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl rounded-lg border bg-background p-4">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof AcpGroupedToolMessage>;

export const CommandOutputEnabled: Story = {
  args: {
    group,
    showCommandOutput: true,
  },
};
