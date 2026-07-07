'use client';

import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import type { PendingTaskUserInputRequest } from './hooks';
import {
  OTHER_VALUE,
  ensureQuestionDraft,
  PendingUserInputRequestCard,
  type RequestDraft,
} from './PendingUserInputRequestCard';

const multiStepRequest: PendingTaskUserInputRequest = {
  requestId: 'rui:storybook:multi-step',
  sessionId: 'session-storybook',
  turnId: 'turn-storybook',
  callId: 'call-storybook',
  status: 'pending',
  ts: 0,
  questions: [
    {
      id: 'tui_lib',
      header: 'TUI LIB',
      question:
        'Which terminal UI implementation direction should I plan around?',
      isOther: true,
      isSecret: false,
      options: [
        {
          label: 'Ink + React (Recommended)',
          description:
            'Best TypeScript maintainability and component testability; strong fit for a paneled, stateful TUI.',
        },
        {
          label: 'neo-blessed',
          description:
            'More traditional terminal dashboard control, but more imperative and with an older ecosystem.',
        },
        {
          label: 'ANSI + readline',
          description:
            'Smallest dependency change, but weakest option for a dramatic redesign.',
        },
      ],
    },
    {
      id: 'timeline',
      header: 'TIMELINE',
      question: 'What delivery target should I optimize for?',
      isOther: true,
      isSecret: false,
      options: [
        {
          label: 'Short spike',
          description:
            'Focus on shape, risk, and implementation traps over polished interaction details.',
        },
        {
          label: 'Production-ready pass',
          description:
            'Plan for the final interaction model, polished states, and a migration path.',
        },
      ],
    },
    {
      id: 'notes',
      header: 'CONTEXT',
      question: 'Any additional constraints I should keep in mind?',
      isOther: true,
      isSecret: false,
    },
  ],
};

const customOnlyRequest: PendingTaskUserInputRequest = {
  requestId: 'rui:storybook:custom-only',
  sessionId: 'session-storybook',
  turnId: 'turn-storybook',
  callId: 'call-storybook',
  status: 'pending',
  ts: 0,
  questions: [
    {
      id: 'notes',
      header: 'CONTEXT',
      question: 'Any additional constraints I should keep in mind?',
      isOther: true,
      isSecret: false,
    },
  ],
};

function createInitialDraft(
  request: PendingTaskUserInputRequest,
  overrides: RequestDraft = {},
): RequestDraft {
  return Object.fromEntries(
    request.questions.map((question) => [
      question.id,
      overrides[question.id] ?? ensureQuestionDraft(undefined, question),
    ]),
  );
}

function StoryHarness({
  request,
  initialQuestionIndex = 0,
  initialDraft,
  isConnected = true,
}: {
  request: PendingTaskUserInputRequest;
  initialQuestionIndex?: number;
  initialDraft?: RequestDraft;
  isConnected?: boolean;
}) {
  const [currentQuestionIndex, setCurrentQuestionIndex] =
    useState(initialQuestionIndex);
  const [requestDraft, setRequestDraft] = useState<RequestDraft>(() =>
    createInitialDraft(request, initialDraft),
  );

  return (
    <PendingUserInputRequestCard
      request={request}
      requestDraft={requestDraft}
      isSubmitting={false}
      currentQuestionIndex={currentQuestionIndex}
      isConnected={isConnected}
      onActivateOther={(question) =>
        setRequestDraft((currentDraft) => ({
          ...currentDraft,
          [question.id]: {
            ...ensureQuestionDraft(currentDraft, question),
            selectedValue: OTHER_VALUE,
          },
        }))
      }
      onOtherTextChange={(question, value) =>
        setRequestDraft((currentDraft) => ({
          ...currentDraft,
          [question.id]: {
            ...ensureQuestionDraft(currentDraft, question),
            selectedValue: OTHER_VALUE,
            otherText: value,
          },
        }))
      }
      onSubmitOther={(question) => {
        setRequestDraft((currentDraft) => ({
          ...currentDraft,
          [question.id]: {
            ...ensureQuestionDraft(currentDraft, question),
            selectedValue: OTHER_VALUE,
          },
        }));
        setCurrentQuestionIndex((currentIndex) =>
          Math.min(currentIndex + 1, request.questions.length - 1),
        );
      }}
      onSelectOption={(question, value) => {
        setRequestDraft((currentDraft) => ({
          ...currentDraft,
          [question.id]: {
            ...ensureQuestionDraft(currentDraft, question),
            selectedValue: value,
          },
        }));

        setCurrentQuestionIndex((currentIndex) =>
          Math.min(currentIndex + 1, request.questions.length - 1),
        );
      }}
      onBack={() =>
        setCurrentQuestionIndex((currentIndex) => Math.max(currentIndex - 1, 0))
      }
      onDismiss={() => undefined}
    />
  );
}

const meta: Meta<typeof StoryHarness> = {
  title: 'Surfaces/Task Workspace/Lifecycle/PendingUserInputRequest',
  component: StoryHarness,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <div className="bg-background p-6 text-foreground">
        <div className="mx-auto max-w-4xl overflow-hidden rounded-xl border bg-card">
          <Story />
        </div>
      </div>
    ),
  ],
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const MultiStepPrompt: Story = {
  args: {
    request: multiStepRequest,
  },
};

export const WithCapturedAnswers: Story = {
  args: {
    request: multiStepRequest,
    initialQuestionIndex: 1,
    initialDraft: createInitialDraft(multiStepRequest, {
      tui_lib: {
        selectedValue: 'Ink + React (Recommended)',
        otherText: '',
      },
    }),
  },
};

export const InlineCustomResponse: Story = {
  args: {
    request: multiStepRequest,
    initialDraft: createInitialDraft(multiStepRequest, {
      tui_lib: {
        selectedValue: OTHER_VALUE,
        otherText: 'Use plain React without adding a terminal framework.',
      },
    }),
  },
};

export const CustomOnlyQuestion: Story = {
  args: {
    request: customOnlyRequest,
  },
};
