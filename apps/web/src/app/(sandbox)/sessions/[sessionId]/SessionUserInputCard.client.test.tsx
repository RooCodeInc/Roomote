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

  it('keeps single-choice options as pressable choices without checkboxes', () => {
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
    fireEvent.click(screen.getByRole('button', { name: /Deep/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        answers: { mode: { answers: ['Deep'] } },
      }),
    );
  });

  it('uses the shared setup action-card framing for first-task choices', () => {
    render(
      <SessionUserInputCard
        sessionId="s"
        request={{ ...multiRequest, preset: 'setup_starter_tasks' }}
      />,
    );

    expect(screen.getByText('Choose your first task')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Pick what you would like me to work on first. You can choose more than one.',
      ),
    ).toBeInTheDocument();
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
