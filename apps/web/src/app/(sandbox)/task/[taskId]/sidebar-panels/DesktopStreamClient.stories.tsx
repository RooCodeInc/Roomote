import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { DesktopStreamClient } from './DesktopStreamClient';

const meta: Meta<typeof DesktopStreamClient> = {
  title: 'Tasks/DesktopStreamClient',
  component: DesktopStreamClient,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    previewUrl: 'http://desktop-stream.invalid',
    runId: 1,
  },
  decorators: [
    (Story) => (
      <div style={{ width: '100vw', height: '100vh' }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Interactive: Story = {};
