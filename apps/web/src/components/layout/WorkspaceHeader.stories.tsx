import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { WorkspaceHeader } from './WorkspaceHeader';
import { SessionViewerAvatars } from '@/components/sessions/SessionViewers';
import { Button } from '@/components/system';
import {
  TaskHeaderContent,
  TaskHeaderMetadata,
  TaskTitle,
} from '@/app/(sandbox)/task/[taskId]/TaskHeader';
import {
  SESSION_HEADER_CONTENT_CLASS_NAME,
  SESSION_HEADER_TITLE_CLASS_NAME,
} from '@/app/(sandbox)/sessions/[sessionId]/session-header-layout';

const viewers = [
  'Alex Morgan',
  'Sam Rivera',
  'Taylor Chen',
  'Jordan Lee',
  'Casey Patel',
].map((name, index) => ({
  id: String(index),
  name,
  email: `${name.toLowerCase().replace(' ', '.')}@example.com`,
  imageUrl: '',
}));

const meta = {
  title: 'Layout/WorkspaceHeader',
  component: WorkspaceHeader,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof WorkspaceHeader>;
export default meta;
type Story = StoryObj<typeof meta>;

function SessionHeader({ count }: { count: number }) {
  return (
    <WorkspaceHeader
      className="py-3.25"
      contentClassName={`${SESSION_HEADER_CONTENT_CLASS_NAME} !flex-row !flex-nowrap`}
      actions={<SessionViewerAvatars viewers={viewers.slice(0, count)} />}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h1 className={SESSION_HEADER_TITLE_CLASS_NAME}>
          Investigate and improve the onboarding flow
        </h1>
        <TaskHeaderMetadata model="anthropic/claude-sonnet-4.6" />
      </div>
    </WorkspaceHeader>
  );
}

export const SessionEmpty: Story = {
  render: () => <SessionHeader count={0} />,
};
export const SessionOneViewer: Story = {
  render: () => <SessionHeader count={1} />,
};
export const SessionThreeViewers: Story = {
  render: () => <SessionHeader count={3} />,
};
export const SessionManyViewers: Story = {
  render: () => <SessionHeader count={5} />,
};
export const SessionTransition: Story = {
  render: function Transition() {
    const [expanded, setExpanded] = useState(false);
    return (
      <>
        <SessionHeader count={expanded ? 5 : 3} />
        <div className="p-4">
          <Button onClick={() => setExpanded((value) => !value)}>
            Toggle additional viewers
          </Button>
        </div>
      </>
    );
  },
};

export const Task: Story = {
  render: () => (
    <WorkspaceHeader className="py-3.25">
      <TaskHeaderContent taskId="example-task">
        <h1 className="text-sm font-medium">
          <TaskTitle
            taskId="example-task"
            title="Implement the onboarding improvements"
            showIcon={false}
          />
        </h1>
        <TaskHeaderMetadata model="anthropic/claude-sonnet-4.6" />
      </TaskHeaderContent>
    </WorkspaceHeader>
  ),
};
