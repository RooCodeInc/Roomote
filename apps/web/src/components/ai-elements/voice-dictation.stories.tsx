'use client';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { VoiceDictationButton } from './voice-dictation';

const meta: Meta<typeof VoiceDictationButton> = {
  title: 'Patterns/AI Elements/Composer/VoiceDictationButton',
  component: VoiceDictationButton,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    isRecording: {
      control: 'boolean',
      description: 'Whether recording is active',
    },
    isSupported: {
      control: 'boolean',
      description: 'Whether Web Speech API is supported',
    },
    disabled: {
      control: 'boolean',
      description: 'Whether the button is disabled',
    },
    onClick: {
      action: 'clicked',
      description: 'Toggle recording on/off',
    },
  },
  decorators: [
    (Story) => (
      <div className="flex items-center gap-2 rounded-lg border p-4">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    isRecording: false,
    isSupported: true,
    disabled: false,
  },
};

export const Recording: Story = {
  args: {
    isRecording: true,
    isSupported: true,
    disabled: false,
  },
};

export const Disabled: Story = {
  args: {
    isRecording: false,
    isSupported: true,
    disabled: true,
  },
};

export const Unsupported: Story = {
  name: 'Unsupported (hidden)',
  args: {
    isRecording: false,
    isSupported: false,
    disabled: false,
  },
};
