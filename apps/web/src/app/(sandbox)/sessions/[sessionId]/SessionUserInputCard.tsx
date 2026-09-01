'use client';

import { useMemo, useState } from 'react';
import {
  parseAcpRequestUserInputPayload,
  type AcpRequestUserInputPayload,
} from '@roomote/types';

import { cn } from '@/lib/utils';
import {
  Button,
  Checkbox,
  Input,
  ListChecks,
  RadioGroup,
  RadioGroupItem,
} from '@/components/system';
import { useTRPC } from '@/trpc/client';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SetupSessionActionCard } from '../../../(onboarding)/setup/SetupSessionActionCard';

/** Checkbox state per multi-select question; single questions keep a string. */
type SelectionState = Record<string, string[]>;
const OTHER_VALUE = '__other__';

/**
 * Session structured-input card. Renders a pending `request_user_input`
 * request: options questions use radio-style choices in single mode or
 * checkboxes with an explicit Submit action in multiple mode; free-text
 * questions render an input. Keyboard and screen-reader behavior follows the
 * native checkbox/radio primitives.
 */
export function SessionUserInputCard({
  sessionId,
  request,
  isResolved,
}: {
  sessionId: string;
  request: Pick<
    AcpRequestUserInputPayload,
    'requestId' | 'questions' | 'preset'
  >;
  isResolved?: boolean;
}) {
  const trpc = useTRPC();
  const [selections, setSelections] = useState<SelectionState>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});

  const submit = useMutation(
    (request.preset
      ? trpc.setup.submitSessionUserInput
      : trpc.fastSessions.submitUserInput
    ).mutationOptions({
      onSuccess: () => {
        setSelections({});
        setFreeText({});
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const validationError = useMemo(() => {
    for (const question of request.questions) {
      const options = question.options ?? [];
      const selected = selections[question.id] ?? [];
      const otherSelected = selected.includes(OTHER_VALUE);
      const otherText = (freeText[question.id] ?? '').trim();
      if (question.multiple) {
        const answerCount =
          selected.filter((value) => value !== OTHER_VALUE).length +
          (otherSelected && otherText ? 1 : 0);
        if (answerCount === 0) {
          return 'Select at least one option.';
        }
      } else if (options.length > 0) {
        if (selected.length === 0) return 'Select an option.';
        if (otherSelected && !otherText) return 'Enter another answer.';
      } else if (!otherText) {
        return 'Enter an answer.';
      }
    }
    return null;
  }, [freeText, request.questions, selections]);

  const canSubmit = !submit.isPending && !validationError;

  const buildAnswers = () => {
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of request.questions) {
      const options = question.options ?? [];
      if (question.multiple) {
        const selected = (selections[question.id] ?? []).flatMap((value) =>
          value === OTHER_VALUE
            ? [(freeText[question.id] ?? '').trim()].filter(Boolean)
            : [value],
        );
        if (selected.length > 0) {
          answers[question.id] = { answers: selected };
        }
        continue;
      }
      if (options.length > 0) {
        const selected = selections[question.id]?.[0];
        if (selected) {
          answers[question.id] = {
            answers: [
              selected === OTHER_VALUE
                ? (freeText[question.id] ?? '').trim()
                : selected,
            ].filter(Boolean),
          };
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

  const form = (
    <form
      className={cn(
        'space-y-4',
        request.preset
          ? ''
          : 'rounded-lg border border-border bg-card px-4 py-4',
      )}
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
        const isMultiple = question.multiple === true;
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
                  {question.isOther ? (
                    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-transparent px-2 py-1.5 text-sm hover:bg-muted/60">
                      <Checkbox
                        checked={selected.includes(OTHER_VALUE)}
                        disabled={submit.isPending}
                        onCheckedChange={(value) => {
                          setSelections((current) => {
                            const previous = current[question.id] ?? [];
                            return {
                              ...current,
                              [question.id]:
                                value === true
                                  ? [...previous, OTHER_VALUE]
                                  : previous.filter(
                                      (item) => item !== OTHER_VALUE,
                                    ),
                            };
                          });
                        }}
                        aria-label="Other"
                      />
                      <span className="font-medium">Other</span>
                    </label>
                  ) : null}
                  {selected.includes(OTHER_VALUE) ? (
                    <Input
                      type={question.isSecret ? 'password' : 'text'}
                      value={freeText[question.id] ?? ''}
                      disabled={submit.isPending}
                      aria-label={`${question.question} other answer`}
                      onChange={(event) =>
                        setFreeText((current) => ({
                          ...current,
                          [question.id]: event.target.value,
                        }))
                      }
                    />
                  ) : null}
                </div>
              ) : (
                <RadioGroup
                  className="space-y-1.5"
                  value={selected[0] ?? ''}
                  onValueChange={(value) =>
                    setSelections((current) => ({
                      ...current,
                      [question.id]: [value],
                    }))
                  }
                >
                  {options.map((option) => {
                    return (
                      <label
                        key={option.label}
                        className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-muted/60"
                      >
                        <RadioGroupItem value={option.label} />
                        <span>
                          <span className="font-medium">{option.label}</span>
                          <span className="block text-xs opacity-80">
                            {option.description}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                  {question.isOther ? (
                    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-muted/60">
                      <RadioGroupItem value={OTHER_VALUE} />
                      <span className="font-medium">Other</span>
                    </label>
                  ) : null}
                  {selected[0] === OTHER_VALUE ? (
                    <Input
                      type={question.isSecret ? 'password' : 'text'}
                      value={freeText[question.id] ?? ''}
                      disabled={submit.isPending}
                      aria-label={`${question.question} other answer`}
                      onChange={(event) =>
                        setFreeText((current) => ({
                          ...current,
                          [question.id]: event.target.value,
                        }))
                      }
                    />
                  ) : null}
                </RadioGroup>
              )
            ) : (
              <Input
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
        {!request.preset ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={submit.isPending}
            onClick={() =>
              submit.mutate({
                sessionId,
                requestId: request.requestId,
                answers: {},
                resolution: 'cancelled',
              })
            }
          >
            Cancel
          </Button>
        ) : null}
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

  if (request.preset === 'setup_starter_tasks') {
    return (
      <SetupSessionActionCard
        title="Choose your first task"
        icon={<ListChecks className="size-4" />}
        intro="Pick what you would like me to work on first. You can choose more than one."
      >
        {form}
      </SetupSessionActionCard>
    );
  }

  return form;
}

export function findPendingSessionInputRequest(
  messages: Array<{
    eventType: string;
    payload: Record<string, unknown> | null;
    ts: number;
  }>,
): Pick<
  AcpRequestUserInputPayload,
  'requestId' | 'questions' | 'preset'
> | null {
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
    ...(payload.preset ? { preset: payload.preset } : {}),
  };
}
