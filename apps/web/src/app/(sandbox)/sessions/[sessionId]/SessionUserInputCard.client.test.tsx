import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockMutate } = vi.hoisted(() => ({ mockMutate: vi.fn() }));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    setup: {
      submitSessionUserInput: {
        mutationOptions: () => ({ mutationFn: vi.fn() }),
      },
    },
    fastSessions: {
      submitUserInput: {
        mutationOptions: () => ({ mutationFn: vi.fn() }),
      },
    },
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({
    mutate: (...args: unknown[]) => mockMutate(...args),
    isPending: false,
    onSuccess: undefined,
    onError: undefined,
  }),
}));

import {
  findPendingSessionInputRequest,
  SessionUserInputCard,
} from './SessionUserInputCard';
import { SetupStarterTasksCard } from './setup/SetupStarterTasksCard';

const multiRequest = {
  requestId: 'rui:test-multi',
  questions: [
    {
      id: 'starters',
      header: 'Starter tasks',
      question: 'Which starter tasks should run first?',
      isOther: false,
      isSecret: false,
      multiple: true,
      options: [
        { label: 'Speed up CI', description: 'CI improvements' },
        { label: 'Security scan', description: 'Scan for vulnerabilities' },
        { label: 'Fix test flakes', description: 'Stabilize tests' },
      ],
    },
  ],
};

describe('SessionUserInputCard', () => {
  beforeEach(() => {
    mockMutate.mockClear();
  });

  it('requires the minimum number of selections before submitting', () => {
    render(<SessionUserInputCard sessionId="s" request={multiRequest} />);

    const submit = screen.getByRole('button', { name: 'Submit' });
    expect(submit).toBeDisabled();

    const checkbox = screen.getByLabelText('Security scan');
    fireEvent.click(checkbox);
    expect(screen.getByLabelText('Security scan')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled();
  });

  it('submits checked selections as structured answers', () => {
    render(
      <SessionUserInputCard sessionId="session-1" request={multiRequest} />,
    );

    fireEvent.click(screen.getByLabelText('Speed up CI'));
    fireEvent.click(screen.getByLabelText('Fix test flakes'));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        requestId: 'rui:test-multi',
        answers: {
          starters: { answers: ['Speed up CI', 'Fix test flakes'] },
        },
      }),
    );
  });

  it('uses accessible radio semantics for single-choice options', () => {
    render(
      <SessionUserInputCard
        sessionId="s"
        request={{
          requestId: 'rui:test-single',
          questions: [
            {
              id: 'mode',
              header: 'Mode',
              question: 'Pick one mode.',
              isOther: false,
              isSecret: false,
              options: [
                { label: 'Fast', description: 'Fast mode' },
                { label: 'Deep', description: 'Deep mode' },
              ],
            },
          ],
        }}
      />,
    );

    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Deep/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        answers: { mode: { answers: ['Deep'] } },
      }),
    );
  });

  it('requires and submits a custom Other answer', () => {
    render(
      <SessionUserInputCard
        sessionId="s"
        request={{
          requestId: 'rui:test-other',
          questions: [
            {
              id: 'mode',
              header: 'Mode',
              question: 'Pick one mode.',
              isOther: true,
              isSecret: false,
              options: [{ label: 'Fast', description: 'Fast mode' }],
            },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Other' }));
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Pick one mode. other answer'), {
      target: { value: 'Balanced' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        answers: { mode: { answers: ['Balanced'] } },
      }),
    );
  });

  it('uses the shared setup action-card framing for first-task choices', () => {
    render(
      <SetupStarterTasksCard
        sessionId="s"
        request={{ ...multiRequest, preset: 'setup_starter_tasks' }}
      />,
    );

    expect(screen.getByText('First task ideas')).toBeInTheDocument();
    expect(
      screen.getByText(
        'I found a few things I could do right away. Click the button to get it going:',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Starter tasks: Which starter tasks should run first?'),
    ).toHaveClass('sr-only');
    expect(screen.queryByText('Select at least one option.')).toBeNull();
    expect(screen.getByRole('button', { name: "Let's go" })).toBeEnabled();
    for (const option of multiRequest.questions[0]!.options) {
      expect(screen.getByLabelText(option.label)).toHaveAttribute(
        'aria-checked',
        'true',
      );
    }
  });
});

describe('findPendingSessionInputRequest', () => {
  it('returns the latest unanswered request and null once resolved', () => {
    const request = {
      eventType: 'roomote_runtime.request_user_input',
      payload: {
        requestId: 'rui:a',
        status: 'pending',
        sessionId: 's',
        turnId: 't',
        callId: 'c',
        preset: 'setup_starter_tasks',
        questions: multiRequest.questions,
      },
      ts: 1,
    };
    expect(findPendingSessionInputRequest([request])).toMatchObject({
      requestId: 'rui:a',
      preset: 'setup_starter_tasks',
    });

    const response = {
      eventType: 'roomote_runtime.request_user_input_response',
      payload: { requestId: 'rui:a', answers: {}, resolution: 'submitted' },
      ts: 2,
    };
    expect(findPendingSessionInputRequest([request, response])).toBeNull();
  });
});
