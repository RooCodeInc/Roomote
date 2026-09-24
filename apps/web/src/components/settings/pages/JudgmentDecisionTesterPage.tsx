'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';

import { SettingsShell } from '@/components/settings/SettingsShell';
import {
  Badge,
  Button,
  Checkbox,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
} from '@/components/system';
import { useTRPC } from '@/trpc/client';

type Target = 'configured' | 'roomote';
type Question = {
  type: 'noul' | 'choice' | 'score';
  instructions: string;
  criteria?:
    | Record<string, string>
    | string[]
    | { true: string; false: string };
};
type Answer = {
  type?: string;
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
};
type TestResult =
  | {
      ok: true;
      provider: string;
      model: string;
      answers: Record<string, Answer>;
      invalid: string[];
      latencyMs: number;
    }
  | { ok: false; provider: string | null; error: string; latencyMs?: number };

const ERROR_MESSAGES: Record<string, string> = {
  timeout: 'Timed out.',
  request_failed: 'The request failed.',
  http_401: 'The model rejected the credentials (HTTP 401).',
  http_403: 'The model refused the request (HTTP 403).',
  http_429: 'The model is rate limiting (HTTP 429).',
};

function describeError(error: string): string {
  return (
    ERROR_MESSAGES[error] ??
    (error.startsWith('http_')
      ? `The model returned HTTP ${error.slice(5)}.`
      : error)
  );
}

/** Options in display order, with the probability each answer gives them. */
function optionsFor(
  question: Question,
  answer: Answer | undefined,
): Array<{ key: string; label: string; probability?: number }> {
  if (question.type === 'noul') {
    const yes = answer?.noul;
    return [
      { key: 'yes', label: 'yes', probability: yes },
      {
        key: 'no',
        label: 'no',
        probability: yes === undefined ? undefined : 1 - yes,
      },
    ];
  }
  if (question.type === 'choice') {
    const keys = Array.isArray(question.criteria)
      ? question.criteria
      : Object.keys(question.criteria ?? {});
    return keys.map((key) => ({
      key,
      label: key,
      probability: answer?.probabilities?.[key],
    }));
  }
  const levels = Array.isArray(question.criteria) ? question.criteria : [];
  return levels.map((level, index) => ({
    key: String(index),
    label: `${index} · ${level}`,
    probability:
      answer?.probabilities?.[String(index)] ??
      (answer?.score !== undefined && Math.round(answer.score) === index
        ? answer.confidence
        : undefined),
  }));
}

function pickOf(
  question: Question,
  answer: Answer | undefined,
): string | undefined {
  if (!answer) return undefined;
  if (question.type === 'noul')
    return answer.noul === undefined
      ? undefined
      : answer.noul >= 0.5
        ? 'yes'
        : 'no';
  if (question.type === 'choice') return answer.choice;
  return answer.score === undefined
    ? undefined
    : String(Math.round(answer.score));
}

function ProbabilityBar({
  value,
  secondary,
}: {
  value?: number;
  secondary?: boolean;
}) {
  return (
    <div className="relative h-4 overflow-hidden rounded-sm bg-muted">
      <div
        className={
          secondary
            ? 'absolute inset-y-0 left-0 bg-amber-500/80'
            : 'absolute inset-y-0 left-0 bg-primary/80'
        }
        style={{ width: `${Math.round((value ?? 0) * 100)}%` }}
      />
      <span className="absolute inset-y-0 right-1 text-[11px] leading-4 tabular-nums text-foreground">
        {value === undefined ? '–' : `${Math.round(value * 100)}%`}
      </span>
    </div>
  );
}

export function JudgmentDecisionTesterPage() {
  const trpc = useTRPC();
  const catalogQuery = useQuery(
    trpc.taskModels.judgment.decisionCatalog.queryOptions(),
  );
  const test = useMutation(
    trpc.taskModels.judgment.testDecision.mutationOptions(),
  );
  const catalog = catalogQuery.data;

  const [decisionId, setDecisionId] = useState<string>();
  const [stateText, setStateText] = useState('');
  const [questionsText, setQuestionsText] = useState('');
  const [targets, setTargets] = useState<Target[]>(['configured']);
  const [inputError, setInputError] = useState<string>();
  const [asked, setAsked] = useState<Record<string, Question>>({});

  const decision = useMemo(
    () =>
      catalog?.decisions.find((d) => d.id === decisionId) ??
      catalog?.decisions[0],
    [catalog, decisionId],
  );

  useEffect(() => {
    if (!decision) return;
    setStateText(JSON.stringify(decision.sampleState, null, 2));
    setQuestionsText(JSON.stringify(decision.questions, null, 2));
    test.reset();
    setInputError(undefined);
    // Reset only when the decision changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decision?.id]);

  const availableTargets = (
    Object.keys(catalog?.targets ?? {}) as Target[]
  ).filter((target) => catalog?.targets[target].available);

  const run = () => {
    let state: unknown;
    let questions: Record<string, Question>;
    try {
      state = JSON.parse(stateText);
    } catch (error) {
      setInputError(`State is not valid JSON: ${(error as Error).message}`);
      return;
    }
    try {
      questions = JSON.parse(questionsText);
    } catch (error) {
      setInputError(
        `Questions are not valid JSON: ${(error as Error).message}`,
      );
      return;
    }
    const chosen = targets.filter((target) =>
      availableTargets.includes(target),
    );
    if (!chosen.length) {
      setInputError('Choose a model to ask.');
      return;
    }
    setInputError(undefined);
    setAsked(questions);
    test.mutate(
      {
        state: state as Record<string, unknown>,
        questions: questions as never,
        targets: chosen,
      },
      { onError: (error) => setInputError(error.message) },
    );
  };

  const results = (test.data ?? {}) as Partial<Record<Target, TestResult>>;
  const answeredTargets = (Object.keys(results) as Target[]).filter(
    (t) => results[t],
  );

  return (
    <SettingsShell
      pageId="models"
      adminOnly={true}
      titleOverride="Test decisions"
      boundedContentOnDesktop
    >
      <div className="space-y-4 md:min-h-0 md:flex-1 md:overflow-y-auto">
        <p className="text-sm text-muted-foreground">
          Ask the judgment model one of Roomote&apos;s decisions by hand. The
          questions are the ones Roomote sends; edit the sample state (or the
          questions) and ask. Test decisions go to the configured model but are
          not recorded for comparison or training.
        </p>

        {catalogQuery.isPending ? (
          <Skeleton className="h-64 w-full" />
        ) : catalog ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="min-w-0 space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="judgment-decision">Decision</Label>
                <Select value={decision?.id} onValueChange={setDecisionId}>
                  <SelectTrigger id="judgment-decision" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {catalog.decisions.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {decision && (
                  <p className="text-xs text-muted-foreground">
                    {decision.description}
                  </p>
                )}
                {decision?.note && (
                  <p className="text-xs text-muted-foreground">
                    {decision.note}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="judgment-state">State (JSON)</Label>
                <Textarea
                  id="judgment-state"
                  value={stateText}
                  onChange={(event) => setStateText(event.target.value)}
                  spellCheck={false}
                  className="min-h-56 font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="judgment-questions">Questions (JSON)</Label>
                <Textarea
                  id="judgment-questions"
                  value={questionsText}
                  onChange={(event) => setQuestionsText(event.target.value)}
                  spellCheck={false}
                  className="min-h-40 font-mono text-xs"
                />
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {(['configured', 'roomote'] as Target[]).map((target) => {
                  const info = catalog.targets[target];
                  if (target === 'roomote' && !info.available) return null;
                  return (
                    <label
                      key={target}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Checkbox
                        checked={targets.includes(target) && info.available}
                        disabled={!info.available}
                        onCheckedChange={(checked) =>
                          setTargets((current) =>
                            checked
                              ? [...new Set([...current, target])]
                              : current.filter((t) => t !== target),
                          )
                        }
                      />
                      {info.label}
                    </label>
                  );
                })}
                <Button
                  onClick={run}
                  disabled={test.isPending || availableTargets.length === 0}
                >
                  {test.isPending ? 'Asking…' : 'Ask'}
                </Button>
              </div>
              {availableTargets.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No judgment model is configured. Choose one under Judgment
                  model on the Models page.
                </p>
              )}
              {inputError && (
                <p className="text-sm text-destructive">{inputError}</p>
              )}
            </div>

            <div className="min-w-0 space-y-3">
              {answeredTargets.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Answers appear here.
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    {answeredTargets.map((target, index) => {
                      const result = results[target]!;
                      return (
                        <Badge
                          key={target}
                          variant={result.ok ? 'secondary' : 'destructive'}
                        >
                          <span
                            className={
                              index === 1 ? 'text-amber-600' : undefined
                            }
                          >
                            {catalog.targets[target].label}
                          </span>
                          {result.ok
                            ? ` · ${result.latencyMs} ms${result.invalid.length ? ` · ${result.invalid.length} invalid` : ''}`
                            : ` · ${describeError(result.error)}`}
                        </Badge>
                      );
                    })}
                  </div>
                  {Object.entries(asked).map(([questionId, question]) => (
                    <div
                      key={questionId}
                      className="space-y-1.5 border-t pt-3 first:border-t-0 first:pt-0"
                    >
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-mono text-sm font-semibold">
                          {questionId}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {question.type}
                        </span>
                        {answeredTargets.map((target) => {
                          const result = results[target];
                          const pick = result?.ok
                            ? pickOf(question, result.answers[questionId])
                            : undefined;
                          const invalid =
                            result?.ok && result.invalid.includes(questionId);
                          return pick !== undefined || invalid ? (
                            <span key={target} className="text-xs">
                              {catalog.targets[target].label}:{' '}
                              <strong>
                                {invalid ? 'invalid answer' : pick}
                              </strong>
                            </span>
                          ) : null;
                        })}
                      </div>
                      <div
                        className="grid items-center gap-x-3 gap-y-1 text-xs"
                        style={{
                          gridTemplateColumns: `minmax(5rem, max-content) repeat(${answeredTargets.length}, minmax(0, 1fr))`,
                        }}
                      >
                        {optionsFor(question, undefined).map((option) => (
                          <div key={option.key} className="contents">
                            <span
                              className="truncate font-mono"
                              title={option.label}
                            >
                              {option.label}
                            </span>
                            {answeredTargets.map((target, index) => {
                              const result = results[target];
                              const answer = result?.ok
                                ? result.answers[questionId]
                                : undefined;
                              const value = optionsFor(question, answer).find(
                                (o) => o.key === option.key,
                              )?.probability;
                              return (
                                <ProbabilityBar
                                  key={target}
                                  value={value}
                                  secondary={index === 1}
                                />
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-destructive">
            Could not load the decisions.
          </p>
        )}
      </div>
    </SettingsShell>
  );
}
