'use client';

import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { Reasoning, ReasoningContent, ReasoningTrigger } from './reasoning';

const meta: Meta = {
  title: 'Patterns/AI Elements/Conversation/Reasoning',
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl bg-background p-4">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Sample reasoning text
// ---------------------------------------------------------------------------

const SHORT_REASONING = `The user wants to add a dark mode toggle. I should check the existing theme setup first.`;

const MEDIUM_REASONING = `Let me analyze the request. The user wants to refactor the authentication module.

First, I need to understand the current implementation:
- The auth module uses session cookies
- Sessions are stored in Redis
- The middleware checks for valid sessions on each request

The refactoring to JWT would involve:
1. Replace session creation with JWT token generation
2. Update middleware to validate JWT instead of session lookup
3. Add refresh token rotation for security
4. Update the client to store tokens appropriately

I'll start by reading the existing auth module to understand the exact implementation details.`;

const LONG_REASONING = `This is a complex request that requires careful planning. Let me break it down step by step.

## Analysis

The user wants to implement a full-stack feature: real-time notifications. This involves:

### Backend Changes
- WebSocket server setup using Socket.io
- Database schema for notifications (PostgreSQL)
- API endpoints for marking notifications as read
- Event system for triggering notifications

### Frontend Changes
- WebSocket client connection management
- Notification bell component with badge count
- Notification dropdown/panel
- Toast notifications for real-time alerts
- Sound effects (optional)

### Infrastructure
- Redis pub/sub for scaling WebSocket across multiple servers
- Rate limiting for notification generation
- Batch processing for bulk notifications

## Implementation Plan

I'll start with the database schema since everything depends on the data model. Then I'll build the API layer, followed by the WebSocket integration, and finally the UI components.

\`\`\`typescript
interface Notification {
  id: string;
  userId: string;
  type: 'mention' | 'assignment' | 'update' | 'system';
  title: string;
  body: string;
  read: boolean;
  createdAt: Date;
}
\`\`\`

Let me begin with reading the existing database schema to understand the conventions used in this project.`;

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

export const Streaming: Story = {
  render: () => (
    <Reasoning isStreaming defaultOpen>
      <ReasoningTrigger />
      <ReasoningContent>{SHORT_REASONING}</ReasoningContent>
    </Reasoning>
  ),
};

export const CompletedWithDuration: Story = {
  name: 'Completed (12s)',
  render: () => (
    <Reasoning isStreaming={false} duration={12} defaultOpen={false}>
      <ReasoningTrigger />
      <ReasoningContent>{MEDIUM_REASONING}</ReasoningContent>
    </Reasoning>
  ),
};

export const CompletedNoDuration: Story = {
  name: 'Completed (no duration)',
  render: () => (
    <Reasoning isStreaming={false} defaultOpen={false}>
      <ReasoningTrigger />
      <ReasoningContent>{SHORT_REASONING}</ReasoningContent>
    </Reasoning>
  ),
};

export const OpenByDefault: Story = {
  name: 'Open by Default',
  render: () => (
    <Reasoning isStreaming={false} duration={8} open defaultOpen>
      <ReasoningTrigger />
      <ReasoningContent>{MEDIUM_REASONING}</ReasoningContent>
    </Reasoning>
  ),
};

export const ClosedByDefault: Story = {
  name: 'Closed by Default',
  render: () => (
    <Reasoning isStreaming={false} duration={5} defaultOpen={false}>
      <ReasoningTrigger />
      <ReasoningContent>{SHORT_REASONING}</ReasoningContent>
    </Reasoning>
  ),
};

export const LongReasoning: Story = {
  name: 'Long Reasoning (with code)',
  render: () => (
    <Reasoning isStreaming={false} duration={45} open defaultOpen>
      <ReasoningTrigger />
      <ReasoningContent>{LONG_REASONING}</ReasoningContent>
    </Reasoning>
  ),
};

export const StreamingZeroDuration: Story = {
  name: 'Streaming (duration=0)',
  render: () => (
    <Reasoning isStreaming duration={0} defaultOpen>
      <ReasoningTrigger />
      <ReasoningContent>{SHORT_REASONING}</ReasoningContent>
    </Reasoning>
  ),
};

export const CustomThinkingMessage: Story = {
  render: () => (
    <Reasoning isStreaming={false} duration={3} defaultOpen={false}>
      <ReasoningTrigger
        getThinkingMessage={(isStreaming, duration) => {
          if (isStreaming) return <span>🧠 Thinking hard...</span>;
          if (duration) return <span>💡 Thought for {duration}s</span>;
          return <span>💡 Done thinking</span>;
        }}
      />
      <ReasoningContent>{SHORT_REASONING}</ReasoningContent>
    </Reasoning>
  ),
};

export const MultipleReasoningBlocks: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Reasoning isStreaming={false} duration={3} defaultOpen={false}>
        <ReasoningTrigger />
        <ReasoningContent>
          First, let me understand what the user is asking for. They want to add
          input validation to the form component.
        </ReasoningContent>
      </Reasoning>
      <Reasoning isStreaming={false} duration={8} defaultOpen={false}>
        <ReasoningTrigger />
        <ReasoningContent>{MEDIUM_REASONING}</ReasoningContent>
      </Reasoning>
      <Reasoning isStreaming defaultOpen>
        <ReasoningTrigger />
        <ReasoningContent>
          Now I need to implement the changes based on my analysis...
        </ReasoningContent>
      </Reasoning>
    </div>
  ),
};
