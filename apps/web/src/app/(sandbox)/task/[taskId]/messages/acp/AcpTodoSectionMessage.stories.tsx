'use client';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { AcpTodoSectionMessage } from './AcpTodoSectionMessage';
import type { AcpTodoSectionUiMessage } from './types';

const meta: Meta<typeof AcpTodoSectionMessage> = {
  title: 'Surfaces/Task Workspace/ACP/TodoSectionMessage',
  component: AcpTodoSectionMessage,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl border rounded-lg overflow-hidden bg-background p-4">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof AcpTodoSectionMessage>;

const todoSectionMsg = (
  content: string,
  overrides: Partial<AcpTodoSectionUiMessage> = {},
): AcpTodoSectionUiMessage => ({
  id: overrides.id ?? 'todo-section-story',
  ts: overrides.ts ?? 1700000000000,
  role: overrides.role ?? 'assistant',
  partial: overrides.partial ?? false,
  sessionId: overrides.sessionId ?? null,
  updateType: overrides.updateType ?? 'roomote_runtime.plan',
  kind: 'todo_section',
  text: content,
  data: {
    todoId: 'todo-story',
    content,
  },
});

export const DefaultHeading: Story = {
  args: {
    msg: todoSectionMsg('Implement ACP todo headings divider'),
  },
};

export const LongHeading: Story = {
  args: {
    msg: todoSectionMsg(
      'Investigate message rendering edge cases in ACP todo streams and verify heading truncation stays stable during rapid updates',
      { ts: 1700000000100 },
    ),
  },
};

export const SymbolHeavyHeading: Story = {
  args: {
    msg: todoSectionMsg(
      '[Plan] Parse -> Normalize -> Render (ACP todo section)',
      { ts: 1700000000200 },
    ),
  },
};
