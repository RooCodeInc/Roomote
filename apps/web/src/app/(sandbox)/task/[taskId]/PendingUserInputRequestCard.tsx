'use client';

import { useEffect, useRef } from 'react';
import type {
  AcpRequestUserInputAnswers,
  AcpRequestUserInputQuestion,
} from '@roomote/types';

import type { PendingTaskUserInputRequest } from './hooks';

import {
  ArrowLeft,
  Button,
  Input,
  Lock,
  MessageCircleQuestionMark,
  X,
} from '@/components/system';
import { cn } from '@/lib/utils';

interface DraftAnswer {
  selectedValue: string | null;
  otherText: string;
}

export type RequestDraft = Record<string, DraftAnswer>;

export const OTHER_VALUE = '__other__';

function getInitialQuestionSelection(
  question: AcpRequestUserInputQuestion,
): string | null {
  const options = question.options ?? [];

  if (options.length === 0 && question.isOther) {
    return OTHER_VALUE;
  }

  return null;
}

export function ensureQuestionDraft(
  requestDraft: RequestDraft | undefined,
  question: AcpRequestUserInputQuestion,
): DraftAnswer {
  return (
    requestDraft?.[question.id] ?? {
      selectedValue: getInitialQuestionSelection(question),
      otherText: '',
    }
  );
}

export function buildAnswersForRequest(
  request: PendingTaskUserInputRequest,
  requestDraft: RequestDraft | undefined,
): AcpRequestUserInputAnswers {
  return request.questions.reduce<AcpRequestUserInputAnswers>(
    (answers, question) => {
      const draft = ensureQuestionDraft(requestDraft, question);
      const hasOptions = (question.options?.length ?? 0) > 0;

      if (!hasOptions || draft.selectedValue === OTHER_VALUE) {
        const value = draft.otherText.trim();

        if (value.length > 0) {
          answers[question.id] = { answers: [value] };
        }

        return answers;
      }

      if (draft.selectedValue) {
        answers[question.id] = { answers: [draft.selectedValue] };
      }

      return answers;
    },
    {},
  );
}

interface PendingUserInputRequestCardProps {
  request: PendingTaskUserInputRequest;
  requestDraft?: RequestDraft;
  isSubmitting: boolean;
  currentQuestionIndex: number;
  isConnected: boolean;
  onActivateOther: (question: AcpRequestUserInputQuestion) => void;
  onOtherTextChange: (
    question: AcpRequestUserInputQuestion,
    value: string,
  ) => void;
  onSubmitOther: (question: AcpRequestUserInputQuestion) => void;
  onSelectOption: (
    question: AcpRequestUserInputQuestion,
    value: string,
  ) => void;
  onBack: () => void;
  onDismiss: () => void;
}

function RequestOption({
  value,
  title,
  description,
  selected,
  disabled,
  buttonRef,
  onMoveFocus,
  onSelect,
}: {
  value: string;
  title: string;
  description?: string;
  selected: boolean;
  disabled: boolean;
  buttonRef?: (node: HTMLButtonElement | null) => void;
  onMoveFocus: (direction: 'next' | 'previous') => void;
  onSelect: (value: string) => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      className={cn(
        'flex max-w-full self-start items-start rounded-xl border border-border/50 bg-card px-3 py-1.5 text-left text-xs leading-5 text-foreground outline-none transition-colors focus-visible:border-accent-foreground focus-visible:ring-1 focus-visible:ring-accent-foreground',
        !disabled && 'cursor-pointer',
        !disabled && !selected && 'hover:border-accent-foreground',
        disabled && 'cursor-default opacity-50',
        selected &&
          'border-accent-foreground/60 shadow-sm shadow-accent-foreground/10 text-accent-foreground',
      )}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          onMoveFocus('next');
        }

        if (event.key === 'ArrowUp') {
          event.preventDefault();
          onMoveFocus('previous');
        }
      }}
      onClick={() => onSelect(value)}
    >
      <span className="min-w-0 break-words">
        <span className="font-semibold">{title}</span>
        {description ? (
          <span className="text-muted-foreground"> {description}</span>
        ) : null}
      </span>
    </button>
  );
}

export function PendingUserInputRequestCard({
  request,
  requestDraft,
  isSubmitting,
  currentQuestionIndex,
  isConnected,
  onActivateOther,
  onOtherTextChange,
  onSubmitOther,
  onSelectOption,
  onBack,
  onDismiss,
}: PendingUserInputRequestCardProps) {
  const question = request.questions[currentQuestionIndex];
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const otherInputRef = useRef<HTMLInputElement | null>(null);
  const draft = question
    ? ensureQuestionDraft(requestDraft, question)
    : { selectedValue: null, otherText: '' };
  const options = question?.options ?? [];
  const showBackButton =
    request.questions.length > 1 && currentQuestionIndex > 0;
  const showOtherChip = Boolean(question?.isOther && options.length > 0);
  const isFreeTextOnly = Boolean(question?.isOther && options.length === 0);
  const selectedOther = draft.selectedValue === OTHER_VALUE;
  const showOtherInput = isFreeTextOnly || (showOtherChip && selectedOther);
  const focusableOptionCount = options.length + (showOtherChip ? 1 : 0);
  const isLastQuestion = currentQuestionIndex === request.questions.length - 1;
  const otherSubmitLabel = isLastQuestion ? 'Submit' : 'Next';
  const canSubmitOther =
    draft.otherText.trim().length > 0 && !isSubmitting && isConnected;

  useEffect(() => {
    optionRefs.current = optionRefs.current.slice(0, focusableOptionCount);

    if (focusableOptionCount === 0 || isSubmitting || !isConnected) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      optionRefs.current[0]?.focus();
    });

    return () => cancelAnimationFrame(frame);
  }, [
    currentQuestionIndex,
    focusableOptionCount,
    isConnected,
    isSubmitting,
    request.requestId,
  ]);

  useEffect(() => {
    if (!selectedOther || isSubmitting || !isConnected) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      otherInputRef.current?.focus();
    });

    return () => cancelAnimationFrame(frame);
  }, [currentQuestionIndex, isConnected, isSubmitting, selectedOther]);

  const moveOptionFocus = (
    currentIndex: number,
    direction: 'next' | 'previous',
  ) => {
    if (focusableOptionCount === 0) {
      return;
    }

    const nextIndex =
      direction === 'next'
        ? (currentIndex + 1) % focusableOptionCount
        : (currentIndex - 1 + focusableOptionCount) % focusableOptionCount;

    optionRefs.current[nextIndex]?.focus();
  };

  if (!question) {
    return null;
  }

  return (
    <div className="w-full px-4 pt-3 pb-3.5 text-foreground">
      <div className="space-y-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-1.5 text-xs leading-5 text-foreground">
            {showBackButton ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Go back"
                title="Go back"
                disabled={isSubmitting}
                onClick={onBack}
              >
                <ArrowLeft className="size-4" />
              </Button>
            ) : (
              <span className="flex size-6 shrink-0 items-center justify-center">
                <MessageCircleQuestionMark className="size-4 text-muted-foreground" />
              </span>
            )}
            <p className="mt-0.5 max-w-3xl font-medium text-foreground">
              {question.question}
              {request.questions.length > 1 ? (
                <span className="ml-1 font-normal text-muted-foreground">
                  ({currentQuestionIndex + 1} of {request.questions.length})
                </span>
              ) : null}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Dismiss input request"
            title="Dismiss input request"
            disabled={isSubmitting || !isConnected}
            onClick={onDismiss}
          >
            <X className="size-4" />
          </Button>
        </div>

        {options.length > 0 ? (
          <div className="flex w-full min-w-0 flex-col gap-1.5">
            {options.map((option, index) => {
              return (
                <RequestOption
                  key={option.label}
                  value={option.label}
                  title={option.label}
                  description={option.description}
                  selected={draft.selectedValue === option.label}
                  disabled={isSubmitting || !isConnected}
                  buttonRef={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  onMoveFocus={(direction) => moveOptionFocus(index, direction)}
                  onSelect={(value) => onSelectOption(question, value)}
                />
              );
            })}
            {showOtherChip ? (
              <RequestOption
                value={OTHER_VALUE}
                title="Other"
                selected={selectedOther}
                disabled={isSubmitting || !isConnected}
                buttonRef={(node) => {
                  optionRefs.current[options.length] = node;
                }}
                onMoveFocus={(direction) =>
                  moveOptionFocus(options.length, direction)
                }
                onSelect={() => onActivateOther(question)}
              />
            ) : null}
          </div>
        ) : null}

        {showOtherInput ? (
          <div className="flex w-full min-w-0 items-center gap-2">
            <Input
              ref={otherInputRef}
              id={`${request.requestId}:${question.id}:input`}
              secret={question.isSecret}
              value={draft.otherText}
              onFocus={() => onActivateOther(question)}
              onChange={(event) =>
                onOtherTextChange(question, event.target.value)
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onSubmitOther(question);
                }
              }}
              placeholder="Enter your response"
              aria-label="Custom response"
              disabled={isSubmitting || !isConnected}
              className="h-9 min-w-0 flex-1"
            />
            <Button
              type="button"
              size="sm"
              disabled={!canSubmitOther}
              onClick={() => onSubmitOther(question)}
            >
              {otherSubmitLabel}
            </Button>
          </div>
        ) : null}

        {question.isSecret ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Lock className="size-3.5" />
            <span>This answer is treated as sensitive input.</span>
          </p>
        ) : null}

        {!isConnected ? (
          <p className="text-xs text-muted-foreground">
            This task is not connected right now, so answers cannot be submitted
            from this view.
          </p>
        ) : null}
      </div>
    </div>
  );
}
