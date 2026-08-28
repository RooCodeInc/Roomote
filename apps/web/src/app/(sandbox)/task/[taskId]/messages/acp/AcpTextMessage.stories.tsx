'use client';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import { FramedSurface } from '@/components/layout';
import { Button, ExternalLink } from '@/components/system';

import { SandboxSidePanelHeader } from '../../../../SandboxSidePanelHeader';
import { SandboxLayoutContext } from '../../../../use-sandbox-layout';
import { AcpTextMessage } from './AcpTextMessage';
import type { AcpUiMessage } from './types';

type RequesterAvatarPanelProps = {
  imageUrl: string | null;
  name: string;
  email: string;
};

function RequesterAvatarPanel({
  imageUrl,
  name,
  email,
}: RequesterAvatarPanelProps) {
  const message: AcpUiMessage = {
    id: 'requester-avatar-proof',
    ts: new Date('2026-08-28T14:55:00Z').getTime(),
    role: 'user',
    kind: 'text',
    partial: false,
    sessionId: 'storybook-session',
    updateType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
    text: 'Investigate and implement measurement for Fast session first-response latency. Include the request lifecycle, durable telemetry, and focused regression coverage.',
    data: {},
    userName: name,
    userEmail: email,
    userImageUrl: imageUrl,
  };

  return (
    <SandboxLayoutContext.Provider
      value={{
        isSidebarVisible: true,
        setSidebarVisible: () => undefined,
        toggleSidebar: () => undefined,
      }}
    >
      <div className="h-[560px] w-[720px] bg-card p-3">
        <FramedSurface
          frameClassName="p-0"
          surfaceClassName="relative flex flex-col overflow-hidden"
        >
          <SandboxSidePanelHeader
            title="Measure Fast session first-response latency"
            onClose={() => undefined}
            actions={
              <Button variant="ghost" size="sm">
                Go to task
                <ExternalLink />
              </Button>
            }
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            <div className="mx-auto w-full max-w-4xl p-4">
              <AcpTextMessage msg={message} />
            </div>
          </div>
        </FramedSurface>
      </div>
    </SandboxLayoutContext.Provider>
  );
}

const meta = {
  title: 'Surfaces/Task Workspace/ACP/RequesterAvatar',
  component: RequesterAvatarPanel,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof RequesterAvatarPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ValidRequesterImage: Story = {
  args: {
    imageUrl: '/apple-touch-icon-dev.png',
    name: 'Local Admin',
    email: 'local@roomote.dev',
  },
};

export const FailedRequesterImageFallback: Story = {
  args: {
    imageUrl: '/missing-requester-avatar.png',
    name: 'Roomote Demo',
    email: 'demo@roomote.dev',
  },
};
