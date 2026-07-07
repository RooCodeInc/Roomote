'use client';

import { useState, useRef, useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { Button } from '@/components/system';

import { _testUtils } from './use-task-completion-notification';

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta: Meta = {
  title: 'Surfaces/Task Workspace/Lifecycle/TaskCompletionNotification',
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="flex w-full max-w-md flex-col gap-6 rounded-lg border bg-background p-6">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Interactive demo
// ---------------------------------------------------------------------------

function NotificationDemo() {
  const [active, setActive] = useState(false);
  const faviconStateRef = useRef<ReturnType<
    typeof _testUtils.saveFaviconState
  > | null>(null);

  // Capture the original favicon once on mount.
  useEffect(() => {
    faviconStateRef.current = _testUtils.saveFaviconState();
  }, []);

  const trigger = () => {
    if (active) {
      return;
    }

    _testUtils.playNotificationSound();

    if (faviconStateRef.current) {
      _testUtils.setNotificationFavicon(faviconStateRef.current);
    }

    setActive(true);
  };

  const clear = () => {
    if (!active) {
      return;
    }

    if (faviconStateRef.current) {
      _testUtils.restoreFavicon(faviconStateRef.current);
    }

    setActive(false);
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-lg font-medium">Task Completion Notification</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Simulates the notification that fires when a running task becomes
          idle. A beep plays and the favicon gets a green dot overlay. In
          production this triggers automatically when the task phase transitions
          from &quot;running&quot; to &quot;idle&quot;, and clears when the tab
          regains focus.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={trigger} disabled={active}>
          Trigger Notification
        </Button>
        <Button onClick={clear} variant="outline" disabled={!active}>
          Clear Notification
        </Button>
      </div>
      <div
        className={`rounded px-3 py-2 text-xs font-medium ${
          active
            ? 'bg-green-500/10 text-green-600'
            : 'bg-muted text-muted-foreground'
        }`}
      >
        {active
          ? 'Notification active — check the favicon in the browser tab'
          : 'Notification inactive'}
      </div>
    </div>
  );
}

export const Interactive: Story = {
  render: () => <NotificationDemo />,
};
