'use client';

import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import type { SessionWakeupSummary } from '@roomote/types';

import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  PromptInputActionMenu,
  PromptInputActionMenuTrigger,
  PromptInputActionMenuContent,
  PromptInputActionAddAttachments,
} from '@/components/ai-elements';

import { SessionWakeupList } from './SessionWakeupList';

function WakeupComposer({
  entries,
  canCancel = true,
  cancellation = 'success',
}: {
  entries: { name: string; inSeconds: number }[];
  canCancel?: boolean;
  cancellation?: 'success' | 'pending' | 'error';
}) {
  const [wakeups, setWakeups] = useState<SessionWakeupSummary[]>(() => {
    const now = Date.now();
    return entries.map((entry, index) => ({
      id: `wakeup-${index}`,
      name: entry.name,
      prompt: entry.name,
      schedule: {
        mode: 'once',
        at: new Date(now + entry.inSeconds * 1_000).toISOString(),
      },
      scheduleDescription: 'Once',
      reportPolicy: 'always',
      internal: false,
      status: 'active',
      runCount: 0,
      maxRuns: null,
      until: null,
      nextRunAt: new Date(now + entry.inSeconds * 1_000).toISOString(),
      lastFiredAt: null,
      lastError: null,
      createdAt: new Date(now).toISOString(),
    }));
  });
  return (
    <div className="mx-auto w-full max-w-4xl">
      <SessionWakeupList
        wakeups={wakeups}
        canCancel={canCancel}
        onCancel={async (id) => {
          if (cancellation === 'pending') await new Promise(() => {});
          await new Promise((resolve) => setTimeout(resolve, 800));
          if (cancellation === 'error')
            throw new Error('Cancellation unavailable');
          setWakeups((current) => current.filter((wakeup) => wakeup.id !== id));
        }}
      />
      <PromptInput onSubmit={() => {}}>
        <PromptInputBody>
          <PromptInputTextarea placeholder="Message agent" />
        </PromptInputBody>
        <PromptInputFooter className="px-4 pt-0 pb-4">
          <PromptInputTools>
            <PromptInputActionMenu>
              <PromptInputActionMenuTrigger aria-label="Add to session" />
              <PromptInputActionMenuContent>
                <PromptInputActionAddAttachments />
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
          </PromptInputTools>
          <PromptInputSubmit disabled />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

const meta: Meta<typeof WakeupComposer> = {
  title: 'Surfaces/Session/Prompt Input/Wakeups',
  component: WakeupComposer,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className="bg-background p-4 text-foreground sm:p-6">
        <Story />
      </div>
    ),
  ],
  args: { entries: [{ name: 'Check CI', inSeconds: 15 * 60 }] },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = {
  args: { entries: [{ name: 'Check CI', inSeconds: 40 }] },
};

export const Multiple: Story = {
  args: {
    entries: [
      { name: 'Check CI', inSeconds: 299 },
      { name: 'Review release notes', inSeconds: 2 * 86_400 },
      {
        name: 'Check the deployment health and follow up on the rollout',
        inSeconds: 2 * 86_400 + 3_600,
      },
    ],
  },
};

export const UnderFiveMinutes: Story = {
  args: { entries: [{ name: 'Check CI', inSeconds: 299 }] },
};

export const LongCountdowns: Story = {
  args: {
    entries: [
      { name: 'Review release notes', inSeconds: 90 * 60 },
      { name: 'Weekly release check', inSeconds: 3 * 86_400 },
    ],
  },
};

export const DueSoon: Story = {
  args: { entries: [{ name: 'Check CI', inSeconds: -1 }] },
};

export const BecomesDue: Story = {
  args: { entries: [{ name: 'Check CI', inSeconds: 5 }] },
};

export const CancellationPending: Story = {
  args: { cancellation: 'pending' },
  parameters: {
    docs: {
      description: {
        story:
          'Click the trash button to keep cancellation pending. The control is disabled while the request is outstanding.',
      },
    },
  },
};

export const CancellationError: Story = {
  args: { cancellation: 'error' },
  parameters: {
    docs: {
      description: {
        story:
          'Click the trash button to show the inline cancellation error. The wakeup remains visible and the action can be retried.',
      },
    },
  },
};

export const ReadOnly: Story = { args: { canCancel: false } };
