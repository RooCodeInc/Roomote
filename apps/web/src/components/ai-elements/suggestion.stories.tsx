'use client';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { Suggestion, Suggestions } from './suggestion';

const meta: Meta<typeof Suggestion> = {
  title: 'Patterns/AI Elements/Conversation/Suggestion',
  component: Suggestion,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    suggestion: {
      control: 'text',
      description: 'The suggestion text',
    },
    selected: {
      control: 'boolean',
      description: 'Whether the suggestion is selected',
    },
    disabled: {
      control: 'boolean',
      description: 'Whether the suggestion is disabled',
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    suggestion: 'Yes, proceed with the changes',
  },
};

export const Selected: Story = {
  args: {
    suggestion: 'Yes, proceed with the changes',
    selected: true,
  },
};

export const Disabled: Story = {
  args: {
    suggestion: 'Yes, proceed with the changes',
    disabled: true,
  },
};

export const MultipleSuggestions: Story = {
  render: () => (
    <Suggestions>
      <Suggestion suggestion="Yes, proceed" />
      <Suggestion suggestion="No, cancel the operation" />
      <Suggestion suggestion="Let me think about it" />
    </Suggestions>
  ),
};

export const DisabledWithSelected: Story = {
  name: 'Answered (disabled + selected)',
  render: () => (
    <Suggestions>
      <Suggestion suggestion="Yes, proceed" disabled selected />
      <Suggestion suggestion="No, cancel the operation" disabled />
      <Suggestion suggestion="Let me think about it" disabled />
    </Suggestions>
  ),
};

export const SingleSuggestion: Story = {
  render: () => (
    <Suggestions>
      <Suggestion suggestion="Understood, I'll fix the bug" />
    </Suggestions>
  ),
};

export const LongSuggestions: Story = {
  name: 'Long Suggestion Text',
  render: () => (
    <Suggestions>
      <Suggestion suggestion="Yes, please refactor the entire authentication module to use JWT tokens instead of session cookies" />
      <Suggestion suggestion="No, keep the current implementation but add rate limiting" />
    </Suggestions>
  ),
};
