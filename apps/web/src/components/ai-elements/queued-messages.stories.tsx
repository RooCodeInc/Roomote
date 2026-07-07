import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import type { QueuedMessage } from '@/app/(sandbox)/task/[taskId]/types';

import {
  QueuedMessagesContent,
  type QueuedMessagesContentProps,
} from '@/app/(sandbox)/task/[taskId]/QueuedMessages';

const meta: Meta<QueuedMessagesContentProps> = {
  title: 'Patterns/AI Elements/Conversation/QueuedMessages',
  component: QueuedMessagesContent,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl border rounded-lg bg-background">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

const makeMessage = (
  id: string,
  text: string,
  images?: string[],
): QueuedMessage => ({
  id,
  text,
  timestamp: Date.now(),
  images,
});

export const Default: Story = {
  args: {
    queuedMessages: [
      makeMessage('1', 'Fix the login page styling'),
      makeMessage('2', 'Add unit tests for the auth module'),
      makeMessage('3', 'Update the README with new API endpoints'),
    ],
  },
};

export const SingleMessage: Story = {
  args: {
    queuedMessages: [makeMessage('1', 'Refactor the database layer')],
  },
};

export const WithImageOnlyMessages: Story = {
  args: {
    queuedMessages: [
      makeMessage('1', 'Fix this layout issue'),
      makeMessage('2', '', ['data:image/png;base64,...']),
      makeMessage('3', 'Also check the mobile view'),
      makeMessage('4', '', [
        'data:image/png;base64,...',
        'data:image/png;base64,...',
      ]),
    ],
  },
};

export const ManyMessages: Story = {
  args: {
    queuedMessages: Array.from({ length: 12 }, (_, i) =>
      makeMessage(`${i + 1}`, `Queued task number ${i + 1}`),
    ),
  },
};
