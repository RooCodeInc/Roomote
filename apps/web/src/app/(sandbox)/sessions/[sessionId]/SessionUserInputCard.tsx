'use client';

import { useMemo, useState } from 'react';
import {
  parseAcpRequestUserInputPayload,
  type AcpRequestUserInputQuestion,
} from '@roomote/types';

import { cn } from '@/lib/utils';
import { Button } from '@/components/system';
import { Checkbox } from '@/components/system/primitives/checkbox';
import { useTRPC } from '@/trpc/client';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

/** Checkbox state per multi-select question; single questions keep a string. */
type SelectionState = Record<string, string[]>;

/**
 * Session structured-input card. Renders a pending `request_user_input`
 * request: options questions use radio-style choices in single mode or
 * checkboxes with an explicit Submit action in multiple mode; free-text
 * questions render an input. Keyboard and screen-reader behavior follows the
 * native checkbox/button primitives.
 */
export function SessionUserInputCard({
  sessionId,
  request,
  isResolved,
}: {
  sessionId: string;
  request: { requestId: string; questions: AcpRequestUserInputQuestion[] };
  isResolved?: boolean;
}) {
  const trpc = useTRPC();
  const [selections, setSelections] = useState<SelectionState>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});

  const submit = useMutation(
    trpc.fastSessions.submitUserInput.mutationOptions({
      onSuccess: () => {
        setSelections({});
        setFreeText({});
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const validationError = useMemo(() => {
    for (const question of request.questions) {
      if (question.selectionMode === 'multiple') {
        const min = question.minSelections ?? 1;
        const selected = selections[question.id] ?? [];
        if (selected.length < min) {
          return `Select at least ${min} option${min === 1 ? '' : 's'}.`;
        }
      }
    }
    return null;
  }, [request.questions, selections]);

  const canSubmit = !submit.isPending && !validationError;

  const buildAnswers = () => {
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of request.questions) {
      const options = question.options ?? [];
      if (question.selectionMode === 'multiple') {
        const selected = selections[question.id] ?? [];
        if (selected.length > 0) {
          answers[question.id] = { answers: selected };
        }
        continue;
      }
      if (options.length > 0) {
        const selected = selections[question.id]?.[0];
        if (selected) {
          answers[question.id] = { answers: [selected] };
        }
        continue;
      }
      const text = (freeText[question.id] ?? '').trim();
      if (text) {
        answers[question.id] = { answers: [text] };
      }
    }
    return answers;
  };

  if (isResolved) {
    return (
      <div className="rounded-lg border border-border/70 bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
        Response recorded.
      </div>
    );
  }

  return (
    <form
      className="space-y-4 rounded-lg border border-border bg-card px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        submit.mutate({
          sessionId,
          requestId: request.requestId,
          answers: buildAnswers(),
        });
      }}
    >
      {request.questions.map((question) => {
        const options = question.options ?? [];
        const isMultiple = question.selectionMode === 'multiple';
        const selected = selections[question.id] ?? [];
        return (
          <fieldset key={question.id} className="space-y-2">
            <legend className="text-sm font-medium">
              {question.header ? `${question.header}: ` : ''}
              {question.question}
            </legend>
            {options.length > 0 ? (
              isMultiple ? (
                <div
                  className="space-y-1.5"
                  role="group"
                  aria-label={question.question}
                >
                  {options.map((option) => {
                    const checked = selected.includes(option.label);
                    return (
                      <label
                        key={option.label}
                        className="flex cursor-pointer items-start gap-2 rounded-md border border-transparent px-2 py-1.5 text-sm hover:bg-muted/60"
                      >
                        <Checkbox
                          checked={checked}
                          disabled={submit.isPending}
                          onCheckedChange={(value) => {
                            setSelections((current) => {
                              const previous = current[question.id] ?? [];
                              return {
                                ...current,
                                [question.id]:
                                  value === true
                                    ? [...previous, option.label]
                                    : previous.filter(
                                        (item) => item !== option.label,
                                      ),
                              };
                            });
                          }}
                          aria-label={option.label}
                        />
                        <span>
                          <span className="font-medium">{option.label}</span>
                          <span
                            className={cn(
                              'block text-xs text-muted-foreground',
                            )}
                          >
                            {option.description}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div
                  className="space-y-1.5"
                  role="radiogroup"
                  aria-label={question.question}
                >
                  {options.map((option) => {
                    const isSelected = selected[0] === option.label;
                    return (
                      <Button
                        key={option.label}
                        type="button"
                        variant={isSelected ? 'default' : 'outline'}
                        className="w-full justify-start text-left"
                        aria-pressed={isSelected}
                        onClick={() =>
                          setSelections((current) => ({
                            ...current,
                            [question.id]: [option.label],
                          }))
                        }
                      >
                        <span>
                          <span className="font-medium">{option.label}</span>
                          <span className="block text-xs opacity-80">
                            {option.description}
                          </span>
                        </span>
                      </Button>
                    );
                  })}
                </div>
              )
            ) : (
              <input
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                type={question.isSecret ? 'password' : 'text'}
                value={freeText[question.id] ?? ''}
                disabled={submit.isPending}
                aria-label={question.question}
                onChange={(event) =>
                  setFreeText((current) => ({
                    ...current,
                    [question.id]: event.target.value,
                  }))
                }
              />
            )}
          </fieldset>
        );
      })}
      {validationError ? (
        <p className="text-xs text-destructive">{validationError}</p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={!canSubmit}
          aria-disabled={!canSubmit}
        >
          {submit.isPending ? 'Submitting…' : 'Submit'}
        </Button>
      </div>
    </form>
  );
}

export function findPendingSessionInputRequest(
  messages: Array<{
    eventType: string;
    payload: Record<string, unknown> | null;
    ts: number;
  }>,
): { requestId: string; questions: AcpRequestUserInputQuestion[] } | null {
  const requests = messages
    .filter(
      (message) =>
        message.eventType === 'roomote_runtime.request_user_input' &&
        parseAcpRequestUserInputPayload(message.payload),
    )
    .sort((a, b) => a.ts - b.ts);
  const latest = requests.at(-1);
  if (!latest) return null;
  const payload = parseAcpRequestUserInputPayload(latest.payload);
  if (!payload) return null;
  const resolved = messages.some(
    (message) =>
      message.eventType === 'roomote_runtime.request_user_input_response' &&
      message.payload?.requestId === payload.requestId,
  );
  if (resolved) return null;
  return {
    requestId: payload.requestId,
    questions: payload.questions,
  };
}
