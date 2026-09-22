import { fireEvent, render, screen } from '@testing-library/react';

import type { PendingTaskUserInputRequest } from './hooks';
import {
  OTHER_VALUE,
  PendingUserInputRequestCard,
  type RequestDraft,
} from './PendingUserInputRequestCard';

const request: PendingTaskUserInputRequest = {
  requestId: 'rui:test',
  sessionId: 'session-test',
  turnId: 'turn-test',
  callId: 'call-test',
  status: 'pending',
  ts: 0,
  questions: [
    {
      id: 'color',
      header: 'COLOR',
      question: "What's your favorite color?",
      isOther: true,
      isSecret: false,
      options: [
        {
          label: 'Blue (Recommended)',
          description: 'Good if blue is your favorite.',
        },
        {
          label: 'Black',
          description: 'Pick this if you prefer black.',
        },
      ],
    },
    {
      id: 'reason',
      header: 'REASON',
      question: 'Why that color?',
      isOther: true,
      isSecret: false,
    },
  ],
};

const requestDraft: RequestDraft = {
  color: {
    selectedValue: null,
    otherText: '',
  },
  reason: {
    selectedValue: null,
    otherText: '',
  },
};

describe('PendingUserInputRequestCard', () => {
  it('renders the question with inline progress and without the removed headers', () => {
    render(
      <PendingUserInputRequestCard
        request={request}
        requestDraft={requestDraft}
        isSubmitting={false}
        currentQuestionIndex={0}
        isConnected={true}
        onActivateOther={() => undefined}
        onOtherTextChange={() => undefined}
        onSubmitOther={() => undefined}
        onSelectOption={() => undefined}
        onBack={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    expect(screen.getByText("What's your favorite color?")).toBeTruthy();
    expect(screen.getByText('(1 of 2)')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Other/i })).toBeTruthy();
    expect(screen.queryByLabelText('Custom response')).toBeNull();
    expect(screen.queryByText('Input needed')).toBeNull();
    expect(screen.queryByText('COLOR')).toBeNull();
  });

  it('calls onSelectOption when a suggestion is clicked', () => {
    const onSelectOption = vi.fn();

    render(
      <PendingUserInputRequestCard
        request={request}
        requestDraft={requestDraft}
        isSubmitting={false}
        currentQuestionIndex={0}
        isConnected={true}
        onActivateOther={() => undefined}
        onOtherTextChange={() => undefined}
        onSubmitOther={() => undefined}
        onSelectOption={onSelectOption}
        onBack={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: /Blue \(Recommended\)/i }),
    );

    expect(onSelectOption).toHaveBeenCalledWith(
      request.questions[0],
      'Blue (Recommended)',
    );
  });

  it('calls onActivateOther when the custom option chip is clicked', () => {
    const onActivateOther = vi.fn();

    render(
      <PendingUserInputRequestCard
        request={request}
        requestDraft={requestDraft}
        isSubmitting={false}
        currentQuestionIndex={0}
        isConnected={true}
        onActivateOther={onActivateOther}
        onOtherTextChange={() => undefined}
        onSubmitOther={() => undefined}
        onSelectOption={() => undefined}
        onBack={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Other/i }));

    expect(onActivateOther).toHaveBeenCalledWith(request.questions[0]);
  });

  it('calls onActivateOther when the custom input receives focus', () => {
    const onActivateOther = vi.fn();
    const otherSelectedDraft: RequestDraft = {
      ...requestDraft,
      color: {
        selectedValue: OTHER_VALUE,
        otherText: '',
      },
    };

    render(
      <PendingUserInputRequestCard
        request={request}
        requestDraft={otherSelectedDraft}
        isSubmitting={false}
        currentQuestionIndex={0}
        isConnected={true}
        onActivateOther={onActivateOther}
        onOtherTextChange={() => undefined}
        onSubmitOther={() => undefined}
        onSelectOption={() => undefined}
        onBack={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    fireEvent.focus(screen.getByLabelText('Custom response'));

    expect(onActivateOther).toHaveBeenCalledWith(request.questions[0]);
  });

  it('shows an inline submit button for a selected custom response', () => {
    render(
      <PendingUserInputRequestCard
        request={request}
        requestDraft={{
          ...requestDraft,
          color: {
            selectedValue: OTHER_VALUE,
            otherText: 'Purple',
          },
        }}
        isSubmitting={false}
        currentQuestionIndex={0}
        isConnected={true}
        onActivateOther={() => undefined}
        onOtherTextChange={() => undefined}
        onSubmitOther={() => undefined}
        onSelectOption={() => undefined}
        onBack={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    expect(screen.getByLabelText('Custom response')).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: 'Next',
      }),
    ).toBeVisible();
  });

  it('submits the custom response when the inline button is clicked', () => {
    const onSubmitOther = vi.fn();

    render(
      <PendingUserInputRequestCard
        request={request}
        requestDraft={{
          ...requestDraft,
          color: {
            selectedValue: OTHER_VALUE,
            otherText: 'Purple',
          },
        }}
        isSubmitting={false}
        currentQuestionIndex={0}
        isConnected={true}
        onActivateOther={() => undefined}
        onOtherTextChange={() => undefined}
        onSubmitOther={onSubmitOther}
        onSelectOption={() => undefined}
        onBack={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(onSubmitOther).toHaveBeenCalledWith(request.questions[0]);
  });
});
